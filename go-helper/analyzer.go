package main

import (
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template/parse"
)

// TemplateGraph represents the complete analysis result
type TemplateGraph struct {
	EntryFile    string              `json:"entryFile"`
	Templates    map[string]*TmplDef `json:"templates"`
	Variables    []Variable          `json:"variables"`
	Dependencies []Dependency        `json:"dependencies"`
	Htmx         *HtmxInfo           `json:"htmx,omitempty"`
}

// HtmxDependency represents an HTMX request dependency
type HtmxDependency struct {
	Type     string `json:"type"`     // "hx-get", "hx-post", etc.
	URL      string `json:"url"`      // The endpoint URL
	Target   string `json:"target"`   // hx-target value
	Swap     string `json:"swap"`     // hx-swap value
	Trigger  string `json:"trigger"`  // hx-trigger value
	FilePath string `json:"filePath"` // Source file
	Line     int    `json:"line"`     // Line number
	Context  string `json:"context"`  // Surrounding context
}

// HtmxInfo contains HTMX analysis results
type HtmxInfo struct {
	Detected     bool              `json:"detected"`
	Version      string            `json:"version,omitempty"`
	Dependencies []*HtmxDependency `json:"dependencies"`
}

// TmplDef represents a defined template
type TmplDef struct {
	Name     string   `json:"name"`
	FilePath string   `json:"filePath"`
	IsBlock  bool     `json:"isBlock"`
	Calls    []string `json:"calls"` // templates it calls
}

// Variable represents an extracted variable path
type Variable struct {
	Path      string      `json:"path"`    // e.g., "User.Name"
	Type      string      `json:"type"`    // inferred: "string", "bool", "object", "array"
	Context   string      `json:"context"` // "if", "with", "range", "field"
	FilePath  string      `json:"filePath"`
	Suggested interface{} `json:"suggested,omitempty"` // example value
}

// Dependency represents a template dependency
type Dependency struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "template", "block", "define"
	FilePath string `json:"filePath,omitempty"`
	Required bool   `json:"required"`
}

// TemplateAnalyzer analyzes Go templates
type TemplateAnalyzer struct {
	workspace     string
	templates     map[string]*TmplDef
	variables     map[string]*Variable
	dependencies  map[string]*Dependency
	seenFiles     map[string]bool
	htmxInfo      *HtmxInfo
	rangeLiterals map[string][]string // Maps array path to string literals found in its range block
}

// getAnalyzerFuncs returns stub functions so the analyzer can parse templates
// that use custom helper functions. These don't need real implementations -
// they just need to exist so parsing succeeds.
func getAnalyzerFuncs() template.FuncMap {
	// Stub function that accepts any number of args and returns empty interface
	stub := func(args ...interface{}) interface{} { return nil }
	stubBool := func(args ...interface{}) bool { return false }
	stubInt := func(args ...interface{}) int { return 0 }
	stubStr := func(args ...interface{}) string { return "" }
	stubSlice := func(args ...interface{}) []int { return nil }

	return template.FuncMap{
		// Math helpers
		"add": stubInt, "sub": stubInt, "mul": stubInt, "div": stubInt, "mod": stubInt,
		// String helpers
		"upper": stubStr, "lower": stubStr, "title": stubStr, "trim": stubStr,
		"contains": stubBool, "hasPrefix": stubBool, "hasSuffix": stubBool,
		"replace": stubStr, "split": stub, "join": stubStr,
		// Array/slice helpers
		"isLast": stubBool, "isFirst": stubBool, "seq": stubSlice,
		// Safe output helpers
		"safeHTML": stub, "safeJS": stub, "safeCSS": stub, "safeURL": stub,
		// Conditional helpers
		"default": stub, "ternary": stub,
		// Common additional helpers users might have
		"dict": stub, "list": stub, "slice": stub, "append": stub,
		"now": stub, "date": stubStr, "dateFormat": stubStr,
		"json": stubStr, "jsonify": stubStr, "toJSON": stubStr,
		"html": stubStr, "urlquery": stubStr, "printf": stubStr,
		"first": stub, "last": stub, "rest": stub, "reverse": stub,
		"sort": stub, "uniq": stub, "shuffle": stub,
		"len": stubInt, "isset": stubBool, "empty": stubBool,
		"pluralize": stubStr, "singularize": stubStr,
		"markdown": stub, "markdownify": stub,
		"truncate": stubStr, "wordwrap": stubStr,
		"attr": stub, "class": stubStr,
	}
}

func NewTemplateAnalyzer(workspace string) *TemplateAnalyzer {
	return &TemplateAnalyzer{
		workspace:     workspace,
		templates:     make(map[string]*TmplDef),
		variables:     make(map[string]*Variable),
		dependencies:  make(map[string]*Dependency),
		seenFiles:     make(map[string]bool),
		htmxInfo:      &HtmxInfo{Dependencies: []*HtmxDependency{}},
		rangeLiterals: make(map[string][]string),
	}
}

func (a *TemplateAnalyzer) Analyze(entryFile string, files []string) (*TemplateGraph, error) {
	// Parse the entry template
	if err := a.analyzeFile(entryFile); err != nil {
		return nil, err
	}

	// Scan either specific files or entire workspace
	if len(files) > 0 {
		// Analyze only the specified files
		for _, filePath := range files {
			if err := a.analyzeFile(filePath); err != nil {
				// Log but don't fail on individual files
				fmt.Fprintf(os.Stderr, "Warning: failed to analyze %s: %v\n", filePath, err)
			}
		}
	} else {
		// Scan workspace for other templates (auto-discover)
		if err := a.scanWorkspace(); err != nil {
			return nil, err
		}
	}

	// Convert maps to slices and deduplicate redundant variables
	// Priority: eq-number, eq-string, gt-number (comparison contexts) > generic contexts
	vars := make([]Variable, 0, len(a.variables))

	// First, collect all array item field paths (e.g., "ArrayName[0].FieldName")
	arrayItemFields := make(map[string]bool)
	arrayNames := make(map[string]bool)

	for _, v := range a.variables {
		if strings.Contains(v.Path, "[0].") {
			// Extract just the field name after [0].
			parts := strings.SplitN(v.Path, "[0].", 2)
			if len(parts) == 2 {
				arrayItemFields[parts[1]] = true
			}
			// Also extract the array name (before [0])
			arrayName := strings.Split(v.Path, "[0]")[0]
			if arrayName != "" {
				arrayNames[arrayName] = true
			}
		} else if v.Type == "array" {
			// Track top-level arrays
			arrayNames[v.Path] = true
		}
	}

	// Deduplicate by path, giving priority to specific comparison contexts
	// This ensures that if a variable appears in both {{eq .Field 30}} and {{.Field}},
	// we use the type from the comparison (number) not generic extraction (string)
	pathToVar := make(map[string]*Variable)
	priorityContexts := map[string]int{
		"eq-number":        10, // Highest priority - explicit numeric comparison
		"gt-number":        10,
		"eq-string":        9, // String comparison
		"range-collection": 8, // Array being ranged over
		"range":            5, // Inside a range
		"if":               3,
		"with":             3,
		"template":         2,
		"chain":            1, // $.X access
		"":                 0, // Generic/default
	}

	for _, v := range a.variables {
		existing, exists := pathToVar[v.Path]
		if !exists {
			varCopy := *v
			pathToVar[v.Path] = &varCopy
		} else {
			// Compare priorities - higher priority wins
			existingPriority := priorityContexts[existing.Context]
			newPriority := priorityContexts[v.Context]
			if newPriority > existingPriority {
				varCopy := *v
				pathToVar[v.Path] = &varCopy
			}
		}
	}

	// Recalculate suggested values for arrays now that all item fields are known
	// This ensures arrays with item fields get object suggestions, not string literals
	for path, v := range pathToVar {
		if v.Type == "array" {
			// Check if this array has item fields
			hasItemFields := false
			for otherPath := range pathToVar {
				if strings.HasPrefix(otherPath, path+"[0].") {
					hasItemFields = true
					break
				}
			}
			if hasItemFields {
				// Override suggested value to be array of objects
				v.Suggested = []map[string]interface{}{{}}
			}
		}
	}

	// Now collect variables, skipping any that are redundant
	for _, v := range pathToVar {
		skip := false

		// Never skip array variables that are the range collection itself
		if v.Context == "range-collection" && v.Type == "array" {
			skip = false // Keep these
		} else if !strings.Contains(v.Path, "[0].") && !strings.Contains(v.Path, ".") {
			// Skip standalone fields that are already represented as array item fields
			// e.g., if we have "BrandApps[0].Domain", skip standalone "Domain"
			// This is a top-level field name
			if arrayItemFields[v.Path] {
				// Skip it - it's already represented as an array item field
				skip = true
			}
			// Also skip if this field name matches an array name
			// (prevents "Domain" array when we have "BrandApps[0].Domain")
			if arrayNames[v.Path] && v.Type == "array" {
				// Check if this is a real array or a mistakenly typed field
				hasItemFields := false
				for fieldName := range arrayItemFields {
					if strings.HasPrefix(fieldName, v.Path+"[0].") || fieldName == v.Path {
						hasItemFields = true
						break
					}
				}
				if !hasItemFields {
					// This array has no corresponding item fields, might be spurious
					skip = true
				}
			}
		}

		if !skip {
			vars = append(vars, *v)
		}
	}

	deps := make([]Dependency, 0, len(a.dependencies))
	for _, d := range a.dependencies {
		deps = append(deps, *d)
	}

	// Set HTMX detected flag
	if len(a.htmxInfo.Dependencies) > 0 || a.htmxInfo.Version != "" {
		a.htmxInfo.Detected = true
	}

	// Check HTMX dependency satisfaction - see if suggested fragments are in included files
	includedFileSet := make(map[string]bool)
	for _, f := range files {
		includedFileSet[f] = true
	}

	return &TemplateGraph{
		EntryFile:    entryFile,
		Templates:    a.templates,
		Variables:    vars,
		Dependencies: deps,
		Htmx:         a.htmxInfo,
	}, nil
}

func (a *TemplateAnalyzer) analyzeFile(filePath string) error {
	if a.seenFiles[filePath] {
		return nil
	}
	a.seenFiles[filePath] = true

	content, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}

	contentStr := string(content)

	// Detect HTMX usage
	a.detectHtmx(filePath, contentStr)

	// Parse the template with helper function stubs so parsing doesn't fail
	tmpl, err := template.New(filepath.Base(filePath)).Funcs(getAnalyzerFuncs()).Parse(contentStr)
	if err != nil {
		return fmt.Errorf("parse error in %s: %v", filePath, err)
	}

	// Walk the parse tree
	for _, t := range tmpl.Templates() {
		if t.Tree == nil || t.Tree.Root == nil {
			continue
		}

		def := &TmplDef{
			Name:     t.Name(),
			FilePath: filePath,
			Calls:    []string{},
		}

		a.walkNode(t.Tree.Root, filePath, def, "")
		a.templates[t.Name()] = def
	}

	return nil
}

func (a *TemplateAnalyzer) walkNode(node parse.Node, filePath string, def *TmplDef, context string) {
	if node == nil {
		return
	}

	switch n := node.(type) {
	case *parse.ListNode:
		if n != nil {
			for _, child := range n.Nodes {
				a.walkNode(child, filePath, def, context)
			}
		}

	case *parse.IfNode:
		// If statements inherit parent context (e.g., if inside range keeps range context)
		a.walkPipe(n.Pipe, filePath, context)
		a.walkNode(n.List, filePath, def, context)
		if n.ElseList != nil {
			a.walkNode(n.ElseList, filePath, def, context)
		}

	case *parse.RangeNode:
		// Get the array variable name from the pipe FIRST
		arrayPath := ""
		if n.Pipe != nil && len(n.Pipe.Cmds) > 0 {
			for _, cmd := range n.Pipe.Cmds {
				for _, arg := range cmd.Args {
					if field, ok := arg.(*parse.FieldNode); ok && len(field.Ident) > 0 {
						arrayPath = strings.Join(field.Ident, ".")
						break
					}
				}
				if arrayPath != "" {
					break
				}
			}
		}

		// Extract string literals from this range block BEFORE processing the pipe
		// This ensures the literals are available when we create the variable
		if arrayPath != "" {
			a.extractRangeLiterals(n.List, arrayPath)
		}

		// NOW extract the array variable with special "range-collection" context
		// At this point, rangeLiterals[arrayPath] is populated
		a.walkPipe(n.Pipe, filePath, "range-collection")

		// Pass "range:ArrayName" as context so children know they're inside this array
		rangeContext := "range"
		if arrayPath != "" {
			rangeContext = "range:" + arrayPath
		}

		// Everything inside range should have range context with array name
		a.walkNode(n.List, filePath, def, rangeContext)
		if n.ElseList != nil {
			a.walkNode(n.ElseList, filePath, def, rangeContext)
		}

	case *parse.WithNode:
		a.walkPipe(n.Pipe, filePath, "with")
		a.walkNode(n.List, filePath, def, "with")
		if n.ElseList != nil {
			a.walkNode(n.ElseList, filePath, def, "with")
		}

	case *parse.TemplateNode:
		// Found a {{template "name" .}} call
		templateName := n.Name
		def.Calls = append(def.Calls, templateName)

		a.dependencies[templateName] = &Dependency{
			Name:     templateName,
			Type:     "template",
			Required: true,
		}

		a.walkPipe(n.Pipe, filePath, "template")

	case *parse.ActionNode:
		// Preserve parent context (e.g., range, if, with)
		a.walkPipe(n.Pipe, filePath, context)

	case *parse.BranchNode:
		a.walkPipe(n.Pipe, filePath, "branch")
		a.walkNode(n.List, filePath, def, context)
		if n.ElseList != nil {
			a.walkNode(n.ElseList, filePath, def, context)
		}
	}
}

func (a *TemplateAnalyzer) walkPipe(pipe *parse.PipeNode, filePath, context string) {
	if pipe == nil {
		return
	}

	for _, cmd := range pipe.Cmds {
		// Check if this is a comparison function - we want to capture the literal
		// so we can properly type the variable and suggest values
		if len(cmd.Args) >= 3 {
			if ident, ok := cmd.Args[0].(*parse.IdentifierNode); ok {
				switch ident.Ident {
				case "eq", "ne":
					// String comparison - look for field + string literal pairs
					a.extractEqComparison(cmd.Args[1:], filePath, context)
					continue
				case "gt", "lt", "ge", "le":
					// Numeric comparison - look for field + number literal pairs
					a.extractNumericComparison(cmd.Args[1:], filePath, context)
					continue
				}
			}
		}

		// Standard variable extraction for non-comparison calls
		for _, arg := range cmd.Args {
			a.extractVariables(arg, filePath, context)
		}
	}
}

// extractEqComparison handles eq/ne function calls to properly type variables
// When we see {{eq .Field "value"}}, we know .Field should be a string with suggested value "value"
func (a *TemplateAnalyzer) extractEqComparison(args []parse.Node, filePath, context string) {
	var fields []*parse.FieldNode
	var chainNodes []*parse.ChainNode
	var stringLiterals []string
	var numberLiterals []int64

	// Collect all field nodes, chain nodes, string literals, and number literals from the comparison
	for _, arg := range args {
		switch n := arg.(type) {
		case *parse.FieldNode:
			fields = append(fields, n)
		case *parse.ChainNode:
			chainNodes = append(chainNodes, n)
		case *parse.StringNode:
			stringLiterals = append(stringLiterals, n.Text)
		case *parse.NumberNode:
			if n.IsInt {
				numberLiterals = append(numberLiterals, n.Int64)
			} else if n.IsFloat {
				numberLiterals = append(numberLiterals, int64(n.Float64))
			}
		case *parse.PipeNode:
			// Recursively handle nested pipes
			a.walkPipe(n, filePath, context)
		}
	}

	// Determine the comparison type based on what literals we found
	isNumericComparison := len(numberLiterals) > 0 && len(stringLiterals) == 0

	// For each field being compared, extract with appropriate type
	for _, field := range fields {
		path := strings.Join(field.Ident, ".")
		if path == "" {
			continue
		}

		// Handle range context prefix
		if strings.HasPrefix(context, "range:") {
			arrayName := strings.TrimPrefix(context, "range:")
			path = arrayName + "[0]." + path
		} else if context == "range" {
			continue // Skip if we can't determine array name
		}

		if isNumericComparison {
			// Numeric comparison: eq .Field 30
			key := path + "::eq-number"
			if _, exists := a.variables[key]; !exists {
				suggested := int64(0)
				if len(numberLiterals) > 0 {
					suggested = numberLiterals[0]
				}

				a.variables[key] = &Variable{
					Path:      path,
					Type:      "number",
					Context:   "eq-number",
					FilePath:  filePath,
					Suggested: suggested,
				}
			}
		} else {
			// String comparison: eq .Field "value"
			key := path + "::eq-string"
			if _, exists := a.variables[key]; !exists {
				suggested := ""
				if len(stringLiterals) > 0 {
					suggested = stringLiterals[0]
				}

				a.variables[key] = &Variable{
					Path:      path,
					Type:      "string",
					Context:   "eq-string",
					FilePath:  filePath,
					Suggested: suggested,
				}
			}
		}
	}

	// Handle chain nodes (like $.CurrentContext.ID) - these are root-level even in range context
	for _, chain := range chainNodes {
		// ChainNode has a base Node and Field slice
		if len(chain.Field) > 0 {
			// Build the path from the chain fields
			path := strings.Join(chain.Field, ".")

			if isNumericComparison {
				key := path + "::eq-number"
				if _, exists := a.variables[key]; !exists {
					suggested := int64(0)
					if len(numberLiterals) > 0 {
						suggested = numberLiterals[0]
					}

					a.variables[key] = &Variable{
						Path:      path,
						Type:      "number",
						Context:   "eq-number",
						FilePath:  filePath,
						Suggested: suggested,
					}
				}
			} else {
				// Chain nodes with $ prefix are root-level, so don't add range prefix
				key := path + "::eq-string"
				if _, exists := a.variables[key]; !exists {
					suggested := ""
					if len(stringLiterals) > 0 {
						suggested = stringLiterals[0]
					}

					a.variables[key] = &Variable{
						Path:      path,
						Type:      "string",
						Context:   "eq-string",
						FilePath:  filePath,
						Suggested: suggested,
					}
				}
			}
		}
	}

	// Also extract any remaining variables that weren't handled above
	for _, arg := range args {
		if _, ok := arg.(*parse.FieldNode); !ok {
			if _, ok := arg.(*parse.StringNode); !ok {
				if _, ok := arg.(*parse.ChainNode); !ok {
					if _, ok := arg.(*parse.NumberNode); !ok {
						a.extractVariables(arg, filePath, context)
					}
				}
			}
		}
	}
}

// extractNumericComparison handles gt/lt/ge/le function calls to properly type variables
// When we see {{gt .Field 10}}, we know .Field should be a number with suggested value 10
func (a *TemplateAnalyzer) extractNumericComparison(args []parse.Node, filePath, context string) {
	var fields []*parse.FieldNode
	var numberLiterals []int64

	// Collect all field nodes and number literals from the comparison
	for _, arg := range args {
		switch n := arg.(type) {
		case *parse.FieldNode:
			fields = append(fields, n)
		case *parse.NumberNode:
			if n.IsInt {
				numberLiterals = append(numberLiterals, n.Int64)
			} else if n.IsFloat {
				// Treat floats as integers for suggestion purposes
				numberLiterals = append(numberLiterals, int64(n.Float64))
			}
		case *parse.PipeNode:
			// Recursively handle nested pipes
			a.walkPipe(n, filePath, context)
		}
	}

	// For each field being compared, use the number literal as suggested value
	for _, field := range fields {
		path := strings.Join(field.Ident, ".")
		if path == "" {
			continue
		}

		// Handle range context prefix
		if strings.HasPrefix(context, "range:") {
			arrayName := strings.TrimPrefix(context, "range:")
			path = arrayName + "[0]." + path
		} else if context == "range" {
			continue // Skip if we can't determine array name
		}

		// Use "gt-number" context to indicate this is a numeric comparison
		key := path + "::gt-number"
		if _, exists := a.variables[key]; !exists {
			// Use the first number literal as suggested value, or 0
			var suggested int64 = 0
			if len(numberLiterals) > 0 {
				suggested = numberLiterals[0]
			}

			a.variables[key] = &Variable{
				Path:      path,
				Type:      "number", // Always number when compared with gt/lt/ge/le
				Context:   "gt-number",
				FilePath:  filePath,
				Suggested: suggested,
			}
		}
	}

	// Also extract any remaining variables that weren't numeric comparisons
	for _, arg := range args {
		if _, ok := arg.(*parse.FieldNode); !ok {
			if _, ok := arg.(*parse.NumberNode); !ok {
				a.extractVariables(arg, filePath, context)
			}
		}
	}
}

func (a *TemplateAnalyzer) extractVariables(node parse.Node, filePath, context string) {
	switch n := node.(type) {
	case *parse.FieldNode:
		// e.g., .User.Name
		path := strings.Join(n.Ident, ".")
		if path != "" {
			// Check if we're inside a range with an array name
			if strings.HasPrefix(context, "range:") {
				// Extract the array name from context
				arrayName := strings.TrimPrefix(context, "range:")
				// Prefix the field path with ArrayName[0].
				path = arrayName + "[0]." + path
				context = "range" // Normalize context for type inference
			} else if context == "range" {
				// Inside a range but we couldn't determine the array name
				// Skip this variable to avoid incorrect top-level extraction
				return
			}

			key := path + "::" + context
			if _, exists := a.variables[key]; !exists {
				varType := a.inferType(context, path)
				suggested := a.suggestValue(varType, path)

				a.variables[key] = &Variable{
					Path:      path,
					Type:      varType,
					Context:   context,
					FilePath:  filePath,
					Suggested: suggested,
				}
			}
		}

	case *parse.VariableNode:
		// e.g., $var
		for _, ident := range n.Ident {
			key := "$" + ident + "::" + context
			if _, exists := a.variables[key]; !exists {
				a.variables[key] = &Variable{
					Path:     "$" + ident,
					Type:     "variable",
					Context:  context,
					FilePath: filePath,
				}
			}
		}

	case *parse.ChainNode:
		// Chain nodes like $.CurrentContext.ID have a base node and field chain
		// The $ means root context, so we extract the field path without range prefix
		if len(n.Field) > 0 {
			path := strings.Join(n.Field, ".")
			if path != "" {
				// Chain nodes ($.X) are always root-level, even inside range blocks
				key := path + "::chain"
				if _, exists := a.variables[key]; !exists {
					varType := a.inferType("chain", path)
					suggested := a.suggestValue(varType, path)

					a.variables[key] = &Variable{
						Path:      path,
						Type:      varType,
						Context:   "chain",
						FilePath:  filePath,
						Suggested: suggested,
					}
				}
			}
		}
		// Also process the base node
		a.extractVariables(n.Node, filePath, context)

	case *parse.PipeNode:
		for _, cmd := range n.Cmds {
			for _, arg := range cmd.Args {
				a.extractVariables(arg, filePath, context)
			}
		}
	}
}

// extractRangeLiterals extracts string literals from comparison operations in a range block
// This helps populate arrays with meaningful test data (e.g., ["google", "github", "email"])
func (a *TemplateAnalyzer) extractRangeLiterals(node parse.Node, arrayPath string) {
	if node == nil {
		return
	}

	switch n := node.(type) {
	case *parse.ListNode:
		if n != nil {
			for _, child := range n.Nodes {
				a.extractRangeLiterals(child, arrayPath)
			}
		}
	case *parse.IfNode:
		// Check for eq comparisons in the pipe
		a.extractLiteralsFromPipe(n.Pipe, arrayPath)
		a.extractRangeLiterals(n.List, arrayPath)
		if n.ElseList != nil {
			a.extractRangeLiterals(n.ElseList, arrayPath)
		}
	case *parse.ActionNode:
		a.extractLiteralsFromPipe(n.Pipe, arrayPath)
	case *parse.BranchNode:
		a.extractLiteralsFromPipe(n.Pipe, arrayPath)
		a.extractRangeLiterals(n.List, arrayPath)
		if n.ElseList != nil {
			a.extractRangeLiterals(n.ElseList, arrayPath)
		}
	case *parse.RangeNode:
		// Don't recurse into nested ranges
		return
	}
}

// extractLiteralsFromPipe finds string literals in eq/ne comparisons
func (a *TemplateAnalyzer) extractLiteralsFromPipe(pipe *parse.PipeNode, arrayPath string) {
	if pipe == nil {
		return
	}

	for _, cmd := range pipe.Cmds {
		// Look for eq, ne functions with string arguments
		if len(cmd.Args) > 0 {
			if ident, ok := cmd.Args[0].(*parse.IdentifierNode); ok {
				if ident.Ident == "eq" || ident.Ident == "ne" {
					// Extract string literals from the arguments
					for _, arg := range cmd.Args[1:] {
						if str, ok := arg.(*parse.StringNode); ok {
							// Found a string literal
							literals := a.rangeLiterals[arrayPath]
							// Avoid duplicates
							found := false
							for _, existing := range literals {
								if existing == str.Text {
									found = true
									break
								}
							}
							if !found {
								a.rangeLiterals[arrayPath] = append(literals, str.Text)
							}
						}
					}
				}
			}
		}
	}
}

func (a *TemplateAnalyzer) inferType(context, path string) string {
	// Context tells us WHERE the variable appears, not necessarily its type
	// We should infer type from the path structure AND the usage context

	switch context {
	case "eq-string":
		// Variable is compared with eq to a string literal - it's a string
		return "string"
	case "range":
		// Variables accessed inside a range block are fields of the array item
		// Check if this is an array item field (e.g., "BrandApps[0].Domain")
		if strings.Contains(path, "[0].") {
			// This is a field within an array item - infer from structure
			// If it has more dots after [0]., it's a nested object field
			afterArrayIndex := path[strings.Index(path, "[0].")+4:]
			if strings.Contains(afterArrayIndex, ".") {
				return "object"
			}
			// Simple field within array item
			return "string"
		}
		// Shouldn't reach here, but default to string
		return "string"
	case "range-collection":
		// Special case: the collection being ranged over
		return "array"
	case "if", "with":
		// Variables in if/with are tested for truthiness
		// If path has a dot, it's accessing a nested field - but the LEAF value
		// is likely a string/bool, not an object. Only mark as object if it's
		// clearly used as one (e.g., passed to template, has fields accessed from it)
		// For now, default to string for leaf fields
		return "string"
	case "template":
		// Variable passed to a template call - likely an object being passed as context
		if strings.Contains(path, ".") {
			// Nested path - the leaf is what's being passed
			return "string"
		}
		// Top-level variable passed to template is usually an object
		return "object"
	default:
		// Field access in output context (e.g., {{.User.Name}})
		// The leaf value is what gets rendered - typically a string
		return "string"
	}
}

func (a *TemplateAnalyzer) suggestValue(varType, path string) interface{} {
	switch varType {
	case "array":
		// Check if this array has item fields (e.g., path[0].Field)
		// If so, we need to return an array of objects, not strings
		hasItemFields := false
		for key := range a.variables {
			if strings.HasPrefix(key, path+"[0].") {
				hasItemFields = true
				break
			}
		}

		if hasItemFields {
			// Array items are objects with fields - return empty object
			// The fields will be populated by setDeep in the extension
			return []map[string]interface{}{
				{},
			}
		}

		// Check if we collected string literals for this array from range comparisons
		// This is for simple arrays like {{range .Tags}}{{if eq . "featured"}}
		if literals, ok := a.rangeLiterals[path]; ok && len(literals) > 0 {
			// Return array of the actual string values found in comparisons
			result := make([]interface{}, len(literals))
			for i, lit := range literals {
				result[i] = lit
			}
			return result
		}
		// Generate a minimal array with one empty item to allow iteration
		return []map[string]interface{}{
			{},
		}
	case "object":
		// Return an empty object - the structure will be built by setDeep in the extension
		// based on the actual path. Don't try to pre-build nested structures here
		// as that causes double-nesting issues.
		return map[string]interface{}{}
	case "number":
		// Return 0 as default numeric value
		return 0
	case "bool":
		// Return false as default boolean value
		return false
	default:
		// For strings and other types, return empty string as placeholder
		return ""
	}
}

func (a *TemplateAnalyzer) scanWorkspace() error {
	return filepath.WalkDir(a.workspace, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			// Skip hidden directories and common ignore patterns
			name := d.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist" {
				return fs.SkipDir
			}
			return nil
		}

		// Check if it's a template file
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".html" || ext == ".tmpl" || ext == ".tpl" || ext == ".gohtml" {
			if !a.seenFiles[path] {
				// Analyze this template file too
				_ = a.analyzeFile(path) // Best effort
			}
		}

		return nil
	})
}

// detectHtmx scans HTML content for HTMX attributes and dependencies
func (a *TemplateAnalyzer) detectHtmx(filePath string, content string) {
	lines := strings.Split(content, "\n")

	// Check for HTMX script inclusion
	if strings.Contains(content, "htmx.org") || strings.Contains(content, "unpkg.com/htmx") {
		a.htmxInfo.Detected = true
		// Try to extract version
		versionRe := regexp.MustCompile(`htmx\.org@([0-9.]+)`)
		if match := versionRe.FindStringSubmatch(content); len(match) > 1 {
			a.htmxInfo.Version = match[1]
		}
	}

	// HTMX attribute patterns to detect
	htmxAttrs := []string{
		"hx-get", "hx-post", "hx-put", "hx-delete", "hx-patch",
	}

	for lineNum, line := range lines {
		for _, attr := range htmxAttrs {
			// Pattern: hx-get="/some/url" or hx-get="{{.SomeVar}}"
			pattern := regexp.MustCompile(attr + `\s*=\s*["']([^"']+)["']`)
			matches := pattern.FindAllStringSubmatch(line, -1)

			for _, match := range matches {
				if len(match) < 2 {
					continue
				}

				url := match[1]
				dep := &HtmxDependency{
					Type:     attr,
					URL:      url,
					FilePath: filePath,
					Line:     lineNum + 1,
				}

				// Get context: look at current line and surrounding lines for multi-line attributes
				contextStart := lineNum - 3
				if contextStart < 0 {
					contextStart = 0
				}
				contextEnd := lineNum + 4
				if contextEnd > len(lines) {
					contextEnd = len(lines)
				}
				contextLines := strings.Join(lines[contextStart:contextEnd], " ")

				// Extract hx-target if present in context
				targetRe := regexp.MustCompile(`hx-target\s*=\s*["']([^"']+)["']`)
				if targetMatch := targetRe.FindStringSubmatch(contextLines); len(targetMatch) > 1 {
					dep.Target = targetMatch[1]
				}

				// Extract hx-swap if present in context
				swapRe := regexp.MustCompile(`hx-swap\s*=\s*["']([^"']+)["']`)
				if swapMatch := swapRe.FindStringSubmatch(contextLines); len(swapMatch) > 1 {
					dep.Swap = swapMatch[1]
				}

				// Extract hx-trigger if present in context
				triggerRe := regexp.MustCompile(`hx-trigger\s*=\s*["']([^"']+)["']`)
				if triggerMatch := triggerRe.FindStringSubmatch(contextLines); len(triggerMatch) > 1 {
					dep.Trigger = triggerMatch[1]
				}

				// Get some context (trimmed line)
				dep.Context = strings.TrimSpace(line)
				if len(dep.Context) > 100 {
					dep.Context = dep.Context[:97] + "..."
				}

				a.htmxInfo.Dependencies = append(a.htmxInfo.Dependencies, dep)
				a.htmxInfo.Detected = true
			}
		}
	}
}
