# Change Log

All notable changes to the Go Template Viewer extension.

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

## Future Releases

### Planned Features
- [ ] Custom template function support
- [ ] Template validation and error highlighting
- [ ] Auto-completion for template syntax
- [ ] Dependency graph visualization
- [ ] Export rendered templates as static HTML
- [ ] Template snippets library
- [ ] HTMX endpoint integration improvements