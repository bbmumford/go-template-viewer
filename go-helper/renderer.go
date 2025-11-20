package main

import (
	"bytes"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"strings"
)

// TemplateRenderer handles template rendering
type TemplateRenderer struct {
	workspace string
}

func NewTemplateRenderer(workspace string) *TemplateRenderer {
	return &TemplateRenderer{
		workspace: workspace,
	}
}

func (r *TemplateRenderer) Render(entryFile string, data map[string]interface{}, templateName string, files []string) (string, error) {
	// Create a new template with helpful functions
	tmpl := template.New("").Funcs(r.getTemplateFuncs())

	// Load template files - either specific files or all in workspace
	if len(files) > 0 {
		// Load only the specified files
		if err := r.loadSpecificTemplates(tmpl, files); err != nil {
			return "", err
		}
	} else {
		// Load all template files in workspace (auto-discover)
		if err := r.loadTemplates(tmpl); err != nil {
			return "", err
		}
	}

	// Parse entry file with its basename as the template name
	entryName := filepath.Base(entryFile)
	content, err := os.ReadFile(entryFile)
	if err != nil {
		return "", err
	}

	entryTmpl, err := tmpl.New(entryName).Parse(string(content))
	if err != nil {
		return "", fmt.Errorf("parse error: %v", err)
	}

	// Determine which template to execute
	var targetTmpl *template.Template
	if templateName != "" {
		// Look for specific template by name
		targetTmpl = tmpl.Lookup(templateName)
		if targetTmpl == nil {
			return "", fmt.Errorf("template '%s' not found", templateName)
		}
	} else {
		// Use entry template
		targetTmpl = entryTmpl
	}

	// Render using the target template
	var buf bytes.Buffer
	if err := targetTmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render error: %v", err)
	}

	return buf.String(), nil
}

func (r *TemplateRenderer) loadTemplates(tmpl *template.Template) error {
	return filepath.WalkDir(r.workspace, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist" {
				return filepath.SkipDir
			}
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".html" || ext == ".tmpl" || ext == ".tpl" || ext == ".gohtml" {
			content, err := os.ReadFile(path)
			if err != nil {
				return nil // Skip files we can't read
			}

			// Parse as associated template
			name := filepath.Base(path)
			_, err = tmpl.New(name).Parse(string(content))
			if err != nil {
				// Log but don't fail
				fmt.Fprintf(os.Stderr, "Warning: failed to parse %s: %v\n", path, err)
			}
		}

		return nil
	})
}

func (r *TemplateRenderer) loadSpecificTemplates(tmpl *template.Template, files []string) error {
	for _, path := range files {
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read %s: %v", path, err)
		}

		// Parse as associated template using basename
		name := filepath.Base(path)
		_, err = tmpl.New(name).Parse(string(content))
		if err != nil {
			return fmt.Errorf("failed to parse %s: %v", path, err)
		}
	}
	return nil
}

func (r *TemplateRenderer) getTemplateFuncs() template.FuncMap {
	return template.FuncMap{
		// Add common helper functions
		"add": func(a, b int) int { return a + b },
		"sub": func(a, b int) int { return a - b },
		"mul": func(a, b int) int { return a * b },
		"div": func(a, b int) int {
			if b == 0 {
				return 0
			}
			return a / b
		},
		"mod": func(a, b int) int {
			if b == 0 {
				return 0
			}
			return a % b
		},
		"upper": strings.ToUpper,
		"lower": strings.ToLower,
		"title": strings.Title,
		"trim":  strings.TrimSpace,
	}
}
