# Change Log

All notable changes to the Go Template Viewer extension.

## [0.0.5] - 2026-02-08

### Added
- **Dev Server Mode**: Launch a full development server directly from the sidebar with play/stop buttons. Features include:
  - **Dual Mode Operation**: Automatically selects between context mode (uses the active preview's render context) and convention mode (uses `pages/layouts/partials/` directories) — no configuration required
  - **Context Mode**: When a preview is active, the server renders using the same entry file, shared templates, and linked data — then auto-discovers all navigable pages (files with `{{define "content"}}`) in the workspace so you can click links and navigate between pages. Each page loads its own data from `.vscode/template-data/` automatically
  - **Convention Mode**: File-system routing with URL→file mapping, layout wrapping, partials, and sidecar JSON data
  - **Unified Data System**: Server reads from the same `.vscode/template-data/` data files the extension manages — auto-discovers by matching `_templateContext.entryFile` metadata or filename convention
  - **Port Fallback**: If the configured port is in use, automatically tries the next 10 ports, then falls back to an OS-assigned free port
  - **SSE Live Reload**: File changes automatically refresh the browser via Server-Sent Events
  - **Static File Serving**: Assets served from content root (context mode) or `/static/` directory (convention mode)
  - **Status Bar Indicator**: Shows server state (▶ stopped, spinner starting, 🌐 running with port, ❌ error)
  - **Open in Browser**: Globe button in sidebar title bar when server is running
  - **Output Channel**: Dedicated "Go Template Server" output channel for server logs
  - **Navigation Tree**: Auto-generated `{{.Site.Pages}}` with `isActive`/`isActivePrefix` helpers (convention mode)
- **Template Server Sidebar View**: New "Template Server" tree view in the sidebar, visible only while the dev server is running. Shows:
  - Server mode (context or convention)
  - Entry file, shared templates, and discovered pages (context mode)
  - Pages, layouts, partials, and static directories (convention mode)
  - Data file path (if linked)
- **CSP Toggle Setting**: New `goTemplateViewer.disablePreviewCSP` boolean setting to disable the Content Security Policy in the preview panel. When disabled, inline scripts and external resources (HTMX, Alpine.js, etc.) run without restrictions. A colour-coded banner at the top of the preview shows the current CSP state (🔒 green = enabled, ⚠️ amber = disabled).
- **Server Configuration Settings**: 7 new settings — `serverPagesDir`, `serverLayoutsDir`, `serverPartialsDir`, `serverStaticDir`, `serverLayoutFile`, `serverIndexFile`, `serverPort`
- **Template Helper Functions for Server**: `isActive`, `isActivePrefix`, `safeHTML`, `dict`, `json`, `toJSON`, `upper`, `lower`, `title`, `replace`, `contains`, `hasPrefix`, `hasSuffix`, `split`, `join`, `trim`, `default`, `seq`, `add`, `sub`, `mul`, `div`, `mod`, `len`, `slice`
- **"Add To Template Context" Context Menu**: Right-click any template file in the Explorer or editor and select **"Go Template: Add To Template Context"** to add it to the current render context without changing the base template. Only visible when a preview is already active.
- **"Set As Base Template" Context Menu (editor)**: The "Go Template: Set As Base Template" command now appears in the editor right-click menu in addition to the Explorer context menu.
- **Missing Commands Registered**: `exportHtml`, `changeEntryFile`, `manageDataFile`, `removeTemplateFile`, `editVariable`, `setBaseTemplate`, and `addToContext` are now properly declared in `package.json` — ensuring they appear in menus and the command palette.
- **Content Security Policy**: Webview preview now injects a CSP `<meta>` tag with nonce-based inline script protection for improved security.
- **Shared Utility Module**: Extracted `showTimedNotification()`, `sanitizePathForFilename()`, and `getHelperBinaryName()` into a shared `utils.ts` module, eliminating duplicate code across `extension.ts`, `previewProvider.ts`, and `serverProvider.ts`.
- **Cross-Platform Binaries**: Go helper is now cross-compiled for 6 targets — `windows/amd64`, `windows/arm64`, `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`. The extension auto-detects the platform via `getHelperBinaryName()` and loads the correct binary (e.g., `template-helper-darwin-arm64`). No Go toolchain required at install time.
- **Interactive CSP Banner**: The preview CSP banner now includes a clickable **Settings** link (opens the `disablePreviewCSP` setting via `acquireVsCodeApi().postMessage()`) and a **✕ dismiss** button to hide the banner for the current session.
- **Live Settings Re-Render**: Added `onDidChangeConfiguration` listener — toggling `disablePreviewCSP` or changing `contentRoot` now triggers an immediate preview re-render without needing to manually refresh.

### Fixed
- **Data File Re-Adding After Unlink**: Fixed bug where removing a linked data file would cause it to be automatically re-discovered on the next render cycle. A `dataFileUnlinked` flag now prevents auto-rediscovery after explicit unlink.
- **Wrong Data File for Same-Named Templates**: Fixed bug where templates in different directories with the same base filename (e.g., `admin/base.html` and `public/base.html`) would retrieve each other's data files. Data files now use workspace-relative sanitized paths (e.g., `templates--admin--base.html.json`) instead of just the basename. Legacy basename-format files are still loaded with metadata validation.
- **Synchronous File I/O**: Converted all `fs.existsSync`, `readFileSync`, `writeFileSync`, and `mkdirSync` calls in `previewProvider.ts` to async `fs.promises.*` equivalents to avoid blocking the extension host.
- **Temp File Race Condition**: Temp files for Go helper rendering now use `crypto.randomUUID()` instead of `Date.now()` to prevent collisions under rapid successive renders.
- **Go `strings.Title` Deprecation**: Replaced deprecated `strings.Title()` in `renderer.go` with a custom `titleCase()` function using `unicode.ToTitle`.
- **Unified Command IDs**: All command IDs now consistently use `goTemplateViewer.*` prefix (previously some used `go-template-viewer.*`).
- **Redundant Activation Event**: Removed duplicate `onLanguage:go-template` activation event from `package.json` (auto-generated by VS Code from language contributions).

### Removed
- **Dead Code Cleanup**: Removed unused `goTemplateParser.ts` (regex-based parser superseded by Go binary), `templateDataProvider.ts` (never imported), `HtmxDependenciesProvider` class, `HtmxDetailItem`, `HtmxDependencyItem`, and `SuggestedFragmentItem` classes.
- **Inline `require('path')` Calls**: Replaced 6 inline `require('path')` calls in `templateViewProviders.ts` and 2 in `extension.ts` with top-level `import * as path from 'path'`.
- **Duplicate Server Menu Buttons**: Removed duplicate stop/browser buttons that appeared on both the Render Context and Template Server sidebar views — they now appear only on the Render Context title bar.
- **Template Dependencies Count Badge**: Removed the `(N)` count suffix from the "Template Dependencies" section header in the sidebar for a cleaner look.

### Changed
- **Timed Notifications**: `showTimedNotification()` now uses type-aware prefixes (❌ for errors, ⚠️ for warnings) instead of raw codicon text.
- **Version**: Bumped to 0.0.5.

## [0.0.4] - 2026-01-03

### Added
- **Context Menu Commands**: Right-click on template files in Explorer to:
  - **"Set as Base Template"**: Opens preview with selected file as the entry template (resets context)
  - **"Add to Context"**: Adds file to current render context without changing base template (only visible when preview is active)
- **Numeric Comparison Type Inference**: Variables used in `eq`, `ne`, `gt`, `lt`, `ge`, `le` comparisons with number literals (e.g., `{{if eq .SessionTimeout 30}}`, `{{if gt .TotalPages 1}}`) are now correctly inferred as "number" type with proper default values
- **ChainNode Variable Extraction**: Root-level variables accessed via `$` inside range blocks (e.g., `{{eq $.CurrentContext.ID .ID}}`) are now properly extracted as top-level variables instead of being prefixed with the array path
- **Pre-Render Validation**: Template data is validated against template expectations before rendering - all type mismatches are collected and reported together instead of failing on the first error (skips fields inside range/with blocks to avoid false positives)
- **Enhanced Error Display**: Error preview now shows all errors in a formatted list with file:line:column locations, hints for fixing type mismatches, and resolves template names (like "content") to their actual source files
- **Flexible Type Comparison Functions**: Custom `eq`, `ne`, `lt`, `le`, `gt`, `ge` functions that automatically coerce JSON `float64` to match Go `int` template literals - fixes "incompatible types for comparison" errors caused by JSON number parsing
- **Safe `slice` Function**: The `slice` helper now handles empty strings and out-of-range indices gracefully, returning an empty string instead of panicking (e.g., `{{slice .Name 0 1}}` on empty Name works)

### Fixed
- **`isLast` Helper Signature**: Fixed `isLast` function to accept `(index, slice)` instead of `(index, length)` - now works correctly with `{{if isLast $index $.Items}}` pattern
- **Number Type Default Values**: `suggestValue()` now returns `0` for number types and `false` for boolean types instead of empty strings, preventing "incompatible types for comparison" errors
- **Numeric Comparison Rendering**: Templates using `{{gt .Field 90}}` or similar numeric comparisons no longer fail with type mismatch errors
- **Type Mismatch Auto-Correction**: When loading existing data files, any string values are automatically converted to proper types (numbers, booleans) when template usage indicates a non-string type - fixes persistent "incompatible types" errors from old data files
- **Notification Display**: Removed raw codicon text (`$(error)`, `$(info)`) from auto-dismissing notifications - messages now display cleanly
- **Startup Notification**: The "Go Template Viewer is ready!" welcome message now auto-dismisses after 5 seconds instead of requiring manual dismissal
- **Template Name Resolution in Errors**: Errors referencing defined template names like "content" are now mapped to their actual source files in both the Problems panel and error preview
- **JSON Number Type Handling**: Fixed fundamental issue where JSON-parsed numbers (`float64`) couldn't be compared with Go template integer literals - all comparison operations now handle type coercion automatically

## [0.0.3] - 2025-12-18

### Added
- **Template Context Persistence**: Data files now save `_templateContext` metadata including entry file, included files list, and selected template - context is automatically restored when reopening a linked data file
- **Context Restore on Load**: When opening a template with a linked data file, the render context (all included template files) is automatically restored from saved metadata
- **Intelligent Array Population**: Arrays in range blocks now auto-populate with actual comparison values from template logic (e.g., `{{range .AuthMethods}}{{if eq . "google"}}` now suggests `["google", "microsoftonline", "github", "email"]` instead of empty objects)
- **HTMX Endpoint Visualization**: Flat list view of all HTMX requests showing type (hx-get, hx-post), URL, target, swap mode, and trigger
- **Export to HTML**: Command and toolbar button to export rendered preview as static HTML file with "Save As" dialog (only visible when preview successfully renders)
- **Template Error Diagnostics**: Template syntax errors now appear in VS Code's Problems panel with clickable file:line:column references for quick navigation
- **Dependency Source Display**: Satisfied template dependencies now show the filename that provides them (e.g., "title ✅ base.html" instead of just "title ✅ template")
- **Custom Helper Function Support**: Analyzer now registers 40+ stub functions (`isLast`, `isFirst`, `seq`, `contains`, `safeHTML`, `dict`, `json`, etc.) so templates using custom helpers can be parsed without "function not defined" errors
- **Extended Renderer Helpers**: Added real implementations for `isLast`, `isFirst`, `seq`, `contains`, `hasPrefix`, `hasSuffix`, `replace`, `split`, `join`, `safeHTML`, `safeJS`, `safeCSS`, `safeURL`, `default`, `ternary`

### Fixed
- **Type Conflict Handling**: `setDeep()` now gracefully handles type conflicts when merging variables - if a path segment is a primitive (string/number) but nested properties are needed, the operation is skipped with a warning instead of crashing with "Cannot create property 'X' on string" TypeError
- **`eq`/`ne` Comparison Type Inference**: Fixed critical bug where variables used in `eq` or `ne` comparisons with string literals (e.g., `{{if eq .CurrentContext.Type "personal"}}`) were incorrectly inferred as "object" type instead of "string", causing "incompatible types for comparison" errors at render time
- **Nested Path Type Inference**: Fixed type inference for dotted paths like `.User.Name` - leaf values are now correctly typed as "string" instead of "object"
- **Suggested Value Structure**: Fixed `suggestValue()` to not create incorrectly nested object structures that caused double-nesting in template data
- **Data File Removal**: Fixed issue where removing data file didn't refresh the UI, causing it to reappear
- **String Literal Extraction**: Template parser now extracts string literals from `eq`, `ne` comparisons within range blocks to intelligently populate arrays
- **Export Button Visibility**: Export button now only appears when template successfully renders, hiding on errors
- **Export Button Location**: Moved export button from webview content to editor tab toolbar (next to split/3-dots menu)

### Changed
- **Auto-Dismissing Notifications**: All info/warning/error notifications now auto-dismiss after 5 seconds instead of persisting until manually closed
- **Data File Format**: JSON data files now include a `_templateContext` field with `entryFile`, `includedFiles` (workspace-relative paths), `selectedTemplate`, and `lastSaved` timestamp
- **Simplified File Picker Labels**: All file selection dialogs now show "Select File" instead of verbose action descriptions
- **Simplified HTMX Display**: Removed misleading fragment satisfaction tracking and suggestions - all HTMX items now show as flat, non-collapsible list with basic endpoint info
- **Removed Fragment Suggestions**: Eliminated automatic fragment path suggestions (fragments/, partials/, etc.) that showed non-existent directories
- **Smart Variable Suggestions**: `suggestValue()` now checks for range block string literals before falling back to generic type-based suggestions
- **Error Handling**: Template errors now create diagnostics that auto-clear on successful render
- **Context Menu Restrictions**: "Add Template File" button only appears for HTMX HTML fragment endpoints, not server actions
- **Reduced Console Noise**: Removed verbose console.log statements for cleaner development experience
- **Performance Optimization**: Added 150ms debouncing to `analyzeAndRender()` to prevent rapid consecutive calls when adding multiple template files

### Removed
- **HTMX Fragment Tracking**: Removed `IsHTMLFragment`, `Satisfied`, and `SuggestedFragments` fields that attempted to guess fragment requirements without route analysis
- **Fragment Detection Logic**: Removed `isLikelyHTMLEndpoint()` and `suggestFragmentFiles()` functions that made inaccurate assumptions
- **Collapsible HTMX Items**: HTMX requests no longer expand to show detail items - all info shown inline for cleaner, more honest UX

## [0.0.2] - 2025-11-21

### Fixed
- **Auto-include Template Dependencies**: Templates that satisfy required dependencies (like `{{template "content"}}`) are now automatically included in the render context, fixing "no such template" errors
- **Windows Compatibility**: Fixed binary path resolution to use `.exe` extension on Windows
- **Windows File Picker**: Simplified file dialog filters to show all files by default on Windows, fixing issue where template files weren't visible in the file explorer
- **Cross-Platform Build Instructions**: Updated error messages and documentation with platform-specific build commands

### Changed
- File picker now defaults to showing all files for better Windows compatibility
- Template analysis now performs a second pass after auto-including dependencies to capture all variables
- File dialog filters now show "Template Files" with "All Files" fallback for better compatibility
- Binary detection now platform-aware (template-helper vs template-helper.exe)
- Updated README with explicit Windows build instructions

## [0.0.1] - 2025-10-31

### Initial Release

#### Features
- **Multi-File Render Context**: Build complex template compositions by managing multiple template files
- **Accurate Go Template Parsing**: Uses actual Go `html/template` parser for true syntax understanding
- **Live Preview**: Real-time rendering with full CSS/JavaScript/image support
- **Smart Variable Tracking**: Automatic variable discovery with source file tracking
- **Dependency Management**: Visual dependency tree showing required and missing templates
- **Fixture Management**: Save and load template data as JSON fixtures
- **Three Sidebar Views**:
  - Render Context: Manage entry file, data file, and included templates
  - Template Variables: Edit variables with inline JSON support
  - Template Dependencies: Browse and resolve template dependencies

#### Supported Template Syntax
- Variables: `{{.Field}}`
- Range: `{{range .Items}}...{{end}}`
- Conditionals: `{{if .Condition}}...{{end}}`
- Templates: `{{template "name" .}}`
- Blocks: `{{block "name" .}}...{{end}}`
- Define: `{{define "name"}}...{{end}}`

#### File Types
- `.html`, `.tmpl`, `.tpl`, `.gohtml`

#### Configuration
- `goTemplateViewer.contentRoot`: Set static asset directory

---
