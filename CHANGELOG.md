# Change Log

All notable changes to the Go Template Viewer extension.

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
- [ ] Windows and Linux binary support
- [ ] Custom template function support
- [ ] Template validation and error highlighting
- [ ] Auto-completion for template syntax
- [ ] Dependency graph visualization
- [ ] Export rendered templates as static HTML
- [ ] Template snippets library