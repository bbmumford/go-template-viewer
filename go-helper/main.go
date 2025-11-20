package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	inspectCmd := flag.NewFlagSet("inspect", flag.ExitOnError)
	inspectEntry := inspectCmd.String("entry", "", "Entry template file")
	inspectWorkspace := inspectCmd.String("workspace", ".", "Workspace directory")
	inspectFiles := inspectCmd.String("files", "", "Comma-separated list of template files to include (if empty, auto-discover)")

	renderCmd := flag.NewFlagSet("render", flag.ExitOnError)
	renderEntry := renderCmd.String("entry", "", "Entry template file")
	renderData := renderCmd.String("data", "", "JSON data file or inline JSON")
	renderWorkspace := renderCmd.String("workspace", ".", "Workspace directory")
	renderTemplate := renderCmd.String("template", "", "Specific template name to render (optional)")
	renderFiles := renderCmd.String("files", "", "Comma-separated list of template files to include (if empty, auto-discover)")

	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s <command> [options]\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Commands:\n")
		fmt.Fprintf(os.Stderr, "  inspect  - Analyze template and output dependency graph\n")
		fmt.Fprintf(os.Stderr, "  render   - Render template with data\n")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "inspect":
		inspectCmd.Parse(os.Args[2:])
		if *inspectEntry == "" {
			fmt.Fprintf(os.Stderr, "Error: -entry flag is required\n")
			os.Exit(1)
		}
		if err := runInspect(*inspectEntry, *inspectWorkspace, *inspectFiles); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

	case "render":
		renderCmd.Parse(os.Args[2:])
		if *renderEntry == "" {
			fmt.Fprintf(os.Stderr, "Error: -entry flag is required\n")
			os.Exit(1)
		}
		if err := runRender(*renderEntry, *renderData, *renderWorkspace, *renderTemplate, *renderFiles); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func runInspect(entryFile, workspace, filesArg string) error {
	// Parse file list if provided
	var files []string
	if filesArg != "" {
		files = strings.Split(filesArg, ",")
		for i := range files {
			files[i] = strings.TrimSpace(files[i])
		}
	}

	analyzer := NewTemplateAnalyzer(workspace)
	graph, err := analyzer.Analyze(entryFile, files)
	if err != nil {
		return err
	}

	output, err := json.MarshalIndent(graph, "", "  ")
	if err != nil {
		return err
	}

	fmt.Println(string(output))
	return nil
}

func runRender(entryFile, dataSource, workspace, templateName, filesArg string) error {
	renderer := NewTemplateRenderer(workspace)

	var data map[string]interface{}
	if dataSource != "" {
		// Try to load as file first
		fileData, err := os.ReadFile(dataSource)
		if err == nil {
			if err := json.Unmarshal(fileData, &data); err != nil {
				return fmt.Errorf("invalid JSON in file: %v", err)
			}
		} else {
			// Try to parse as inline JSON
			if err := json.Unmarshal([]byte(dataSource), &data); err != nil {
				return fmt.Errorf("invalid JSON data: %v", err)
			}
		}
	}

	// Parse files list if provided
	var files []string
	if filesArg != "" {
		files = strings.Split(filesArg, ",")
		for i := range files {
			files[i] = strings.TrimSpace(files[i])
		}
	}

	output, err := renderer.Render(entryFile, data, templateName, files)
	if err != nil {
		return err
	}

	fmt.Print(output)
	return nil
}
