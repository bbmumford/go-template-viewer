package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/fsnotify/fsnotify"
)

// ── Models ──────────────────────────────────────────────────────────────────

// Page represents a single page derived from the filesystem.
type Page struct {
	Path     string         `json:"path"`
	File     string         `json:"-"`
	Title    string         `json:"title"`
	Order    int            `json:"order"`
	Hidden   bool           `json:"hidden"`
	Nav      *bool          `json:"nav,omitempty"`
	Dynamic  bool           `json:"-"`
	Slug     string         `json:"-"`
	Children []*Page        `json:"children,omitempty"`
	Data     map[string]any `json:"data,omitempty"`
}

// ShouldShowInNav determines if a page should appear in navigation.
func (p *Page) ShouldShowInNav() bool {
	if p.Nav != nil {
		return *p.Nav
	}
	return !p.Hidden && !p.Dynamic
}

// Site holds the full site structure for template rendering.
type Site struct {
	Pages []*Page `json:"pages"`
}

// RenderData is the unified data object passed to every template.
type RenderData struct {
	Page Page           `json:"page"`
	Site Site           `json:"site"`
	Env  map[string]string `json:"env"`
	Dev  bool           `json:"dev"`
	Slug string         `json:"slug,omitempty"`
	Path string         `json:"path"`
	Data map[string]any `json:"data,omitempty"`
}

// PageMeta represents metadata loaded from sidecar JSON files.
type PageMeta struct {
	Title  string         `json:"title"`
	Order  int            `json:"order"`
	Hidden bool           `json:"hidden"`
	Nav    *bool          `json:"nav,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

// ServeConfig holds the server configuration.
type ServeConfig struct {
	PagesDir    string `json:"pagesDir"`
	LayoutsDir  string `json:"layoutsDir"`
	PartialsDir string `json:"partialsDir"`
	StaticDir   string `json:"staticDir"`
	LayoutFile  string `json:"layoutFile"`
	IndexFile   string `json:"indexFile"`
	Port        int    `json:"port"`

	// Context-driven mode: uses the extension's render context instead of convention dirs
	ContextFiles []string `json:"contextFiles,omitempty"` // Files from the render context (entry + included)
	EntryFile    string   `json:"entryFile,omitempty"`    // The entry/base template file
	DataFile     string   `json:"dataFile,omitempty"`     // Linked .vscode/template-data JSON file
	DataDir      string   `json:"dataDir,omitempty"`      // .vscode/template-data directory for auto-discovery
	ContentRoot  string   `json:"contentRoot,omitempty"` // Content root for static asset resolution
}

// DevServer is the development HTTP server.
type DevServer struct {
	cfg     ServeConfig
	root    *Page
	site    Site
	mu      sync.RWMutex
	watcher *fsnotify.Watcher

	// SSE clients for live reload
	sseClients   map[chan struct{}]struct{}
	sseClientsMu sync.Mutex

	// Listener for port detection
	listener net.Listener

	// Context mode: true when using extension render context instead of convention dirs
	contextMode bool

	// Context mode data loaded from the linked data file
	contextData map[string]any

	// Context mode: discovered pages and shared templates
	contextPages  []*ContextPage // All navigable pages discovered from the workspace
	sharedFiles   []string       // Layout/partial files from the context (non-page templates)
	contextPageMu sync.RWMutex
}

// ContextPage represents a navigable page discovered from the workspace.
type ContextPage struct {
	URLPath  string // URL path for this page (e.g., "/dashboard", "/apps/access")
	FilePath string // Absolute file path to the template
	Title    string // Display title derived from filename
	DataFile string // Linked data file from .vscode/template-data/ (if found)
}

// ── Server lifecycle ────────────────────────────────────────────────────────

func runServe(configJSON string) error {
	var cfg ServeConfig
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return fmt.Errorf("invalid config JSON: %w", err)
	}

	if cfg.Port == 0 {
		cfg.Port = 3000
	}

	// Auto-detect index file if not provided
	if cfg.IndexFile == "" {
		cfg.IndexFile = autoDetectIndex(cfg.PagesDir)
	}

	srv, err := newDevServer(cfg)
	if err != nil {
		return fmt.Errorf("failed to create server: %w", err)
	}

	return srv.start()
}

func newDevServer(cfg ServeConfig) (*DevServer, error) {
	s := &DevServer{
		cfg:         cfg,
		sseClients:  make(map[chan struct{}]struct{}),
		contextMode: len(cfg.ContextFiles) > 0 && cfg.EntryFile != "",
		contextData: make(map[string]any),
	}

	if s.contextMode {
		log.Println("📋 Running in context mode (using extension render context)")
		// Classify context files into shared (layout/partials) vs pages
		s.classifyContextFiles()
		// Discover all navigable pages from the workspace
		s.discoverPages()
		// Load data from linked data file
		s.loadContextData()
	} else {
		log.Println("📂 Running in convention mode (pages/layouts/partials)")
		// Build initial navigation tree
		if err := s.rebuildNavTree(); err != nil {
			return nil, fmt.Errorf("failed to build navigation tree: %w", err)
		}
	}

	return s, nil
}

func (s *DevServer) start() error {
	// Start file watcher
	if err := s.startWatcher(); err != nil {
		log.Printf("⚠️  File watcher not available: %v", err)
	} else {
		log.Println("👁  Watching for file changes...")
	}

	// Set up routes
	mux := http.NewServeMux()

	// Static file server — serve from staticDir (convention mode) or contentRoot (context mode)
	if s.contextMode && s.cfg.ContentRoot != "" && dirExists(s.cfg.ContentRoot) {
		fsHandler := http.FileServer(http.Dir(s.cfg.ContentRoot))
		mux.Handle("/static/", http.StripPrefix("/static/", fsHandler))
		log.Printf("📁 Serving static files from %s at /static/", s.cfg.ContentRoot)
	} else if !s.contextMode && dirExists(s.cfg.StaticDir) {
		fsHandler := http.FileServer(http.Dir(s.cfg.StaticDir))
		mux.Handle("/static/", http.StripPrefix("/static/", fsHandler))
		log.Printf("📁 Serving static files from %s at /static/", s.cfg.StaticDir)
	}

	// In context mode, serve static assets from the entry file's directory tree
	// This handles relative asset references like "assets/media/..." in templates
	if s.contextMode {
		entryDir := filepath.Dir(s.cfg.EntryFile)
		// Check for an assets directory next to the entry file
		assetsDir := filepath.Join(entryDir, "assets")
		if dirExists(assetsDir) {
			assetHandler := http.FileServer(http.Dir(entryDir))
			mux.Handle("/assets/", assetHandler)
			log.Printf("📁 Serving assets from %s at /assets/", assetsDir)
		}
	}

	// SSE endpoint for live reload
	mux.HandleFunc("/__reload", s.handleSSE)

	// Template handler (catch-all)
	mux.HandleFunc("/", s.handlePage)

	// Listen on the configured port with fallback
	ln, err := listenWithFallback(s.cfg.Port)
	if err != nil {
		return fmt.Errorf("failed to find an available port: %w", err)
	}
	s.listener = ln

	// Output the actual port (important for the extension to detect)
	actualPort := ln.Addr().(*net.TCPAddr).Port
	fmt.Fprintf(os.Stdout, "SERVE_READY|port=%d\n", actualPort)
	if actualPort != s.cfg.Port {
		log.Printf("⚠️  Port %d was in use, using port %d instead", s.cfg.Port, actualPort)
	}
	log.Printf("✅ Server ready at http://localhost:%d", actualPort)

	return http.Serve(ln, mux)
}

// ── File watcher ────────────────────────────────────────────────────────────

func (s *DevServer) startWatcher() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = w

	if s.contextMode {
		// Context mode: watch only the directories containing context files
		watchedDirs := make(map[string]bool)
		for _, file := range s.cfg.ContextFiles {
			dir := filepath.Dir(file)
			if !watchedDirs[dir] && dirExists(dir) {
				w.Add(dir)
				watchedDirs[dir] = true
			}
		}

		// Watch discovered page directories
		s.contextPageMu.RLock()
		for _, page := range s.contextPages {
			dir := filepath.Dir(page.FilePath)
			if !watchedDirs[dir] && dirExists(dir) {
				w.Add(dir)
				watchedDirs[dir] = true
			}
		}
		s.contextPageMu.RUnlock()

		// Watch discovered shared template directories
		for _, sf := range s.sharedFiles {
			dir := filepath.Dir(sf)
			if !watchedDirs[dir] && dirExists(dir) {
				w.Add(dir)
				watchedDirs[dir] = true
			}
		}

		// Watch the pages subdirectory if it exists
		entryDir := filepath.Dir(s.cfg.EntryFile)
		pagesSubdir := filepath.Join(entryDir, "pages")
		if !watchedDirs[pagesSubdir] && dirExists(pagesSubdir) {
			addRecursiveWatch(w, pagesSubdir)
			watchedDirs[pagesSubdir] = true
		}

		// Watch the data directory for linked data file changes
		if s.cfg.DataDir != "" && !watchedDirs[s.cfg.DataDir] && dirExists(s.cfg.DataDir) {
			w.Add(s.cfg.DataDir)
			watchedDirs[s.cfg.DataDir] = true
		}
	} else {
		// Convention mode: watch pages, layouts, partials dirs
		dirs := []string{s.cfg.PagesDir, s.cfg.LayoutsDir, s.cfg.PartialsDir}
		for _, dir := range dirs {
			if dirExists(dir) {
				addRecursiveWatch(w, dir)
			}
		}
	}

	go s.watchLoop()
	return nil
}

func addRecursiveWatch(w *fsnotify.Watcher, dir string) {
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		w.Add(path)
		return nil
	})
}

func (s *DevServer) watchLoop() {
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) ||
				event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
				if event.Has(fsnotify.Create) {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						addRecursiveWatch(s.watcher, event.Name)
					}
				}
				log.Printf("🔄 File changed: %s", event.Name)
				if s.contextMode {
					// Reload data if a data file changed
					if strings.HasSuffix(event.Name, ".json") {
						s.loadContextData()
					}
					// Re-discover pages if an HTML file was added or removed
					if strings.HasSuffix(event.Name, ".html") &&
						(event.Has(fsnotify.Create) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)) {
						s.discoverPages()
					}
				} else {
					s.rebuildNavTree()
				}
				s.notifyClients()
			}
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("⚠️  Watcher error: %v", err)
		}
	}
}

// ── Navigation tree ─────────────────────────────────────────────────────────

func (s *DevServer) rebuildNavTree() error {
	root, err := buildNavTree(s.cfg.PagesDir, s.cfg.IndexFile)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.root = root
	s.site = Site{Pages: root.Children}
	s.mu.Unlock()
	return nil
}

func buildNavTree(pagesDir, indexFile string) (*Page, error) {
	pagesDir = filepath.Clean(pagesDir)

	root := &Page{
		Path:     "/",
		Title:    "Home",
		Children: []*Page{},
		Data:     make(map[string]any),
	}

	// Use the configured index file as root
	if indexFile != "" {
		rootEntry := filepath.Join(pagesDir, indexFile)
		if fileExistsServe(rootEntry) {
			root.File = rootEntry
		}
	}

	// Load root metadata
	if root.File != "" {
		if meta, pageData := loadPageMetaServe(root.File); meta != nil {
			applyMeta(root, meta, pageData)
		}
	}

	dirMap := map[string]*Page{".": root}

	filepath.Walk(pagesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		relPath, err := filepath.Rel(pagesDir, path)
		if err != nil || relPath == "." {
			return nil
		}

		base := filepath.Base(relPath)
		if strings.HasPrefix(base, ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			if strings.HasPrefix(base, "_") {
				return filepath.SkipDir
			}
			ensureDirNode(dirMap, pagesDir, relPath)
			return nil
		}

		ext := filepath.Ext(relPath)
		if ext != ".html" {
			return nil
		}

		if relPath == indexFile {
			return nil
		}

		nameWithoutExt := strings.TrimSuffix(base, ext)
		isDynamic := strings.HasPrefix(nameWithoutExt, "_")
		dir := filepath.Dir(relPath)

		var urlPath string
		if nameWithoutExt == "index" {
			urlPath = "/" + filepath.ToSlash(dir)
		} else if dir == "." {
			urlPath = "/" + nameWithoutExt
		} else {
			urlPath = "/" + filepath.ToSlash(dir) + "/" + nameWithoutExt
		}
		urlPath = strings.TrimSuffix(urlPath, "/")
		if urlPath == "" {
			urlPath = "/"
		}

		title := serveTitleCase(strings.ReplaceAll(strings.ReplaceAll(nameWithoutExt, "-", " "), "_", " "))

		page := &Page{
			Path:     urlPath,
			File:     path,
			Title:    title,
			Dynamic:  isDynamic,
			Children: []*Page{},
			Data:     make(map[string]any),
		}

		if meta, pageData := loadPageMetaServe(path); meta != nil {
			applyMeta(page, meta, pageData)
		}

		if nameWithoutExt == "index" {
			if existing, ok := dirMap[dir]; ok {
				existing.File = page.File
				existing.Title = page.Title
				existing.Order = page.Order
				existing.Hidden = page.Hidden
				existing.Nav = page.Nav
				existing.Dynamic = page.Dynamic
				existing.Data = page.Data
				return nil
			}
		}

		parentDir := filepath.Dir(relPath)
		if parentDir == "" {
			parentDir = "."
		}
		parent := ensureDirNode(dirMap, pagesDir, parentDir)
		parent.Children = append(parent.Children, page)

		return nil
	})

	sortPages(root)
	return root, nil
}

func ensureDirNode(dirMap map[string]*Page, pagesDir, relDir string) *Page {
	if relDir == "." {
		return dirMap["."]
	}
	if node, ok := dirMap[relDir]; ok {
		return node
	}

	base := filepath.Base(relDir)
	title := serveTitleCase(strings.ReplaceAll(base, "-", " "))
	urlPath := "/" + filepath.ToSlash(relDir)

	indexFile := filepath.Join(pagesDir, relDir, "index.html")
	resolvedFile := ""
	if fileExistsServe(indexFile) {
		resolvedFile = indexFile
	}

	node := &Page{
		Path:     urlPath,
		File:     resolvedFile,
		Title:    title,
		Children: []*Page{},
		Data:     make(map[string]any),
	}
	dirMap[relDir] = node

	parentDir := filepath.Dir(relDir)
	if parentDir == "" {
		parentDir = "."
	}
	parent := ensureDirNode(dirMap, pagesDir, parentDir)
	parent.Children = append(parent.Children, node)
	return node
}

func applyMeta(page *Page, meta *PageMeta, pageData map[string]any) {
	if meta == nil {
		return
	}
	if meta.Title != "" {
		page.Title = meta.Title
	}
	if meta.Order != 0 {
		page.Order = meta.Order
	}
	page.Hidden = meta.Hidden
	page.Nav = meta.Nav
	if pageData != nil {
		page.Data = pageData
	}
}

func sortPages(page *Page) {
	if len(page.Children) == 0 {
		return
	}
	sort.Slice(page.Children, func(i, j int) bool {
		if page.Children[i].Order != page.Children[j].Order {
			return page.Children[i].Order < page.Children[j].Order
		}
		return page.Children[i].Title < page.Children[j].Title
	})
	for _, child := range page.Children {
		sortPages(child)
	}
}

func findPage(root *Page, urlPath string) (*Page, string) {
	urlPath = strings.TrimSuffix(urlPath, "/")
	if urlPath == "" {
		urlPath = "/"
	}
	if urlPath == "/" {
		return root, ""
	}
	return findPageRecursive(root, urlPath)
}

func findPageRecursive(node *Page, urlPath string) (*Page, string) {
	for _, child := range node.Children {
		if child.Path == urlPath {
			return child, ""
		}
	}
	for _, child := range node.Children {
		if strings.HasPrefix(urlPath, child.Path+"/") {
			found, slug := findPageRecursive(child, urlPath)
			if found != nil {
				return found, slug
			}
		}
	}
	for _, child := range node.Children {
		if child.Dynamic {
			parentPath := node.Path
			if parentPath == "/" {
				parentPath = ""
			}
			remaining := strings.TrimPrefix(urlPath, parentPath+"/")
			if !strings.Contains(remaining, "/") && remaining != "" {
				return child, remaining
			}
		}
	}
	return nil, ""
}

// ── Context mode page discovery ─────────────────────────────────────────────

// isContentPage checks whether template text contains a {{define "content"}} block,
// which identifies it as a page template (as opposed to a partial, modal, or layout).
func isContentPage(text string) bool {
	return strings.Contains(text, `{{define "content"}}`) ||
		strings.Contains(text, `{{ define "content" }}`) ||
		strings.Contains(text, `{{- define "content" -}}`)
}

// classifyContextFiles separates the context files into shared templates (layouts/partials)
// and page templates. A file is considered a "page" if it contains {{define "content"}} or
// similar block definitions. Files that don't define content blocks are treated as shared
// (layouts, partials) that get loaded for every page render.
func (s *DevServer) classifyContextFiles() {
	s.sharedFiles = nil

	entryBase := filepath.Base(s.cfg.EntryFile)
	for _, file := range s.cfg.ContextFiles {
		base := filepath.Base(file)
		// The entry file (e.g., base.html) is always shared — it's the layout
		if base == entryBase || file == s.cfg.EntryFile {
			s.sharedFiles = append(s.sharedFiles, file)
			log.Printf("  📄 Shared (entry): %s", base)
			continue
		}

		// Check if this file defines a named template block (it's a page/content template)
		// vs being a partial/helper that should always be loaded
		content, err := os.ReadFile(file)
		if err != nil {
			s.sharedFiles = append(s.sharedFiles, file)
			continue
		}

		text := string(content)
		// Files that define "content" are page templates — they'll be swapped per page
		// Files that DON'T define content are shared (partials, helpers, etc.)
		if !isContentPage(text) {
			s.sharedFiles = append(s.sharedFiles, file)
			log.Printf("  📄 Shared (partial): %s", base)
		} else {
			log.Printf("  📄 Page (content): %s", base)
		}
	}
}

// discoverPages scans the directories containing the context files to find all navigable
// template pages AND auto-discovers shared templates (partials, modals, etc.) that aren't
// explicitly in the render context but are needed for rendering (e.g., {{template "partials/navbar" .}}).
func (s *DevServer) discoverPages() {
	s.contextPageMu.Lock()
	defer s.contextPageMu.Unlock()

	s.contextPages = nil

	// Re-classify context files first to reset sharedFiles to the known set
	// (This ensures removed files don't persist in sharedFiles across re-discoveries)
	s.classifyContextFiles()

	entryDir := filepath.Dir(s.cfg.EntryFile)

	// Collect all directories containing context files
	contextDirs := make(map[string]bool)
	for _, file := range s.cfg.ContextFiles {
		dir := filepath.Dir(file)
		contextDirs[dir] = true
	}

	// Find the "pages" root — look for a directory named "pages" in the context file paths,
	// or use the directory containing non-entry context files
	var pagesRoot string
	for dir := range contextDirs {
		base := filepath.Base(dir)
		if base == "pages" {
			pagesRoot = dir
			break
		}
	}

	// If no "pages" dir found, try the parent of the entry file's directory
	if pagesRoot == "" {
		// Check if there's a "pages" subdirectory
		pagesSubdir := filepath.Join(entryDir, "pages")
		if dirExists(pagesSubdir) {
			pagesRoot = pagesSubdir
		} else {
			// Check if any context file is in a "pages" subdirectory
			for _, file := range s.cfg.ContextFiles {
				dir := filepath.Dir(file)
				for dir != "." && dir != "/" && dir != entryDir {
					if filepath.Base(dir) == "pages" {
						pagesRoot = dir
						break
					}
					dir = filepath.Dir(dir)
				}
				if pagesRoot != "" {
					break
				}
			}
		}
	}

	// If still no pages root, only scan the specific directories containing context files.
	// Do NOT fall back to the entire entryDir — that would pick up unrelated HTML files.
	if pagesRoot == "" {
		// No pages root found — page discovery is limited to context files only.
		// The context files from the extension's render context are the source of truth.
		log.Printf("  ℹ️  No pages/ directory found — skipping broad page discovery")
		log.Printf("  ✅ Discovered %d navigable pages (from context only)", len(s.contextPages))
		return
	}

	log.Printf("  🔍 Scanning for pages in: %s", pagesRoot)

	// Build a set of files already known (shared files from classify + entry file)
	knownFiles := make(map[string]bool)
	for _, sf := range s.sharedFiles {
		knownFiles[sf] = true
	}
	knownFiles[s.cfg.EntryFile] = true

	// Walk the pages root to discover all page templates
	filepath.Walk(pagesRoot, func(filePath string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(filePath, ".html") {
			return nil
		}
		base := filepath.Base(filePath)
		if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
			return nil
		}
		// Skip already-known files
		if knownFiles[filePath] {
			return nil
		}

		// Check if this file defines a content block (making it a page)
		content, readErr := os.ReadFile(filePath)
		if readErr != nil {
			return nil
		}
		text := string(content)
		if !isContentPage(text) {
			return nil
		}

		// Build URL path from relative path
		relPath, relErr := filepath.Rel(pagesRoot, filePath)
		if relErr != nil {
			return nil
		}

		nameWithoutExt := strings.TrimSuffix(filepath.Base(relPath), ".html")
		dir := filepath.Dir(relPath)

		var urlPath string
		if nameWithoutExt == "index" {
			if dir == "." {
				urlPath = "/"
			} else {
				urlPath = "/" + filepath.ToSlash(dir)
			}
		} else if dir == "." {
			urlPath = "/" + nameWithoutExt
		} else {
			urlPath = "/" + filepath.ToSlash(dir) + "/" + nameWithoutExt
		}
		urlPath = strings.TrimSuffix(urlPath, "/")
		if urlPath == "" {
			urlPath = "/"
		}

		title := serveTitleCase(strings.ReplaceAll(strings.ReplaceAll(nameWithoutExt, "-", " "), "_", " "))

		page := &ContextPage{
			URLPath:  urlPath,
			FilePath: filePath,
			Title:    title,
		}

		// Try to find a linked data file for this page
		page.DataFile = s.findDataFileForPage(filePath)

		s.contextPages = append(s.contextPages, page)
		knownFiles[filePath] = true
		log.Printf("  📑 Page: %s → %s", urlPath, base)
		return nil
	})

	// Sort pages by URL path
	sort.Slice(s.contextPages, func(i, j int) bool {
		return s.contextPages[i].URLPath < s.contextPages[j].URLPath
	})

	log.Printf("  ✅ Discovered %d navigable pages", len(s.contextPages))

	// ── Auto-discover shared templates (partials, modals, etc.) ─────────
	// Scan sibling directories of the entry file (e.g., partials/, modals/) for
	// template files that the layout references via {{template "partials/navbar" .}}.
	// Only scan immediate subdirectories of the entry dir — NOT the entire tree.
	entriesInEntryDir, readErr := os.ReadDir(entryDir)
	if readErr == nil {
		discoveredShared := 0
		for _, entry := range entriesInEntryDir {
			if !entry.IsDir() {
				continue
			}
			// Skip the pages directory — already scanned above
			subdir := filepath.Join(entryDir, entry.Name())
			if subdir == pagesRoot {
				continue
			}
			// Skip directories that clearly aren't template dirs (assets, static, data, etc.)
			name := strings.ToLower(entry.Name())
			if name == "assets" || name == "static" || name == "data" || name == "css" ||
				name == "js" || name == "images" || name == "media" || name == "fonts" ||
				name == "node_modules" || name == ".git" || name == "vendor" || name == "tmp" {
				continue
			}

			// Walk this subdirectory for shared templates
			filepath.Walk(subdir, func(filePath string, info os.FileInfo, walkErr error) error {
				if walkErr != nil || info.IsDir() {
					return nil
				}
				if !strings.HasSuffix(filePath, ".html") {
					return nil
				}
				base := filepath.Base(filePath)
				if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
					return nil
				}
				if knownFiles[filePath] {
					return nil
				}

				content, readErr := os.ReadFile(filePath)
				if readErr != nil {
					return nil
				}
				if isContentPage(string(content)) {
					return nil // Skip page templates
				}

				s.sharedFiles = append(s.sharedFiles, filePath)
				knownFiles[filePath] = true
				discoveredShared++

				relPath, _ := filepath.Rel(entryDir, filePath)
				log.Printf("  📄 Auto-discovered shared: %s", filepath.ToSlash(relPath))
				return nil
			})
		}

		if discoveredShared > 0 {
			log.Printf("  ✅ Auto-discovered %d shared templates (partials, modals, etc.)", discoveredShared)
		}
	}
}

// findDataFileForPage looks in .vscode/template-data/ for a data file that matches the given page.
func (s *DevServer) findDataFileForPage(pageFile string) string {
	if s.cfg.DataDir == "" || !dirExists(s.cfg.DataDir) {
		return ""
	}

	entries, err := os.ReadDir(s.cfg.DataDir)
	if err != nil {
		return ""
	}

	pageBase := filepath.Base(pageFile)

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		dataPath := filepath.Join(s.cfg.DataDir, entry.Name())
		raw, err := os.ReadFile(dataPath)
		if err != nil {
			continue
		}
		var data map[string]any
		if json.Unmarshal(raw, &data) != nil {
			continue
		}

		// Check _templateContext.entryFile or includedFiles for a match
		if ctx, ok := data["_templateContext"].(map[string]any); ok {
			// Check if the entry file matches
			if ctxEntry, ok := ctx["entryFile"].(string); ok {
				if filepath.Base(ctxEntry) == pageBase {
					return dataPath
				}
			}
			// Check if this page is in the includedFiles
			if included, ok := ctx["includedFiles"].([]any); ok {
				for _, inc := range included {
					if incStr, ok := inc.(string); ok {
						if filepath.Base(incStr) == pageBase {
							return dataPath
						}
					}
				}
			}
		}

		// Filename-based match
		nameWithoutExt := strings.TrimSuffix(entry.Name(), ".json")
		if nameWithoutExt == pageBase || strings.HasSuffix(nameWithoutExt, "--"+pageBase) {
			return dataPath
		}
	}

	return ""
}

// findContextPage finds a discovered page matching the given URL path.
func (s *DevServer) findContextPage(urlPath string) *ContextPage {
	urlPath = strings.TrimSuffix(urlPath, "/")
	if urlPath == "" {
		urlPath = "/"
	}

	s.contextPageMu.RLock()
	defer s.contextPageMu.RUnlock()

	for _, p := range s.contextPages {
		if p.URLPath == urlPath {
			return p
		}
	}
	return nil
}

// ── Data loading ────────────────────────────────────────────────────────────

// loadContextData loads data from the extension's linked data file (.vscode/template-data/).
// This is the unified system — the same data file the extension uses for its preview.
func (s *DevServer) loadContextData() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.contextData = make(map[string]any)

	// Primary: use the explicitly linked data file
	if s.cfg.DataFile != "" && fileExistsServe(s.cfg.DataFile) {
		raw, err := os.ReadFile(s.cfg.DataFile)
		if err != nil {
			log.Printf("⚠️  Failed to read data file %s: %v", s.cfg.DataFile, err)
			return
		}
		if err := json.Unmarshal(raw, &s.contextData); err != nil {
			log.Printf("⚠️  Failed to parse data file %s: %v", s.cfg.DataFile, err)
			return
		}
		log.Printf("📊 Loaded data from %s (%d keys)", filepath.Base(s.cfg.DataFile), len(s.contextData)-1)
		return
	}

	// Fallback: auto-discover data file from DataDir matching the entry file
	if s.cfg.DataDir != "" && s.cfg.EntryFile != "" && dirExists(s.cfg.DataDir) {
		entries, err := os.ReadDir(s.cfg.DataDir)
		if err != nil {
			return
		}
		entryBase := filepath.Base(s.cfg.EntryFile)
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			// Check if this data file's _templateContext.entryFile matches our entry
			dataPath := filepath.Join(s.cfg.DataDir, entry.Name())
			raw, err := os.ReadFile(dataPath)
			if err != nil {
				continue
			}
			var data map[string]any
			if json.Unmarshal(raw, &data) != nil {
				continue
			}
			// Check _templateContext metadata for matching entry file
			if ctx, ok := data["_templateContext"].(map[string]any); ok {
				if ctxEntry, ok := ctx["entryFile"].(string); ok {
					if filepath.Base(ctxEntry) == entryBase || ctxEntry == s.cfg.EntryFile {
						s.contextData = data
						log.Printf("📊 Auto-discovered data file: %s", entry.Name())
						return
					}
				}
			}
			// Fallback: filename-based match (sanitized path naming convention)
			nameWithoutExt := strings.TrimSuffix(entry.Name(), ".json")
			if nameWithoutExt == entryBase || strings.HasSuffix(nameWithoutExt, "--"+entryBase) {
				s.contextData = data
				log.Printf("📊 Auto-discovered data file by name: %s", entry.Name())
				return
			}
		}
	}
}

func loadPageMetaServe(templatePath string) (*PageMeta, map[string]any) {
	ext := filepath.Ext(templatePath)
	basePath := strings.TrimSuffix(templatePath, ext)

	jsonPath := basePath + ".json"
	if !fileExistsServe(jsonPath) {
		return nil, nil
	}

	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, nil
	}

	pageData := make(map[string]any)
	if err := json.Unmarshal(raw, &pageData); err != nil {
		return nil, nil
	}

	meta := &PageMeta{}
	if title, ok := pageData["title"].(string); ok {
		meta.Title = title
	}
	if order, ok := pageData["order"]; ok {
		switch v := order.(type) {
		case float64:
			meta.Order = int(v)
		}
	}
	if hidden, ok := pageData["hidden"].(bool); ok {
		meta.Hidden = hidden
	}
	if nav, ok := pageData["nav"].(bool); ok {
		meta.Nav = &nav
	}

	return meta, pageData
}

func loadSlugData(templatePath, slug string) map[string]any {
	dir := filepath.Dir(templatePath)
	candidates := []string{
		filepath.Join(dir, "data", slug+".json"),
		filepath.Join(dir, slug+".json"),
	}
	for _, path := range candidates {
		if !fileExistsServe(path) {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data := make(map[string]any)
		if json.Unmarshal(raw, &data) == nil {
			return data
		}
	}
	return nil
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

func (s *DevServer) handlePage(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path

	if urlPath == "/favicon.ico" {
		http.NotFound(w, r)
		return
	}

	log.Printf("📄 %s %s", r.Method, urlPath)

	if s.contextMode {
		s.handleContextPage(w, r)
		return
	}

	s.handleConventionPage(w, r, urlPath)
}

// handleContextPage renders using the extension's render context (shared files + discovered pages).
// Navigation works by swapping in the appropriate page template while keeping the shared
// templates (layout, partials) from the context.
func (s *DevServer) handleContextPage(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path

	// Determine which page file to render
	var pageFile string
	var pageData map[string]any

	// First, check discovered pages for a URL match
	ctxPage := s.findContextPage(urlPath)
	if ctxPage != nil {
		pageFile = ctxPage.FilePath
		// Load per-page data from its linked data file
		if ctxPage.DataFile != "" {
			pageData = loadJSONFile(ctxPage.DataFile)
		}
	}

	// Fallback: if no discovered page matches, use the entry file for "/" or any unmatched URL
	if pageFile == "" {
		if urlPath == "/" || urlPath == "" {
			// For root, check if any context file is a page, otherwise use the first context page
			if len(s.contextPages) > 0 {
				// Try to find a root/index page
				for _, p := range s.contextPages {
					if p.URLPath == "/" {
						pageFile = p.FilePath
						if p.DataFile != "" {
							pageData = loadJSONFile(p.DataFile)
						}
						break
					}
				}
				// If no root page, use the first page
				if pageFile == "" {
					pageFile = s.contextPages[0].FilePath
					if s.contextPages[0].DataFile != "" {
						pageData = loadJSONFile(s.contextPages[0].DataFile)
					}
				}
			} else {
				// No discovered pages — render just the shared context files
				pageFile = ""
			}
		} else {
			http.NotFound(w, r)
			return
		}
	}

	// Build template set: shared files + the page file
	tmpl := template.New("").Funcs(serveFuncMap())

	// Load all shared files (layout, partials) — these are always included
	for _, file := range s.sharedFiles {
		if !fileExistsServe(file) {
			log.Printf("⚠️  Shared file not found: %s", file)
			continue
		}
		content, err := os.ReadFile(file)
		if err != nil {
			log.Printf("⚠️  Failed to read shared file %s: %v", file, err)
			continue
		}
		_, err = tmpl.New(filepath.Base(file)).Parse(string(content))
		if err != nil {
			log.Printf("❌ Template parse error in %s: %v", file, err)
			http.Error(w, fmt.Sprintf("Template error in %s: %v", filepath.Base(file), err), http.StatusInternalServerError)
			return
		}
	}

	// Load the page template (the one with {{define "content"}})
	if pageFile != "" && fileExistsServe(pageFile) {
		content, err := os.ReadFile(pageFile)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to read page: %v", err), http.StatusInternalServerError)
			return
		}
		_, err = tmpl.New(filepath.Base(pageFile)).Parse(string(content))
		if err != nil {
			log.Printf("❌ Template parse error in %s: %v", pageFile, err)
			http.Error(w, fmt.Sprintf("Template error in %s: %v", filepath.Base(pageFile), err), http.StatusInternalServerError)
			return
		}
	}

	// Build the render data — merge context data with per-page data
	s.mu.RLock()
	data := make(map[string]any)
	for k, v := range s.contextData {
		if k != "_templateContext" {
			data[k] = v
		}
	}
	s.mu.RUnlock()

	// Override with per-page data (page-specific data takes precedence)
	if pageData != nil {
		for k, v := range pageData {
			if k != "_templateContext" {
				data[k] = v
			}
		}
	}

	// Add navigation info so templates can build menus
	data["_pages"] = s.buildContextNavData(urlPath)
	data["_currentPath"] = urlPath

	// Render the entry template (the layout)
	entryName := filepath.Base(s.cfg.EntryFile)
	var buf bytes.Buffer
	err := tmpl.ExecuteTemplate(&buf, entryName, data)
	if err != nil {
		log.Printf("❌ Render error: %v", err)
		http.Error(w, fmt.Sprintf("Render error: %v", err), http.StatusInternalServerError)
		return
	}

	output := s.injectLiveReload(buf.String())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, output)
}

// buildContextNavData creates navigation data from discovered pages.
func (s *DevServer) buildContextNavData(currentPath string) []map[string]any {
	s.contextPageMu.RLock()
	defer s.contextPageMu.RUnlock()

	var nav []map[string]any
	for _, p := range s.contextPages {
		nav = append(nav, map[string]any{
			"Path":   p.URLPath,
			"Title":  p.Title,
			"Active": p.URLPath == currentPath,
		})
	}
	return nav
}

// loadJSONFile reads and parses a JSON file, returning nil on error.
func loadJSONFile(filePath string) map[string]any {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	data := make(map[string]any)
	if json.Unmarshal(raw, &data) != nil {
		return nil
	}
	return data
}

// handleConventionPage renders using the convention-based directory structure.
func (s *DevServer) handleConventionPage(w http.ResponseWriter, r *http.Request, urlPath string) {
	s.mu.RLock()
	root := s.root
	site := s.site
	s.mu.RUnlock()

	page, slug := findPage(root, urlPath)

	var templateFile string
	if page != nil {
		templateFile = page.File
	} else {
		templateFile = s.resolveTemplatePath(urlPath)
	}

	if templateFile == "" || !fileExistsServe(templateFile) {
		http.NotFound(w, r)
		return
	}

	// Load templates fresh (dev mode)
	t, err := s.loadTemplates(templateFile)
	if err != nil {
		log.Printf("❌ Template error: %v", err)
		http.Error(w, fmt.Sprintf("Template error: %v", err), http.StatusInternalServerError)
		return
	}

	// Build render data
	rd := s.buildRenderData(page, site, urlPath, slug, templateFile)

	// Load slug-specific data
	if slug != "" {
		slugData := loadSlugData(templateFile, slug)
		if slugData != nil {
			for k, v := range slugData {
				rd.Data[k] = v
			}
			if title, ok := slugData["title"].(string); ok {
				rd.Page.Title = title
			}
		}
	}

	var buf bytes.Buffer
	layoutName := s.resolveLayoutName()

	if layoutName != "" {
		err = t.ExecuteTemplate(&buf, layoutName, rd)
		if err != nil {
			log.Printf("⚠️  Layout %q failed, rendering page directly: %v", layoutName, err)
			buf.Reset()
			err = t.Execute(&buf, rd)
		}
	} else {
		err = t.Execute(&buf, rd)
	}

	if err != nil {
		log.Printf("❌ Render error: %v", err)
		http.Error(w, fmt.Sprintf("Render error: %v", err), http.StatusInternalServerError)
		return
	}

	output := s.injectLiveReload(buf.String())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, output)
}

func (s *DevServer) resolveLayoutName() string {
	if !dirExists(s.cfg.LayoutsDir) {
		return ""
	}
	if s.cfg.LayoutFile != "" {
		layoutPath := filepath.Join(s.cfg.LayoutsDir, s.cfg.LayoutFile)
		if fileExistsServe(layoutPath) {
			return s.cfg.LayoutFile
		}
	}
	entries, err := os.ReadDir(s.cfg.LayoutsDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".html") {
			return entry.Name()
		}
	}
	return ""
}

func (s *DevServer) resolveTemplatePath(urlPath string) string {
	clean := strings.TrimPrefix(urlPath, "/")
	if clean == "" {
		if s.cfg.IndexFile != "" {
			indexPath := filepath.Join(s.cfg.PagesDir, s.cfg.IndexFile)
			if fileExistsServe(indexPath) {
				return indexPath
			}
		}
		return ""
	}

	exact := filepath.Join(s.cfg.PagesDir, clean+".html")
	if fileExistsServe(exact) {
		return exact
	}

	indexPath := filepath.Join(s.cfg.PagesDir, clean, "index.html")
	if fileExistsServe(indexPath) {
		return indexPath
	}

	// Wildcard match
	dir := filepath.Dir(clean)
	parentDir := filepath.Join(s.cfg.PagesDir, dir)
	if dirExists(parentDir) {
		entries, err := os.ReadDir(parentDir)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() && strings.HasPrefix(entry.Name(), "_") && strings.HasSuffix(entry.Name(), ".html") {
					return filepath.Join(parentDir, entry.Name())
				}
			}
		}
	}
	return ""
}

func (s *DevServer) buildRenderData(page *Page, site Site, urlPath, slug, templateFile string) RenderData {
	rd := RenderData{
		Site: site,
		Env:  getEnvMap(),
		Dev:  true,
		Slug: slug,
		Path: urlPath,
		Data: make(map[string]any),
	}
	if page != nil {
		rd.Page = *page
		for k, v := range page.Data {
			rd.Data[k] = v
		}
	} else {
		rd.Page = Page{Path: urlPath, File: templateFile}
	}
	return rd
}

// ── Template loading ────────────────────────────────────────────────────────

func (s *DevServer) loadTemplates(pageFile string) (*template.Template, error) {
	tmpl := template.New("").Funcs(serveFuncMap())

	// Parse layouts
	if dirExists(s.cfg.LayoutsDir) {
		layoutFiles, err := filepath.Glob(filepath.Join(s.cfg.LayoutsDir, "*.html"))
		if err == nil && len(layoutFiles) > 0 {
			tmpl, err = tmpl.ParseFiles(layoutFiles...)
			if err != nil {
				return nil, fmt.Errorf("failed to parse layouts: %w", err)
			}
		}
	}

	// Parse partials
	if dirExists(s.cfg.PartialsDir) {
		partialFiles, err := filepath.Glob(filepath.Join(s.cfg.PartialsDir, "*.html"))
		if err == nil && len(partialFiles) > 0 {
			tmpl, err = tmpl.ParseFiles(partialFiles...)
			if err != nil {
				return nil, fmt.Errorf("failed to parse partials: %w", err)
			}
		}
	}

	// Parse the page template
	if pageFile != "" {
		content, err := os.ReadFile(pageFile)
		if err != nil {
			return nil, fmt.Errorf("failed to read page %s: %w", pageFile, err)
		}
		_, err = tmpl.Parse(string(content))
		if err != nil {
			return nil, fmt.Errorf("failed to parse page %s: %w", pageFile, err)
		}
	}

	return tmpl, nil
}

func serveFuncMap() template.FuncMap {
	return template.FuncMap{
		// String manipulation
		"upper":     strings.ToUpper,
		"lower":     strings.ToLower,
		"title":     serveTitleCase,
		"contains":  strings.Contains,
		"replace":   strings.ReplaceAll,
		"trim":      strings.TrimSpace,
		"split":     strings.Split,
		"join":      strings.Join,
		"hasPrefix": strings.HasPrefix,
		"hasSuffix": strings.HasSuffix,

		// Comparison (flexible for JSON float64 vs int)
		"eq": flexibleEq,
		"ne": flexibleNe,
		"lt": flexibleLt,
		"le": flexibleLe,
		"gt": flexibleGt,
		"ge": flexibleGe,

		// Conditional helpers
		"default": func(def, val any) any {
			if val == nil {
				return def
			}
			if s, ok := val.(string); ok && s == "" {
				return def
			}
			return val
		},

		// Navigation helpers
		"isActive": func(current, target string) bool {
			current = strings.TrimSuffix(current, "/")
			target = strings.TrimSuffix(target, "/")
			if current == "" {
				current = "/"
			}
			if target == "" {
				target = "/"
			}
			return current == target
		},
		"isActivePrefix": func(current, target string) bool {
			return strings.HasPrefix(current, target)
		},

		// HTML helpers
		"safeHTML": func(s string) template.HTML { return template.HTML(s) },
		"safeAttr": func(s string) template.HTMLAttr { return template.HTMLAttr(s) },
		"safeURL":  func(s string) template.URL { return template.URL(s) },
		"safeCSS":  func(s string) template.CSS { return template.CSS(s) },
		"safeJS":   func(s string) template.JS { return template.JS(s) },

		// Map helpers
		"dict": func(values ...any) map[string]any {
			if len(values)%2 != 0 {
				return nil
			}
			m := make(map[string]any, len(values)/2)
			for i := 0; i < len(values); i += 2 {
				if key, ok := values[i].(string); ok {
					m[key] = values[i+1]
				}
			}
			return m
		},

		// Slice helpers
		"slice": func(values ...any) []any { return values },
	}
}

// ── SSE live reload ─────────────────────────────────────────────────────────

func (s *DevServer) injectLiveReload(html string) string {
	script := `<script>
(function() {
  const source = new EventSource('/__reload');
  source.onmessage = function(e) {
    if (e.data === 'reload') {
      window.location.reload();
    }
  };
  source.onerror = function() {
    setTimeout(function() {
      window.location.reload();
    }, 1000);
  };
})();
</script>`

	idx := strings.LastIndex(strings.ToLower(html), "</body>")
	if idx != -1 {
		return html[:idx] + script + "\n" + html[idx:]
	}
	return html + script
}

func (s *DevServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := make(chan struct{}, 1)

	s.sseClientsMu.Lock()
	s.sseClients[ch] = struct{}{}
	s.sseClientsMu.Unlock()

	defer func() {
		s.sseClientsMu.Lock()
		delete(s.sseClients, ch)
		s.sseClientsMu.Unlock()
	}()

	fmt.Fprintf(w, "data: connected\n\n")
	flusher.Flush()

	for {
		select {
		case <-ch:
			fmt.Fprintf(w, "data: reload\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *DevServer) notifyClients() {
	s.sseClientsMu.Lock()
	defer s.sseClientsMu.Unlock()
	for ch := range s.sseClients {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

func autoDetectIndex(pagesDir string) string {
	entries, err := os.ReadDir(pagesDir)
	if err != nil {
		return ""
	}
	var candidates []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".html") {
			candidates = append(candidates, entry.Name())
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	for _, c := range candidates {
		if c == "index.html" {
			return c
		}
	}
	return candidates[0]
}

func getEnvMap() map[string]string {
	env := make(map[string]string)
	for _, e := range os.Environ() {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) == 2 && strings.HasPrefix(parts[0], "TEMPLATEDEV_") {
			key := strings.TrimPrefix(parts[0], "TEMPLATEDEV_")
			env[key] = parts[1]
		}
	}
	return env
}

func fileExistsServe(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// listenWithFallback tries the configured port, then increments up to 10 times,
// then falls back to OS-assigned port (:0).
func listenWithFallback(preferredPort int) (net.Listener, error) {
	// Try the preferred port first
	addr := fmt.Sprintf(":%d", preferredPort)
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, nil
	}

	// Try incrementing ports
	for offset := 1; offset <= 10; offset++ {
		tryPort := preferredPort + offset
		addr = fmt.Sprintf(":%d", tryPort)
		ln, err = net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
	}

	// Last resort: let the OS pick a free port
	ln, err = net.Listen("tcp", ":0")
	if err != nil {
		return nil, fmt.Errorf("no available port found (tried %d-%d and OS assignment): %w", preferredPort, preferredPort+10, err)
	}
	return ln, nil
}

func serveTitleCase(s string) string {
	prev := ' '
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(prev) || prev == '-' || prev == '_' {
			prev = r
			return unicode.ToTitle(r)
		}
		prev = r
		return r
	}, s)
}
