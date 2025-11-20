import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TemplateData, TemplateAnalysisResult, TemplateVariable, TemplateDependency, TemplateDefinition, HtmxDependency, HtmxInfo } from './types';

const execFileAsync = promisify(execFile);

export class GoTemplatePreviewProvider {
    private static readonly viewType = 'goTemplatePreview';
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private currentFile: vscode.Uri | undefined;
    private templateData: TemplateData = {};
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private onDataChangeCallback?: (variables: TemplateVariable[], dataFilePath?: string, dependencies?: TemplateDependency[], htmxInfo?: HtmxInfo) => void;
    private currentDataFilePath?: string;
    private templates: TemplateDefinition[] = [];
    private selectedTemplate?: string;
    private includedFiles: Set<string> = new Set(); // Files included in render context

    constructor(private context: vscode.ExtensionContext) {}

    onDataChange(callback: (variables: TemplateVariable[], dataFilePath?: string, dependencies?: TemplateDependency[], htmxInfo?: HtmxInfo) => void) {
        this.onDataChangeCallback = callback;
    }
    
    public getTemplates(): TemplateDefinition[] {
        return this.templates;
    }
    
    public getIncludedFiles(): string[] {
        return Array.from(this.includedFiles);
    }

    public getTemplateData(): any {
        return this.templateData;
    }

    public getCurrentFile(): string | undefined {
        return this.currentFile?.fsPath;
    }

    public setTemplateData(data: any) {
        this.templateData = data;
        this.saveTemplateData(data);
        this.analyzeAndRender();
    }
    
    public async addTemplateFile(filePath: string) {
        console.log('Adding template file:', filePath);
        this.includedFiles.add(filePath);
        console.log('Included files now:', Array.from(this.includedFiles));
        console.log('Panel exists:', !!this.panel, 'Current file:', this.currentFile?.fsPath);
        // Re-analyze and render with new file included
        await this.analyzeAndRender();
    }
    
    public async removeTemplateFile(filePath: string) {
        this.includedFiles.delete(filePath);
        // Re-analyze and render without this file
        await this.analyzeAndRender();
    }
    
    public setSelectedTemplate(templateName?: string) {
        this.selectedTemplate = templateName;
        // Re-render with the selected template
        this.analyzeAndRender();
    }

    public async openPreview(fileUri: vscode.Uri, resetContext: boolean = true) {
        const isNewPreview = !this.panel;
        
        console.log('openPreview called:', {
            file: fileUri.fsPath,
            resetContext,
            isNewPreview,
            existingIncludedFiles: Array.from(this.includedFiles),
            currentFile: this.currentFile?.fsPath
        });
        
        // Only reset context if explicitly requested or opening new preview
        if (resetContext || isNewPreview) {
            this.currentFile = fileUri;
            this.includedFiles.clear();
            this.includedFiles.add(fileUri.fsPath);
            console.log('Reset context - includedFiles now:', Array.from(this.includedFiles));
        }
        
        // Create or show the webview panel
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            // If panel exists but we're changing entry file, update and re-render
            if (resetContext && fileUri.fsPath !== this.currentFile?.fsPath) {
                this.currentFile = fileUri;
                this.includedFiles.clear();
                this.includedFiles.add(fileUri.fsPath);
                await this.analyzeAndRender();
            }
        } else {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            const contentRoot = this.getContentRoot(workspaceFolder);
            
            // Set up local resource roots
            const localResourceRoots = [
                vscode.Uri.file(path.dirname(fileUri.fsPath)),
                this.context.extensionUri
            ];

            // Add content root if configured
            if (contentRoot) {
                localResourceRoots.push(vscode.Uri.file(contentRoot));
            }

            // Add workspace folder
            if (workspaceFolder) {
                localResourceRoots.push(workspaceFolder.uri);
            }

            this.panel = vscode.window.createWebviewPanel(
                GoTemplatePreviewProvider.viewType,
                'Go Template Preview',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    localResourceRoots: localResourceRoots
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.disposeWatcher();
                vscode.commands.executeCommand('setContext', 'goTemplatePreviewActive', false);
            }, null, this.disposables);
        }

        // Set context for views
        vscode.commands.executeCommand('setContext', 'goTemplatePreviewActive', true);

        // Setup file watcher for live reload
        this.setupFileWatcher();

        // Analyze template and update preview
        await this.analyzeAndRender();
    }

    private getContentRoot(workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
        const config = vscode.workspace.getConfiguration('goTemplateViewer');
        const contentRoot = config.get<string>('contentRoot');
        
        if (contentRoot && workspaceFolder) {
            return path.join(workspaceFolder.uri.fsPath, contentRoot);
        }
        
        return undefined;
    }

    private setupFileWatcher() {
        this.disposeWatcher();
        
        if (!this.currentFile) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        if (!workspaceFolder) {
            return;
        }

        // Watch for changes in template files
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, '**/*.{html,tmpl,tpl,gohtml}')
        );

        this.fileWatcher.onDidChange(() => {
            this.analyzeAndRender();
        });

        this.fileWatcher.onDidCreate(() => {
            this.analyzeAndRender();
        });

        this.fileWatcher.onDidDelete(() => {
            this.analyzeAndRender();
        });
    }

    private disposeWatcher() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }
    }

    private async analyzeAndRender() {
        console.log('analyzeAndRender called - Panel:', !!this.panel, 'CurrentFile:', this.currentFile?.fsPath);
        
        if (!this.panel || !this.currentFile) {
            console.log('analyzeAndRender: Skipping - no panel or current file');
            return;
        }

        console.log('analyzeAndRender called for:', this.currentFile.fsPath);

        try {
            // Load saved template data if exists
            await this.loadTemplateData();

            console.log('Template data before render:', JSON.stringify(this.templateData, null, 2));

            // Call Go helper to analyze template
            const analysis = await this.analyzeTemplate(this.currentFile.fsPath);
            
            console.log('Analysis result:', JSON.stringify(analysis, null, 2));
            
            // Store templates for selection
            if (analysis.templates) {
                this.templates = Object.values(analysis.templates);
            }
            
            // Get all variables for analysis
            const allVars = analysis.variables || [];
            console.log(`Total variables found: ${allVars.length}`);
            
            // If template data is empty AND we have no linked data file, initialize with suggested values
            // This only happens on first load or when explicitly reset
            if (Object.keys(this.templateData).length === 0 && !this.currentDataFilePath) {
                console.log('Initializing empty template data with suggested values');
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    if (variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                    }
                }
            } else if (!this.currentDataFilePath) {
                // No linked data file - rebuild from scratch to match current templates
                console.log('No data file linked - rebuilding template data from current templates');
                this.templateData = {};
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    if (variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                    }
                }
            } else {
                // Template data exists with linked file - merge in any NEW variables from newly added templates
                console.log('Merging new variables into existing template data');
                let hasNewVariables = false;
                
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    const currentValue = this.getDeep(this.templateData, path);
                    
                    // Only add if variable doesn't exist yet and we have a suggested value
                    if (currentValue === undefined && variable.suggested !== undefined) {
                        console.log(`Adding new variable: ${path}`);
                        this.setDeep(this.templateData, path, variable.suggested);
                        hasNewVariables = true;
                    }
                }
                
                // Save the updated data if we added new variables
                if (hasNewVariables) {
                    await this.saveTemplateData(this.templateData);
                }
            }
            
            // Notify listeners about variables and dependencies
            if (this.onDataChangeCallback) {
                this.onDataChangeCallback(allVars, this.currentDataFilePath, analysis.dependencies || [], analysis.htmx);
            }

            // Render the template (with selected template if specified)
            const rendered = await this.renderTemplate(this.currentFile.fsPath, this.templateData, this.selectedTemplate);
            
            console.log('Rendered HTML length:', rendered.length);

            // Update webview with rendered HTML
            this.panel.webview.html = this.processHtmlForWebview(rendered);
            
        } catch (error) {
            console.error('Error analyzing and rendering:', error);
            vscode.window.showErrorMessage(`Error: ${error}`);
            this.panel.webview.html = this.getErrorHtml(String(error));
        }
    }

    private async analyzeTemplate(templatePath: string): Promise<TemplateAnalysisResult> {
        const helperPath = path.join(this.context.extensionPath, 'bin', 'template-helper');
        
        // Check if helper exists
        if (!fs.existsSync(helperPath)) {
            throw new Error('Go template helper not found. Please build it first: cd go-helper && go build -o ../bin/template-helper');
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile!);
        const cwd = workspaceFolder?.uri.fsPath || path.dirname(templatePath);

        try {
            // Build args array for execFile (safe from injection)
            const args = ['inspect', '-entry', templatePath, '-workspace', cwd];
            
            // Pass the included files explicitly
            const includedFilesArray = Array.from(this.includedFiles);
            if (includedFilesArray.length > 0) {
                const filesArg = includedFilesArray.join(',');
                args.push('-files', filesArg);
                console.log('Analyzing with files:', includedFilesArray);
            }
            
            const { stdout, stderr } = await execFileAsync(helperPath, args, { cwd });
            
            if (stderr && stderr.trim()) {
                // Check if stderr contains actual errors (not just warnings)
                if (stderr.toLowerCase().includes('error') || stderr.toLowerCase().includes('fatal')) {
                    console.error('Helper error output:', stderr);
                    throw new Error(`Template analysis failed: ${stderr}`);
                } else {
                    console.warn('Helper warnings:', stderr);
                }
            }

            return JSON.parse(stdout);
        } catch (error: any) {
            console.error('Error running helper:', error);
            if (error.stderr) {
                throw new Error(`Failed to analyze template: ${error.stderr}`);
            }
            throw new Error(`Failed to analyze template: ${error.message}`);
        }
    }

    private async renderTemplate(templatePath: string, data: TemplateData, templateName?: string): Promise<string> {
        const helperPath = path.join(this.context.extensionPath, 'bin', 'template-helper');
        
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile!);
        const cwd = workspaceFolder?.uri.fsPath || path.dirname(templatePath);

        // Create temp data file in OS temp directory
        const dataJson = JSON.stringify(data);
        const tempDataFile = path.join(require('os').tmpdir(), `template-data-${Date.now()}.json`);
        fs.writeFileSync(tempDataFile, dataJson);

        try {
            // Build args array for execFile (safe from injection)
            const args = ['render', '-entry', templatePath, '-data', tempDataFile, '-workspace', cwd];
            
            if (templateName) {
                args.push('-template', templateName);
            }
            
            // Pass the included files explicitly
            const includedFilesArray = Array.from(this.includedFiles);
            if (includedFilesArray.length > 0) {
                const filesArg = includedFilesArray.join(',');
                args.push('-files', filesArg);
                console.log('Rendering with files:', includedFilesArray);
            }
            
            const { stdout, stderr } = await execFileAsync(helperPath, args, { cwd });
            
            if (stderr && stderr.trim()) {
                // Check if stderr contains actual errors (not just warnings)
                if (stderr.toLowerCase().includes('error') || stderr.toLowerCase().includes('fatal')) {
                    console.error('Render error output:', stderr);
                    throw new Error(`Template rendering failed: ${stderr}`);
                } else {
                    console.warn('Render warnings:', stderr);
                }
            }

            // Clean up temp file
            fs.unlinkSync(tempDataFile);

            return stdout;
        } catch (error: any) {
            // Clean up temp file even on error
            if (fs.existsSync(tempDataFile)) {
                fs.unlinkSync(tempDataFile);
            }
            if (error.stderr) {
                throw new Error(`Failed to render template: ${error.stderr}`);
            }
            throw new Error(`Failed to render template: ${error.message}`);
        }
    }

    private processHtmlForWebview(html: string): string {
        if (!this.panel || !this.currentFile) {
            return html;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        const contentRoot = this.getContentRoot(workspaceFolder);
        const baseDir = contentRoot || path.dirname(this.currentFile.fsPath);

        // Replace relative paths with webview URIs
        let processedHtml = html;

        // Process CSS links
        processedHtml = processedHtml.replace(
            /<link\s+([^>]*href=["'])([^"']+)(["'][^>]*>)/gi,
            (match, before, href, after) => {
                if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//')) {
                    const assetPath = path.join(baseDir, href);
                    if (fs.existsSync(assetPath)) {
                        const assetUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(assetPath));
                        return `<link ${before}${assetUri}${after}`;
                    }
                }
                return match;
            }
        );

        // Process script sources
        processedHtml = processedHtml.replace(
            /<script\s+([^>]*src=["'])([^"']+)(["'][^>]*>)/gi,
            (match, before, src, after) => {
                if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('//')) {
                    const assetPath = path.join(baseDir, src);
                    if (fs.existsSync(assetPath)) {
                        const assetUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(assetPath));
                        return `<script ${before}${assetUri}${after}`;
                    }
                }
                return match;
            }
        );

        // Process image sources
        processedHtml = processedHtml.replace(
            /<img\s+([^>]*src=["'])([^"']+)(["'][^>]*>)/gi,
            (match, before, src, after) => {
                if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('//') && !src.startsWith('data:')) {
                    const assetPath = path.join(baseDir, src);
                    if (fs.existsSync(assetPath)) {
                        const assetUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(assetPath));
                        return `<img ${before}${assetUri}${after}`;
                    }
                }
                return match;
            }
        );

        return processedHtml;
    }

    private getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-errorForeground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 4px;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }
            </style>
        </head>
        <body>
            <h1>Template Error or Missing Dependencies</h1>
            <pre>${this.escapeHtml(error)}</pre>
        </body>
        </html>`;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    public updateData(data: any) {
        this.templateData = data;
        this.analyzeAndRender();
    }

    public updateVariable(name: string, value: any) {
        console.log('updateVariable called:', name, value);
        
        // If value is undefined, remove the variable
        if (value === undefined) {
            this.deleteDeep(this.templateData, name);
        } else {
            // Support nested paths like "User.Name" or ".User.Name"
            this.setDeep(this.templateData, name, value);
        }
        
        console.log('Template data after update:', JSON.stringify(this.templateData, null, 2));
        this.saveTemplateData(this.templateData);
        this.analyzeAndRender();
    }

    private deleteDeep(target: any, path: string) {
        if (!path) {
            return;
        }
        // normalize path: remove leading dot if present
        const normalized = path.replace(/^\./, '');
        const parts = this.parsePath(normalized);
        
        if (parts.length === 0) {
            return;
        }
        
        let cur = target;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            
            if (part.isArray) {
                if (!Array.isArray(cur[part.key]) || cur[part.key][part.index!] === undefined) {
                    return; // Path doesn't exist
                }
                cur = cur[part.key][part.index!];
            } else {
                if (!cur[part.key]) {
                    return; // Path doesn't exist
                }
                cur = cur[part.key];
            }
        }
        
        // Delete the final property
        const lastPart = parts[parts.length - 1];
        if (lastPart.isArray) {
            if (Array.isArray(cur[lastPart.key])) {
                delete cur[lastPart.key][lastPart.index!];
            }
        } else {
            delete cur[lastPart.key];
        }
    }

    private setDeep(target: any, path: string, value: any) {
        if (!path) {
            return;
        }
        // normalize path: remove leading dot if present
        const normalized = path.replace(/^\./, '');
        
        // Parse path with array notation support (e.g., "BrandApps[0].Link")
        const parts = this.parsePath(normalized);
        
        let cur = target;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            
            if (i === parts.length - 1) {
                // Last part - set the value
                if (part.isArray) {
                    // Setting an array element
                    if (!Array.isArray(cur[part.key])) {
                        cur[part.key] = [];
                    }
                    cur[part.key][part.index!] = value;
                } else {
                    cur[part.key] = value;
                }
                return;
            }
            
            // Not the last part - navigate or create structure
            if (part.isArray) {
                // Handle array navigation
                if (!Array.isArray(cur[part.key])) {
                    cur[part.key] = [];
                }
                if (!cur[part.key][part.index!]) {
                    cur[part.key][part.index!] = {};
                }
                cur = cur[part.key][part.index!];
            } else {
                // Handle object navigation
                if (cur[part.key] === undefined || typeof cur[part.key] !== 'object' || Array.isArray(cur[part.key])) {
                    cur[part.key] = {};
                }
                cur = cur[part.key];
            }
        }
    }
    
    /**
     * Parse a path string into parts that may include array indices
     * Examples:
     *   "BrandApps[0].Link" -> [{key: "BrandApps", isArray: true, index: 0}, {key: "Link", isArray: false}]
     *   "User.Name" -> [{key: "User", isArray: false}, {key: "Name", isArray: false}]
     */
    private parsePath(path: string): Array<{key: string, isArray: boolean, index?: number}> {
        const parts: Array<{key: string, isArray: boolean, index?: number}> = [];
        
        // Split by dots, but need to handle array notation within parts
        const segments = path.split('.');
        
        for (const segment of segments) {
            // Check if this segment has array notation: "ArrayName[0]"
            const arrayMatch = segment.match(/^([^\[]+)\[(\d+)\]$/);
            
            if (arrayMatch) {
                parts.push({
                    key: arrayMatch[1],
                    isArray: true,
                    index: parseInt(arrayMatch[2], 10)
                });
            } else {
                parts.push({
                    key: segment,
                    isArray: false
                });
            }
        }
        
        return parts;
    }

    private getDeep(target: any, path: string): any {
        if (!path) {
            return undefined;
        }
        // normalize path: remove leading dot if present
        const normalized = path.replace(/^\./, '');
        const parts = this.parsePath(normalized);
        
        let cur = target;
        for (const part of parts) {
            if (cur === undefined || cur === null || typeof cur !== 'object') {
                return undefined;
            }
            
            if (part.isArray) {
                if (!Array.isArray(cur[part.key]) || cur[part.key][part.index!] === undefined) {
                    return undefined;
                }
                cur = cur[part.key][part.index!];
            } else {
                cur = cur[part.key];
            }
        }
        return cur;
    }

    private async saveTemplateData(data: any) {
        if (!this.currentFile) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        if (!workspaceFolder) {
            return;
        }

        // If we have a linked data file, save to that location
        let dataFile: string;
        
        if (this.currentDataFilePath) {
            dataFile = this.currentDataFilePath;
            console.log('Saving to linked data file:', dataFile);
        } else {
            // No linked file, save to auto-named file
            const dataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            const templateName = path.basename(this.currentFile.fsPath);
            dataFile = path.join(dataDir, `${templateName}.json`);
            
            // Update currentDataFilePath to track where we saved
            this.currentDataFilePath = dataFile;
            console.log('Saving to auto-named data file:', dataFile);
        }

        try {
            const content = JSON.stringify(data, null, 2);
            fs.writeFileSync(dataFile, content);
            console.log('Template data saved successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Error saving template data: ${error}`);
        }
    }

    private async loadTemplateData() {
        if (!this.currentFile) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        if (!workspaceFolder) {
            return;
        }

        // First, check workspace configuration for linked data file
        const configLinkedFile = await this.getConfigLinkedDataFile(this.currentFile.fsPath, workspaceFolder.uri.fsPath);
        
        if (configLinkedFile && fs.existsSync(configLinkedFile)) {
            try {
                const content = fs.readFileSync(configLinkedFile, 'utf8');
                this.templateData = JSON.parse(content);
                this.currentDataFilePath = configLinkedFile;
                console.log('Loaded config-linked data file:', configLinkedFile);
                return;
            } catch (error) {
                console.error('Error loading config-linked data file:', error);
            }
        }

        // Second, check if the template file has a data-file annotation (for backwards compatibility)
        const commentLinkedFile = await this.getCommentLinkedDataFile(this.currentFile.fsPath, workspaceFolder.uri.fsPath);
        
        if (commentLinkedFile && fs.existsSync(commentLinkedFile)) {
            try {
                const content = fs.readFileSync(commentLinkedFile, 'utf8');
                this.templateData = JSON.parse(content);
                this.currentDataFilePath = commentLinkedFile;
                console.log('Loaded comment-linked data file:', commentLinkedFile);
                return;
            } catch (error) {
                console.error('Error loading comment-linked data file:', error);
            }
        }

        // Fall back to auto-named data file
        const templateName = path.basename(this.currentFile.fsPath);
        const dataFile = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data', `${templateName}.json`);

        if (fs.existsSync(dataFile)) {
            try {
                const content = fs.readFileSync(dataFile, 'utf8');
                this.templateData = JSON.parse(content);
                this.currentDataFilePath = dataFile;
                console.log('Loaded auto-named data file:', dataFile);
            } catch (error) {
                console.error('Error loading template data:', error);
            }
        } else {
            this.currentDataFilePath = undefined;
            console.log('No data file found, using empty data');
        }
    }

    public async unlinkDataFile(): Promise<void> {
        if (!this.currentFile) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        if (!workspaceFolder) {
            return;
        }

        // Remove from config file
        try {
            const configFile = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data-links.json');
            
            if (fs.existsSync(configFile)) {
                const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                const relativeTemplatePath = path.relative(workspaceFolder.uri.fsPath, this.currentFile.fsPath);
                
                if (config[relativeTemplatePath]) {
                    delete config[relativeTemplatePath];
                    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
                    console.log('Removed data file link from config');
                }
            }
        } catch (error) {
            console.error('Error removing data file link:', error);
        }

        // Clear current data file path
        this.currentDataFilePath = undefined;
        this.templateData = {};
    }

    private async getConfigLinkedDataFile(templatePath: string, workspaceRoot: string): Promise<string | undefined> {
        try {
            const configFile = path.join(workspaceRoot, '.vscode', 'template-data-links.json');
            
            if (!fs.existsSync(configFile)) {
                return undefined;
            }

            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            
            // Use workspace-relative path as key
            const relativeTemplatePath = path.relative(workspaceRoot, templatePath);
            const linkedPath = config[relativeTemplatePath];
            
            if (linkedPath) {
                // Resolve relative to workspace root if not absolute
                if (!path.isAbsolute(linkedPath)) {
                    return path.join(workspaceRoot, linkedPath);
                }
                return linkedPath;
            }
        } catch (error) {
            console.error('Error reading template data links config:', error);
        }
        
        return undefined;
    }

    private async getCommentLinkedDataFile(templatePath: string, workspaceRoot: string): Promise<string | undefined> {
        try {
            const content = fs.readFileSync(templatePath, 'utf8');
            
            // Look for <!-- template-data: path/to/file.json --> annotation
            const match = content.match(/<!--\s*template-data:\s*(.+?)\s*-->/);
            
            if (match && match[1]) {
                let dataPath = match[1].trim();
                
                // Resolve relative to workspace root if not absolute
                if (!path.isAbsolute(dataPath)) {
                    dataPath = path.join(workspaceRoot, dataPath);
                }
                
                return dataPath;
            }
        } catch (error) {
            console.error('Error reading template for data link:', error);
        }
        
        return undefined;
    }

    public async setDataFileLink(templatePath: string, dataFilePath: string) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(templatePath));
        if (!workspaceFolder) {
            return;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;
        const configDir = path.join(workspaceRoot, '.vscode');
        const configFile = path.join(configDir, 'template-data-links.json');

        // Ensure .vscode directory exists
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        // Load existing config or create new
        let config: Record<string, string> = {};
        if (fs.existsSync(configFile)) {
            try {
                config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            } catch (error) {
                console.error('Error reading existing config:', error);
            }
        }

        // Store as workspace-relative paths
        const relativeTemplatePath = path.relative(workspaceRoot, templatePath);
        const relativeDataPath = path.relative(workspaceRoot, dataFilePath);
        
        config[relativeTemplatePath] = relativeDataPath;

        // Save config
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        console.log('Saved data file link:', relativeTemplatePath, '->', relativeDataPath);
        
        // If this is the current file, update the data file path and reload
        if (this.currentFile && templatePath === this.currentFile.fsPath) {
            this.currentDataFilePath = dataFilePath;
            
            // Load the linked data file
            if (fs.existsSync(dataFilePath)) {
                try {
                    const content = fs.readFileSync(dataFilePath, 'utf8');
                    this.templateData = JSON.parse(content);
                    console.log('Loaded newly linked data file');
                } catch (error) {
                    console.error('Error loading linked data file:', error);
                }
            }
        }
    }

    public refresh() {
        this.analyzeAndRender();
    }

    public dispose() {
        this.disposeWatcher();
        
        if (this.panel) {
            this.panel.dispose();
        }

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}