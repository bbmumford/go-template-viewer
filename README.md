# Go Template Viewer

A Visual Studio Code extension for developing and previewing Go templates with live reload functionality. This extension helps frontend developers and template designers work with Go templates without needing to run the full Go application.

![Go Template Viewer Screenshot](resources/screenshots/main-view.png)

## Two Ways to Work

This extension provides **two complementary development experiences** — an in-editor preview for rapid template authoring, and a full dev server for browser-based testing. Both use the real Go `html/template` engine under the hood, but they serve different purposes and have different capabilities.

### Preview Panel vs Dev Server — at a glance

| | 🎨 Preview Panel (in VS Code) | 🖥️ Dev Server (in browser) |
|---|---|---|
| **Where** | VS Code webview panel beside your editor | Your default browser |
| **Best for** | Editing a single template, shaping data | Testing navigation, JS-heavy pages, HTMX |
| **Rendering** | Go helper CLI → HTML string → webview | Full Go HTTP server |
| **Assets (CSS/JS/images)** | Paths rewritten to `vscode-webview://` URIs | Served natively over HTTP |
| **JavaScript** | Sandboxed by default — CSP toggle available | Full browser JS — everything works |
| **Navigation / links** | Single page only — links don't navigate | Multi-page routing with real link clicks |
| **HTMX / Alpine / etc.** | ❌ Blocked by default (disable CSP to allow) | ✅ Fully functional |
| **Variable editing** | ✅ Inline sidebar editing → instant re-render | Reads from `.vscode/template-data/` files |
| **Live reload** | Debounced file watcher → re-render webview | SSE push → browser auto-refresh |
| **Data source** | Sidebar variables + linked JSON fixture | Same `.vscode/template-data/` JSON files |
| **Start** | Right-click → "Set As Base Template" | ▶ button in Render Context sidebar |

**Use the Preview Panel** when you're focused on a single template — designing layout, tweaking variables, resolving dependencies. Changes are instant and you never leave VS Code.

**Use the Dev Server** when you need to see things in a real browser — test JavaScript interactions, navigate between pages, verify HTMX endpoints, check responsive design with browser DevTools.

They work together: edit variables and resolve dependencies in the preview, then start the dev server to see the full multi-page experience in your browser. Both share the same data files.

---

## Features

### 🔍 **Accurate Go Template Parsing** (both modes)
- Uses the actual Go `html/template` parser via a bundled helper binary
- True Go template syntax understanding — not regex-based
- Accurate template dependency detection
- Identifies template includes, blocks, and definitions
- 40+ registered stub helper functions (`isLast`, `isFirst`, `seq`, `contains`, `safeHTML`, `dict`, `json`, etc.) so custom-helper templates parse without errors

### 🎨 Preview Panel Features

These features are available when using the in-editor preview:

- **Multi-File Render Context** — Build complex template compositions by adding multiple files, with visual management and auto-restore across sessions
- **Smart Variable Tracking** — Automatically discovers variables, infers types from comparison context (`eq`, `gt`, `le`…), and offers inline editing in the sidebar
- **Live Preview with Asset Support** — Real-time rendering with CSS, JavaScript, and images (paths rewritten for the webview sandbox)
- **Dependency Management** — Visual tree showing required templates with ✅/❌ satisfaction status; click to add missing files
- **Pre-Render Validation** — Type mismatches collected and reported with file:line:column locations in VS Code's Problems panel
- **Export to HTML** — Save rendered output as a standalone static HTML file
- **HTMX Detection** — Detects `hx-get`, `hx-post`, etc. and lists all endpoints with URL, target, swap mode, and trigger

> ⚠️ **Preview limitations:** The webview runs inside VS Code's Content Security Policy sandbox by default. Inline scripts get nonce-gated, and client-side JavaScript frameworks (HTMX, Alpine.js, etc.) will **not** execute. You can disable CSP via `goTemplateViewer.disablePreviewCSP` (a banner shows the current state), or use the Dev Server for full JS support.

### 🖥️ Dev Server Features

These features are available when running the development server:

- **Full Browser Rendering** — Templates render in a real browser with full JavaScript, CSS, and asset support — no sandbox restrictions
- **SSE Live Reload** — File changes push an event to the browser; no manual refresh needed
- **Multi-Page Navigation** — Click links and navigate between pages in the browser
- **Two Server Modes** — automatically chosen based on your workflow:
  - **Context mode**: Uses your preview's render context (entry file + included templates) and auto-discovers all navigable pages in the workspace
  - **Convention mode**: Uses a directory-based structure (`pages/`, `layouts/`, `partials/`, `static/`) with file-system routing
- **Unified Data System** — Server reads from the same `.vscode/template-data/` data files managed by the extension — no duplicate sidecar files
- **Template Server sidebar** — Shows loaded files, discovered pages, watched directories, and server mode (visible only while server is running)
- **Port Fallback** — If the configured port is taken, tries the next 10 ports, then falls back to an OS-assigned free port
- **Status Bar Indicator** — Shows server state and port; click to toggle
- **Convention mode extras**: file-system routing, layout wrapping, navigation tree (`.Site.Pages`), sidecar JSON data

### 💾 **Fixture Management** (shared)
- Save template data as JSON fixtures in `.vscode/template-data/`
- Link data files to specific templates with persistent associations
- Template context metadata (`_templateContext`) saved with data files for auto-restore
- Workspace-relative path-based file naming to avoid collisions between same-named templates in different directories
- Both the preview and dev server read from the same data files

### 🌳 **Dedicated Sidebar Views**
- **Render Context**: Manage entry file, data file link, and included templates
- **Template Variables**: Edit variable values with source tracking, array manipulation (add/duplicate/delete items)
- **Template Dependencies**: Browse and resolve template dependencies with HTMX endpoint visualization
- **Template Server**: View loaded files, discovered pages, and watched directories (visible only when server is running)

### 📝 **Context Menu Integration**
- **"Go Template: Set As Base Template"** — Right-click any template file in the Explorer or editor to open it as the entry template (resets the render context)
- **"Go Template: Add To Template Context"** — Right-click any template file to add it to the current render context without changing the base template (only visible when a preview is active)
- **"Open Go Template Preview"** — Quick-launch from Explorer or editor title bar
- **"Link Data File to Template"** — Right-click in the editor to link a JSON data file

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (⌘+Shift+X / Ctrl+Shift+X)
3. Search for "Go Template Viewer"
4. Click Install

### Prerequisites
The extension includes pre-built Go helper binaries for all major platforms (Windows, macOS, Linux). No additional installation required!

## Usage

### Quick Start — Preview Panel

1. **Open a Go template file** (`.html`, `.tmpl`, `.tpl`, `.gohtml`)
2. **Right-click** the file and select **"Go Template: Set As Base Template"**, or click **"Change Entry File"** in the Render Context sidebar
3. **Add template files** to your render context:
   - Use the **"➕ Add Template File"** button in the sidebar, or
   - **Right-click** another template file and select **"Go Template: Add To Template Context"**
4. **Edit variables** in the Template Variables view
5. **Watch the live preview** update automatically in the VS Code webview panel

> 💡 The preview panel is ideal for designing templates and shaping test data. For pages that rely on JavaScript, HTMX, or multi-page navigation, start the dev server (see below).

### Quick Start — Dev Server

1. **(Optional)** Open a template preview first to set up your render context — the server will use it
2. Click the **▶ play** button in the Render Context sidebar title bar
3. The server starts and the status bar shows the port (e.g., `Server :3000`)
4. Click the **🌐 globe** button to open in your browser
5. Navigate between pages, test JavaScript, verify HTMX — everything works in a real browser
6. Edit any template — the browser auto-refreshes via SSE live reload
7. Click the **⏹ stop** button to shut down the server

> 💡 The dev server shares data with the preview. Variables you set in the sidebar are saved to `.vscode/template-data/` and automatically loaded by the server.

### Working with Multi-File Templates

For templates that use `{{template}}` or `{{block}}`:

1. **Right-click your base template** (e.g., `base.html`) and select **"Go Template: Set As Base Template"**
2. **Right-click content templates** and select **"Go Template: Add To Template Context"** — or use the ➕ button
3. The preview renders with all included files
4. Dependencies view shows which templates are satisfied ✅ or missing ❌

**Example:**
```
base.html contains: {{template "content" .}}
auth.html contains: {{define "content"}}...{{end}}

1. Right-click base.html → "Go Template: Set As Base Template"
2. Right-click auth.html → "Go Template: Add To Template Context"
3. Preview shows the combined result
```

### Managing Template Data

**Edit inline:**
- Click any variable in the Template Variables view
- Enter simple values or JSON objects/arrays
- Use ➕ to add array items, 📋 to duplicate, 🗑️ to delete
- Data auto-saves to `.vscode/template-data/`

**Link a data file:**
- Click **"📄 Data: (none)"** in the Render Context view
- Select a `.json` file with your test data
- Data persists across sessions with full context restore

**Manage data files:**
- **Select existing** — Browse and link an existing JSON file
- **Save current data** — Export current variable values to a new JSON file
- **Unlink** — Remove the data file association (click ✕ on the data file entry)

### Example Template

```html
<!DOCTYPE html>
<html>
<head>
    <title>{{.Title}}</title>
</head>
<body>
    {{template "header" .}}

    <h1>Welcome, {{.User.Name}}!</h1>

    {{if .ShowProjects}}
    <ul>
        {{range .Projects}}
        <li>{{.Name}} - {{.Description}}</li>
        {{end}}
    </ul>
    {{end}}
</body>
</html>
```

### Example Data

```json
{
  "Title": "My Dashboard",
  "User": {
    "Name": "John Doe"
  },
  "ShowProjects": true,
  "Projects": [
    {
      "Name": "Website",
      "Description": "Company website"
    }
  ]
}
```

### Dev Server — Detailed Guide

The dev server runs a full HTTP server using the same Go `html/template` engine. Unlike the preview panel, templates render in a real browser — JavaScript, HTMX, Alpine.js, and all client-side frameworks work normally. It operates in one of two modes, automatically chosen based on whether a preview is active.

#### Starting the Server

1. Click the **▶ play** button in the Render Context sidebar title bar
2. The server starts and the status bar shows the port (e.g., `$(globe) :3000`)
3. Click the **🌐 globe** button to open in your browser
4. Edit any template — the browser auto-refreshes via SSE live reload
5. Click the **⏹ stop** button to shut down the server
6. While running, the **Template Server** sidebar view shows loaded files, discovered pages, and watched directories

> **Port fallback:** If port 3000 is in use, the server automatically tries the next 10 ports (3001–3010), then falls back to a free OS-assigned port. The status bar always shows the actual port.

#### Context Mode (Recommended)

When a template preview is already open, the server uses the **same shared templates** (layout, partials) from the render context and automatically discovers all navigable pages — templates with `{{define "content"}}` — in the workspace. No special directory structure required.

1. Open a template preview as usual (set base template, add files to context, edit variables)
2. Click **▶ play** — the server starts and discovers all page templates in your project
3. Click links in the browser to navigate between pages (e.g., `/dashboard`, `/apps/access`)
4. Each page loads its own data from `.vscode/template-data/` automatically
5. Edit any template or data file — the browser refreshes automatically via SSE

The server classifies your context files:
- **Shared files** (layout/partials): loaded for every page render
- **Page files** (contain `{{define "content"}}`): one is swapped in per URL
- **Discovered pages**: all `.html` files with `{{define "content"}}` in the workspace, not just those in the context

URL routing is based on the file path relative to the `pages/` directory:
- `pages/dashboard.html` → `/dashboard`
- `pages/apps/index.html` → `/apps`
- `pages/apps/access.html` → `/apps/access`

#### Convention Mode

When no preview is active, the server falls back to a convention-based directory structure with file-system routing:

```
my-project/
├── layouts/
│   └── base.html          ← Layout template (wraps all pages)
├── pages/
│   ├── index.html          ← / route
│   ├── index.json          ← Sidecar data for index page
│   ├── about.html          ← /about route
│   └── blog/
│       ├── index.html      ← /blog route
│       └── getting-started.html  ← /blog/getting-started route
├── partials/
│   ├── header.html         ← {{template "header.html" .}}
│   └── footer.html         ← {{template "footer.html" .}}
└── static/
    └── css/
        └── main.css        ← /static/css/main.css
```

In convention mode, every page template receives a `RenderData` object:

```go
.Page.Title        // Page title (from sidecar JSON or auto-generated from filename)
.Page.Path         // Current page URL path
.Page.Data         // Custom data from sidecar JSON file
.Site.Pages        // Auto-generated navigation tree for menus
```

**Navigation tree example:**

```html
<nav>
  {{range .Site.Pages}}
    <a href="{{.Path}}" {{if isActive .Path $.Page.Path}}class="active"{{end}}>
      {{.Title}}
    </a>
  {{end}}
</nav>
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `goTemplateViewer.contentRoot` | `string` | `""` | Root directory for serving static assets (CSS, JS, images) relative to the workspace. Leave empty to use the template file's directory. |
| `goTemplateViewer.serverPagesDir` | `string` | `"pages"` | Pages directory for the dev server. URLs map directly to files in this directory. |
| `goTemplateViewer.serverLayoutsDir` | `string` | `"layouts"` | Layouts directory containing base templates that wrap page content. |
| `goTemplateViewer.serverPartialsDir` | `string` | `"partials"` | Partials directory containing reusable template fragments. |
| `goTemplateViewer.serverStaticDir` | `string` | `"static"` | Static assets directory served at `/static/`. |
| `goTemplateViewer.serverLayoutFile` | `string` | `"base.html"` | Layout filename to use for wrapping page content. |
| `goTemplateViewer.serverIndexFile` | `string` | `""` | Entry page filename for the `/` route. Auto-detected if empty. |
| `goTemplateViewer.serverPort` | `number` | `3000` | Port for the development server. |
| `goTemplateViewer.disablePreviewCSP` | `boolean` | `false` | Disable the Content Security Policy in the preview panel. Allows inline scripts and external resources to run unrestricted — useful for HTMX/Alpine.js testing. ⚠️ Less secure. |

**Example:**

```json
{
  "goTemplateViewer.contentRoot": "static",
  "goTemplateViewer.serverPagesDir": "templates/pages",
  "goTemplateViewer.serverLayoutsDir": "templates/layouts",
  "goTemplateViewer.serverPort": 8080
}
```

## Supported Template Syntax

| Syntax | Example |
|--------|---------|
| **Variables** | `{{.FieldName}}`, `{{.Object.Property}}` |
| **Root access in range** | `{{$.RootVar}}` |
| **Range** | `{{range .Items}}...{{end}}` |
| **Conditionals** | `{{if .Condition}}...{{else if .Other}}...{{else}}...{{end}}` |
| **With** | `{{with .Data}}...{{end}}` |
| **Templates** | `{{template "name" .}}` |
| **Blocks** | `{{block "name" .}}...{{end}}` |
| **Define** | `{{define "name"}}...{{end}}` |
| **Comparisons** | `{{if eq .Type "admin"}}`, `{{if gt .Count 10}}` |
| **Functions** | `{{slice .Name 0 1}}`, `{{len .Items}}`, `{{default "N/A" .Value}}` |

### Built-in Helper Functions

The extension registers these helper functions so templates parse without errors:

`isLast`, `isFirst`, `seq`, `contains`, `hasPrefix`, `hasSuffix`, `replace`, `split`, `join`, `safeHTML`, `safeJS`, `safeCSS`, `safeURL`, `default`, `ternary`, `dict`, `json`, `toJSON`, `fromJSON`, `upper`, `lower`, `title`, `trim`, `trimPrefix`, `trimSuffix`, `repeat`, `plural`, `slug`, `urlize`, `markdownify`, `htmlEscape`, `htmlUnescape`, `add`, `sub`, `mul`, `div`, `mod`, `max`, `min`, `now`, `dateFormat`, `partial`, `partialCached`

## Extension Commands

| Command | Description | Where |
|---------|-------------|-------|
| **Go Template: Set As Base Template** | Set file as the entry template and reset render context | Explorer & editor right-click |
| **Go Template: Add To Template Context** | Add file to the current render context (visible when preview is active) | Explorer & editor right-click |
| **Open Go Template Preview** | Open the template preview panel | Explorer right-click, editor title |
| **Refresh Preview** | Refresh the current preview | Command palette |
| **Go Template: Export to HTML** | Export rendered preview as a static HTML file | Command palette |
| **Change Entry File** | Select the main template to render | Render Context view |
| **Add Template File** | Add a template to the render context via file picker | Render Context view, Dependencies view |
| **Link Data File to Template** | Link a JSON data file to the current template | Editor right-click |
| **Manage Data File** | Select, save, or link a data file | Render Context view |
| **Edit Variable** | Edit a template variable value inline | Template Variables view |
| **Edit JSON Data File** | Open the linked JSON data file in the editor | Template Variables title bar |
| **Remove Data File** | Unlink the data file from the template | Render Context view |
| **Add/Duplicate/Delete Array Item** | Manipulate array entries in template data | Template Variables view |
| **Toggle Dev Server** | Start or stop the development server | Render Context title bar (▶/⏹) |
| **Open in Browser** | Open the running dev server in your default browser | Render Context title bar (🌐) |
| **Show Server Output** | Show the server output channel | Command palette |

## File Types Supported

| Extension | Description |
|-----------|-------------|
| `.html` | HTML templates with Go template syntax |
| `.tmpl` | Go template files |
| `.tpl` | Template files |
| `.gohtml` | Go HTML templates |

## Requirements

- Visual Studio Code 1.105.0 or higher

## Known Issues

- The **preview panel** runs inside a VS Code webview with a Content Security Policy by default. Client-side JavaScript frameworks (HTMX, Alpine.js, etc.) will not execute unless you disable CSP via `goTemplateViewer.disablePreviewCSP` — or use the **dev server** for full JS support
- Complex custom template functions may require data fixtures for full rendering
- Template functions not in the built-in stub list will produce parse warnings (templates still render with available stubs)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Development Setup

```bash
# Clone the repository
git clone https://github.com/bbmumford/go-template-viewer.git
cd go-template-viewer

# Install dependencies
npm install

# Build the Go helper
cd go-helper

# On macOS/Linux:
go build -o ../bin/template-helper

# On Windows:
go build -o ../bin/template-helper.exe

cd ..

# Compile and watch
npm run watch

# Press F5 to launch Extension Development Host
```

## Platform Support

This extension works on:
- ✅ macOS (Intel & Apple Silicon)
- ✅ Windows (x64, x86, ARM64)
- ✅ Linux (x64, ARM64)

The extension automatically detects your platform and uses the correct binary.

## License

MIT License — see the [LICENSE](LICENSE) file for details.

## Support

- 🐛 [Report Issues](https://github.com/bbmumford/go-template-viewer/issues)
- 💡 [Request Features](https://github.com/bbmumford/go-template-viewer/issues/new)
- 📖 [Documentation](https://github.com/bbmumford/go-template-viewer)

## Acknowledgments

Built with:
- Go `html/template` and `text/template/parse` packages
- VS Code Extension API
- TypeScript

---

**Enjoy building with Go templates!** 🚀
