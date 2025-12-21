package main

import (
	"bytes"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"reflect"
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
		// Array/slice helpers - accept (index, slice) to check position
		"isLast": func(i int, slice interface{}) bool {
			v := reflect.ValueOf(slice)
			if v.Kind() == reflect.Slice || v.Kind() == reflect.Array {
				return i == v.Len()-1
			}
			return false
		},
		"isFirst": func(i int) bool { return i == 0 },
		"len": func(v interface{}) int {
			rv := reflect.ValueOf(v)
			switch rv.Kind() {
			case reflect.Slice, reflect.Array, reflect.Map, reflect.String, reflect.Chan:
				return rv.Len()
			default:
				return 0
			}
		},
		"seq": func(start, end int) []int {
			var result []int
			for i := start; i <= end; i++ {
				result = append(result, i)
			}
			return result
		},
		// String helpers
		"contains":  strings.Contains,
		"hasPrefix": strings.HasPrefix,
		"hasSuffix": strings.HasSuffix,
		"replace":   strings.ReplaceAll,
		"split":     strings.Split,
		"join":      strings.Join,
		// Safe HTML output
		"safeHTML": func(s string) template.HTML { return template.HTML(s) },
		"safeJS":   func(s string) template.JS { return template.JS(s) },
		"safeCSS":  func(s string) template.CSS { return template.CSS(s) },
		"safeURL":  func(s string) template.URL { return template.URL(s) },
		// Default value helper
		"default": func(defaultVal, val interface{}) interface{} {
			if val == nil || val == "" || val == 0 || val == false {
				return defaultVal
			}
			return val
		},
		// Conditional helpers
		"ternary": func(cond bool, trueVal, falseVal interface{}) interface{} {
			if cond {
				return trueVal
			}
			return falseVal
		},
	}
}
