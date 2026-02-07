package main

import (
	"bytes"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"text/template/parse"
	"unicode"
)

// ValidationError represents a single validation error with location info
type ValidationError struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Message string `json:"message"`
	Path    string `json:"path"` // Variable path like "Security.SessionTimeout"
}

// TemplateRenderer handles template rendering
type TemplateRenderer struct {
	workspace string
}

func NewTemplateRenderer(workspace string) *TemplateRenderer {
	return &TemplateRenderer{
		workspace: workspace,
	}
}

// ValidateData checks for type mismatches between template expectations and actual data
// Returns a list of all validation errors found
func (r *TemplateRenderer) ValidateData(entryFile string, data map[string]interface{}, files []string) []ValidationError {
	var errors []ValidationError

	// Parse templates to find comparison operations
	tmpl := template.New("").Funcs(r.getTemplateFuncs())

	// Load template files
	if len(files) > 0 {
		for _, path := range files {
			content, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			tmpl.New(filepath.Base(path)).Parse(string(content))
		}
	}

	// Load entry file
	content, err := os.ReadFile(entryFile)
	if err != nil {
		return errors
	}
	entryName := filepath.Base(entryFile)
	tmpl.New(entryName).Parse(string(content))

	// Check each template for comparison operations
	for _, t := range tmpl.Templates() {
		if t.Tree == nil || t.Tree.Root == nil {
			continue
		}

		fileName := t.Name()
		// Find the actual file path for this template
		filePath := ""
		if fileName == entryName {
			filePath = entryFile
		} else {
			for _, f := range files {
				if filepath.Base(f) == fileName {
					filePath = f
					break
				}
			}
		}
		if filePath == "" {
			filePath = fileName
		}

		// Walk the parse tree looking for comparisons
		// Pass empty context path - fields inside range blocks will be skipped
		r.validateNode(t.Tree.Root, data, filePath, "", &errors)
	}

	return errors
}

// validateNode recursively checks nodes for type mismatches
// contextPath tracks if we're inside a range (non-empty means skip field validation)
func (r *TemplateRenderer) validateNode(node parse.Node, data map[string]interface{}, filePath, contextPath string, errors *[]ValidationError) {
	if node == nil {
		return
	}

	switch n := node.(type) {
	case *parse.ListNode:
		if n != nil {
			for _, child := range n.Nodes {
				r.validateNode(child, data, filePath, contextPath, errors)
			}
		}
	case *parse.ActionNode:
		if n.Pipe != nil {
			r.validatePipe(n.Pipe, data, filePath, contextPath, errors)
		}
	case *parse.IfNode:
		if n.Pipe != nil {
			r.validatePipe(n.Pipe, data, filePath, contextPath, errors)
		}
		r.validateNode(n.List, data, filePath, contextPath, errors)
		r.validateNode(n.ElseList, data, filePath, contextPath, errors)
	case *parse.RangeNode:
		// Extract the array being ranged over to set context
		rangeContext := r.extractRangeContext(n.Pipe)
		if n.Pipe != nil {
			r.validatePipe(n.Pipe, data, filePath, contextPath, errors)
		}
		// Inside the range body, fields like .DeviceType refer to array items, not root
		r.validateNode(n.List, data, filePath, rangeContext, errors)
		r.validateNode(n.ElseList, data, filePath, rangeContext, errors)
	case *parse.WithNode:
		// With changes context too
		withContext := r.extractWithContext(n.Pipe)
		if n.Pipe != nil {
			r.validatePipe(n.Pipe, data, filePath, contextPath, errors)
		}
		r.validateNode(n.List, data, filePath, withContext, errors)
		r.validateNode(n.ElseList, data, filePath, contextPath, errors)
	case *parse.TemplateNode:
		if n.Pipe != nil {
			r.validatePipe(n.Pipe, data, filePath, contextPath, errors)
		}
	}
}

// extractRangeContext gets the array path being ranged over
func (r *TemplateRenderer) extractRangeContext(pipe *parse.PipeNode) string {
	if pipe == nil || len(pipe.Cmds) == 0 {
		return "range"
	}
	for _, cmd := range pipe.Cmds {
		for _, arg := range cmd.Args {
			if field, ok := arg.(*parse.FieldNode); ok {
				return strings.Join(field.Ident, ".")
			}
		}
	}
	return "range"
}

// extractWithContext gets the object path being accessed with "with"
func (r *TemplateRenderer) extractWithContext(pipe *parse.PipeNode) string {
	if pipe == nil || len(pipe.Cmds) == 0 {
		return "with"
	}
	for _, cmd := range pipe.Cmds {
		for _, arg := range cmd.Args {
			if field, ok := arg.(*parse.FieldNode); ok {
				return strings.Join(field.Ident, ".")
			}
		}
	}
	return "with"
}

// validatePipe checks a pipe for comparison operations with type mismatches
func (r *TemplateRenderer) validatePipe(pipe *parse.PipeNode, data map[string]interface{}, filePath, contextPath string, errors *[]ValidationError) {
	if pipe == nil {
		return
	}

	for _, cmd := range pipe.Cmds {
		if len(cmd.Args) < 2 {
			continue
		}

		// Check if this is a comparison function
		funcName := ""
		if ident, ok := cmd.Args[0].(*parse.IdentifierNode); ok {
			funcName = ident.Ident
		}

		// Handle eq, ne, lt, le, gt, ge comparisons
		isComparison := funcName == "eq" || funcName == "ne" ||
			funcName == "lt" || funcName == "le" ||
			funcName == "gt" || funcName == "ge"

		if !isComparison {
			continue
		}

		// Find field nodes and literal types in the comparison
		var fieldPaths []string
		var fieldNodes []*parse.FieldNode
		var isChainNode []bool // Track if it's a $.Field (root access) vs .Field
		hasNumberLiteral := false
		hasStringLiteral := false

		for _, arg := range cmd.Args[1:] {
			switch a := arg.(type) {
			case *parse.FieldNode:
				fieldPaths = append(fieldPaths, strings.Join(a.Ident, "."))
				fieldNodes = append(fieldNodes, a)
				isChainNode = append(isChainNode, false)
			case *parse.ChainNode:
				// $.Field - root level access even inside range
				if len(a.Field) > 0 {
					fieldPaths = append(fieldPaths, strings.Join(a.Field, "."))
					fieldNodes = append(fieldNodes, nil)
					isChainNode = append(isChainNode, true)
				}
			case *parse.NumberNode:
				hasNumberLiteral = true
			case *parse.StringNode:
				hasStringLiteral = true
			}
		}

		// Check each field's actual type against expected type
		for i, fieldPath := range fieldPaths {
			// Skip validation for fields inside range/with context unless they use $. notation
			// This prevents false positives for .DeviceType inside {{range .ActiveSessions}}
			if contextPath != "" && !isChainNode[i] {
				continue
			}

			actualValue := r.getNestedValue(data, fieldPath)
			actualType := reflect.TypeOf(actualValue)
			actualTypeStr := "nil"
			if actualType != nil {
				actualTypeStr = actualType.Kind().String()
			}

			// Determine expected type based on comparison
			var expectedType string
			var typeMismatch bool

			if hasNumberLiteral && !hasStringLiteral {
				expectedType = "number"
				// Check if actual value is numeric
				if actualType != nil {
					kind := actualType.Kind()
					isNumeric := kind == reflect.Int || kind == reflect.Int8 || kind == reflect.Int16 ||
						kind == reflect.Int32 || kind == reflect.Int64 || kind == reflect.Uint ||
						kind == reflect.Uint8 || kind == reflect.Uint16 || kind == reflect.Uint32 ||
						kind == reflect.Uint64 || kind == reflect.Float32 || kind == reflect.Float64
					typeMismatch = !isNumeric
				} else {
					typeMismatch = true
				}
			} else if hasStringLiteral && !hasNumberLiteral {
				expectedType = "string"
				if actualType != nil {
					typeMismatch = actualType.Kind() != reflect.String
				} else {
					typeMismatch = true
				}
			}

			if typeMismatch && expectedType != "" {
				line := 0
				col := 0
				if fieldNodes[i] != nil {
					// Get position from node
					pos := int(fieldNodes[i].Position())
					line, col = r.posToLineCol(filePath, pos)
				}

				*errors = append(*errors, ValidationError{
					File:   filePath,
					Line:   line,
					Column: col,
					Message: fmt.Sprintf("type mismatch in %s comparison: .%s has type %s but comparing with %s literal",
						funcName, fieldPath, actualTypeStr, expectedType),
					Path: fieldPath,
				})
			}
		}
	}
}

// getNestedValue retrieves a nested value from a map using dot notation
func (r *TemplateRenderer) getNestedValue(data map[string]interface{}, path string) interface{} {
	parts := strings.Split(path, ".")
	var current interface{} = data

	for _, part := range parts {
		if m, ok := current.(map[string]interface{}); ok {
			current = m[part]
		} else {
			return nil
		}
	}
	return current
}

// posToLineCol converts a byte position to line and column numbers
func (r *TemplateRenderer) posToLineCol(filePath string, pos int) (int, int) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return 1, 1
	}

	line := 1
	col := 1
	for i := 0; i < pos && i < len(content); i++ {
		if content[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
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
		// Override comparison functions to handle JSON float64 vs int comparisons
		// JSON unmarshals all numbers as float64, but template literals like 30 are int
		"eq": flexibleEq,
		"ne": flexibleNe,
		"lt": flexibleLt,
		"le": flexibleLe,
		"gt": flexibleGt,
		"ge": flexibleGe,

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
		"title": func(s string) string {
			prev := ' '
			return strings.Map(func(r rune) rune {
				if unicode.IsSpace(rune(prev)) || unicode.IsPunct(rune(prev)) {
					prev = r
					return unicode.ToTitle(r)
				}
				prev = r
				return r
			}, s)
		},
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
		// Safe slice function that handles out-of-range indices gracefully
		"slice": func(item interface{}, indices ...int) interface{} {
			v := reflect.ValueOf(item)
			if !v.IsValid() {
				return ""
			}

			var start, end int
			switch len(indices) {
			case 1:
				start = 0
				end = indices[0]
			case 2:
				start = indices[0]
				end = indices[1]
			default:
				return item
			}

			switch v.Kind() {
			case reflect.String:
				s := v.String()
				if start < 0 {
					start = 0
				}
				if end > len(s) {
					end = len(s)
				}
				if start >= end || start >= len(s) {
					return ""
				}
				return s[start:end]
			case reflect.Slice, reflect.Array:
				length := v.Len()
				if start < 0 {
					start = 0
				}
				if end > length {
					end = length
				}
				if start >= end || start >= length {
					return reflect.MakeSlice(v.Type(), 0, 0).Interface()
				}
				return v.Slice(start, end).Interface()
			default:
				return item
			}
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

// toFloat64 converts numeric types to float64 for comparison
func toFloat64(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	default:
		return 0, false
	}
}

// flexibleEq compares values with type coercion for numbers
func flexibleEq(a, b interface{}) bool {
	// Try numeric comparison first
	aNum, aIsNum := toFloat64(a)
	bNum, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return aNum == bNum
	}
	// Fall back to reflect.DeepEqual for other types
	return reflect.DeepEqual(a, b)
}

// flexibleNe is the inverse of flexibleEq
func flexibleNe(a, b interface{}) bool {
	return !flexibleEq(a, b)
}

// flexibleLt compares values with type coercion for numbers
func flexibleLt(a, b interface{}) bool {
	aNum, aIsNum := toFloat64(a)
	bNum, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return aNum < bNum
	}
	// For strings
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return aStr < bStr
	}
	return false
}

// flexibleLe compares values with type coercion for numbers
func flexibleLe(a, b interface{}) bool {
	aNum, aIsNum := toFloat64(a)
	bNum, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return aNum <= bNum
	}
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return aStr <= bStr
	}
	return false
}

// flexibleGt compares values with type coercion for numbers
func flexibleGt(a, b interface{}) bool {
	aNum, aIsNum := toFloat64(a)
	bNum, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return aNum > bNum
	}
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return aStr > bStr
	}
	return false
}

// flexibleGe compares values with type coercion for numbers
func flexibleGe(a, b interface{}) bool {
	aNum, aIsNum := toFloat64(a)
	bNum, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return aNum >= bNum
	}
	aStr, aIsStr := a.(string)
	bStr, bIsStr := b.(string)
	if aIsStr && bIsStr {
		return aStr >= bStr
	}
	return false
}
