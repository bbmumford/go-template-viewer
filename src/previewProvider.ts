import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TemplateData, TemplateAnalysisResult, TemplateVariable, TemplateDependency, TemplateDefinition, HtmxDependency, HtmxInfo } from './types';
import { showTimedNotification, sanitizePathForFilename, getHelperBinaryName } from './utils';

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
    private lastRenderedHtml?: string; // Store last rendered HTML for export
    private diagnosticCollection: vscode.DiagnosticCollection;
    
    // Debounce timer for analyzeAndRender
    private analyzeDebounceTimer: NodeJS.Timeout | undefined;
    private isAnalyzing: boolean = false;
    private pendingAnalysis: boolean = false;
    
    // Flag to track if initial context has been restored
    private contextRestored: boolean = false;
    
    // Flag to prevent auto-discovery of data files after explicit unlink
    private dataFileUnlinked: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('go-template');
        context.subscriptions.push(this.diagnosticCollection);

        // Re-render when relevant settings change (e.g. CSP toggle)
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('goTemplateViewer.disablePreviewCSP') ||
                    e.affectsConfiguration('goTemplateViewer.contentRoot')) {
                    if (this.panel && this.currentFile) {
                        this.scheduleAnalyzeAndRender();
                    }
                }
            })
        );
    }

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

    public getDataFilePath(): string | undefined {
        return this.currentDataFilePath;
    }

    public setTemplateData(data: any) {
        this.templateData = data;
        this.saveTemplateData(data);
        this.scheduleAnalyzeAndRender();
    }
    
    public async addTemplateFile(filePath: string) {
        console.log('Adding template file:', filePath);
        this.includedFiles.add(filePath);
        console.log('Included files now:', Array.from(this.includedFiles));
        // Schedule debounced re-analyze - allows rapid additions without multiple renders
        this.scheduleAnalyzeAndRender();
    }
    
    public async removeTemplateFile(filePath: string) {
        this.includedFiles.delete(filePath);
        // Schedule debounced re-analyze
        this.scheduleAnalyzeAndRender();
    }
    
    public setSelectedTemplate(templateName?: string) {
        this.selectedTemplate = templateName;
        // Re-render with the selected template
        this.scheduleAnalyzeAndRender();
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
            this.contextRestored = false; // Allow context to be restored from data file
            this.dataFileUnlinked = false; // Reset unlink flag for new context
            this.currentDataFilePath = undefined; // Clear stale data file reference
            this.templateData = {}; // Clear stale template data
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
                this.contextRestored = false; // Allow context to be restored from data file
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

            this.panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'openCSPSetting') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'goTemplateViewer.disablePreviewCSP');
                }
            }, null, this.disposables);
        }

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
            this.scheduleAnalyzeAndRender();
        });

        this.fileWatcher.onDidCreate(() => {
            this.scheduleAnalyzeAndRender();
        });

        this.fileWatcher.onDidDelete(() => {
            this.scheduleAnalyzeAndRender();
        });
    }

    private disposeWatcher() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }
    }

    /**
     * Schedule an analyze and render with debouncing.
     * Multiple rapid calls will be collapsed into a single execution.
     */
    private scheduleAnalyzeAndRender(delay: number = 150) {
        // Clear any pending timer
        if (this.analyzeDebounceTimer) {
            clearTimeout(this.analyzeDebounceTimer);
        }
        
        // If already analyzing, mark that we need another run
        if (this.isAnalyzing) {
            this.pendingAnalysis = true;
            return;
        }
        
        this.analyzeDebounceTimer = setTimeout(() => {
            this.analyzeDebounceTimer = undefined;
            this.doAnalyzeAndRender();
        }, delay);
    }

    private async doAnalyzeAndRender() {
        if (this.isAnalyzing) {
            this.pendingAnalysis = true;
            return;
        }
        
        this.isAnalyzing = true;
        try {
            await this.analyzeAndRenderImpl();
        } finally {
            this.isAnalyzing = false;
            
            // If another analysis was requested while we were running, do it now
            if (this.pendingAnalysis) {
                this.pendingAnalysis = false;
                this.scheduleAnalyzeAndRender(50); // Shorter delay for pending
            }
        }
    }

    /**
     * Public method for direct analyze/render (used by openPreview).
     * For most cases, prefer scheduleAnalyzeAndRender for debouncing.
     */
    private async analyzeAndRender() {
        return this.doAnalyzeAndRender();
    }

    private async analyzeAndRenderImpl() {
        if (!this.panel || !this.currentFile) {
            return;
        }

        const startTime = Date.now();

        try {
            // Load saved template data if exists
            // Restore context (includedFiles) only on initial load, not subsequent re-renders
            const shouldRestoreContext = !this.contextRestored;
            await this.loadTemplateData(shouldRestoreContext);
            this.contextRestored = true;

            // Call Go helper to analyze template (first pass to discover dependencies)
            let analysis = await this.analyzeTemplate(this.currentFile.fsPath);
            
            // Store templates for selection
            if (analysis.templates) {
                this.templates = Object.values(analysis.templates);
            }
            
            // Auto-include templates that satisfy dependencies
            let addedDependencies = false;
            if (analysis.dependencies && analysis.templates) {
                for (const dep of analysis.dependencies) {
                    if (dep.required) {
                        // Find template that defines this dependency
                        const providingTemplate = Object.values(analysis.templates).find(t => t.name === dep.name);
                        if (providingTemplate && providingTemplate.filePath) {
                            // Add to included files if not already there
                            if (!this.includedFiles.has(providingTemplate.filePath)) {
                                this.includedFiles.add(providingTemplate.filePath);
                                addedDependencies = true;
                            }
                        }
                    }
                }
            }
            
            // If we added dependencies, re-analyze to get complete variable list
            if (addedDependencies) {
                analysis = await this.analyzeTemplate(this.currentFile.fsPath);
                
                // Update templates again
                if (analysis.templates) {
                    this.templates = Object.values(analysis.templates);
                }
            }
            
            // Get all variables for analysis
            const allVars = analysis.variables || [];
            
            // If template data is empty AND we have no linked data file, initialize with suggested values
            // This only happens on first load or when explicitly reset
            if (Object.keys(this.templateData).length === 0 && !this.currentDataFilePath) {
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    if (variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                    }
                }
            } else if (!this.currentDataFilePath) {
                // No linked data file - rebuild from scratch to match current templates
                this.templateData = {};
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    if (variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                    }
                }
            } else {
                // Template data exists with linked file - merge in any NEW variables from newly added templates
                // Also fix type mismatches (e.g., string "" should become number 0 for numeric comparisons)
                let hasChanges = false;
                
                for (const variable of allVars) {
                    const path = variable.path.replace(/^\./, ''); // Remove leading dot
                    const currentValue = this.getDeep(this.templateData, path);
                    
                    // Add if variable doesn't exist yet and we have a suggested value
                    if (currentValue === undefined && variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                        hasChanges = true;
                    }
                    // Fix type mismatches: if current value is a string but should be a number
                    // This handles both empty strings and incorrect string values from previous inference
                    else if (typeof currentValue === 'string' && variable.type === 'number' && variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                        hasChanges = true;
                    }
                    // Fix type mismatches: if current value is a string but should be a boolean
                    else if (typeof currentValue === 'string' && variable.type === 'bool' && variable.suggested !== undefined) {
                        this.setDeep(this.templateData, path, variable.suggested);
                        hasChanges = true;
                    }
                }
                
                // Save the updated data if we made changes
                if (hasChanges) {
                    await this.saveTemplateData(this.templateData);
                }
            }
            
            // Notify listeners about variables and dependencies
            if (this.onDataChangeCallback) {
                this.onDataChangeCallback(allVars, this.currentDataFilePath, analysis.dependencies || [], analysis.htmx);
            }

            // Render the template (with selected template if specified)
            const rendered = await this.renderTemplate(this.currentFile.fsPath, this.templateData, this.selectedTemplate);

            // Store rendered HTML for export
            this.lastRenderedHtml = rendered;

            // Clear any previous diagnostics on success
            this.diagnosticCollection.clear();

            // Set context to enable export button
            vscode.commands.executeCommand('setContext', 'goTemplatePreviewActive', true);

            // Update webview with rendered HTML
            this.panel.webview.html = this.processHtmlForWebview(rendered);
            
            console.log(`Render complete in ${Date.now() - startTime}ms (${this.includedFiles.size} files)`);
            
        } catch (error) {
            console.error('Template error:', error);
            
            // Clear context to disable export button on error
            vscode.commands.executeCommand('setContext', 'goTemplatePreviewActive', false);
            
            // Parse and display template errors as diagnostics
            this.parseAndShowErrors(String(error));
            
            showTimedNotification(`Template Error: ${error}`, 'error');
            this.panel.webview.html = this.getErrorHtml(String(error));
        }
    }

    private parseAndShowErrors(errorMessage: string) {
        // Clear previous diagnostics
        this.diagnosticCollection.clear();
        
        if (!this.currentFile) {
            return;
        }

        // Build a map of template names to file paths
        // This resolves names like "content" to their actual source files
        const templateNameToFile = new Map<string, string>();
        for (const tmpl of this.templates) {
            if (tmpl.name && tmpl.filePath) {
                templateNameToFile.set(tmpl.name, tmpl.filePath);
            }
        }
        // Also map filenames (like "base.html") to their full paths
        for (const filePath of this.includedFiles) {
            templateNameToFile.set(path.basename(filePath), filePath);
        }

        // Try to parse error message for file and line information
        // Common Go template error formats:
        // template: filename.html:23:15: undefined variable ".Missing"
        // template: filename.html:5: function "unknown" not defined
        // template: content:1:1: error (where "content" is a defined template name)
        const errorRegex = /template:\s+(.+?):(\d+)(?::(\d+))?\s*:\s*(.+)/gi;
        const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();
        
        let match;
        while ((match = errorRegex.exec(errorMessage)) !== null) {
            const [, templateName, lineStr, columnStr, message] = match;
            const line = parseInt(lineStr) - 1; // VS Code uses 0-based line numbers
            const column = columnStr ? parseInt(columnStr) - 1 : 0;
            
            // Try to find the actual file path
            let fileUri: vscode.Uri | undefined;
            let resolvedFileName = templateName;
            
            // First try to resolve template name to file path (handles "content" -> actual file)
            if (templateNameToFile.has(templateName)) {
                const resolvedPath = templateNameToFile.get(templateName)!;
                fileUri = vscode.Uri.file(resolvedPath);
                resolvedFileName = path.basename(resolvedPath);
            }
            // Check if it matches current file
            else if (path.basename(this.currentFile.fsPath) === templateName) {
                fileUri = this.currentFile;
            } else {
                // Check included files by basename
                for (const includedPath of this.includedFiles) {
                    if (path.basename(includedPath) === templateName) {
                        fileUri = vscode.Uri.file(includedPath);
                        break;
                    }
                }
            }
            
            if (fileUri) {
                const range = new vscode.Range(
                    new vscode.Position(Math.max(0, line), column),
                    new vscode.Position(Math.max(0, line), column + 50) // Highlight a reasonable length
                );
                
                // Include resolved file name in the message if it was a template name
                const displayMessage = templateName !== resolvedFileName 
                    ? `[${templateName}] ${message.trim()}`
                    : message.trim();
                
                const diagnostic = new vscode.Diagnostic(
                    range,
                    displayMessage,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = 'go-template';
                
                if (!diagnosticsMap.has(fileUri.toString())) {
                    diagnosticsMap.set(fileUri.toString(), []);
                }
                diagnosticsMap.get(fileUri.toString())!.push(diagnostic);
            }
        }
        
        // Apply all diagnostics
        for (const [uriStr, diagnostics] of diagnosticsMap) {
            this.diagnosticCollection.set(vscode.Uri.parse(uriStr), diagnostics);
        }
        
        // If no specific file errors were parsed, show generic error on current file
        if (diagnosticsMap.size === 0 && this.currentFile) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 50),
                errorMessage,
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'go-template';
            this.diagnosticCollection.set(this.currentFile, [diagnostic]);
        }
    }

    public async exportHtml() {
        if (!this.lastRenderedHtml) {
            showTimedNotification('No rendered HTML to export. Please open a template preview first.', 'error');
            return;
        }

        if (!this.currentFile) {
            showTimedNotification('No active template file.', 'error');
            return;
        }

        // Suggest filename based on current template
        const currentFileName = path.basename(this.currentFile.fsPath, path.extname(this.currentFile.fsPath));
        const defaultFileName = `${currentFileName}.html`;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const defaultUri = workspaceFolder 
            ? vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, defaultFileName))
            : vscode.Uri.file(path.join(path.dirname(this.currentFile.fsPath), defaultFileName));

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: defaultUri,
            filters: {
                'HTML Files': ['html'],
                'All Files': ['*']
            },
            saveLabel: 'Export HTML'
        });

        if (!saveUri) {
            return; // User cancelled
        }

        try {
            await fs.promises.writeFile(saveUri.fsPath, this.lastRenderedHtml, 'utf8');
            showTimedNotification(`Exported HTML to ${path.basename(saveUri.fsPath)}`);
        } catch (error) {
            showTimedNotification(`Failed to export HTML: ${error}`, 'error');
        }
    }

    private async analyzeTemplate(templatePath: string): Promise<TemplateAnalysisResult> {
        const helperBinaryName = getHelperBinaryName();
        const helperPath = path.join(this.context.extensionPath, 'bin', helperBinaryName);
        
        // Check if helper exists
        if (!fs.existsSync(helperPath)) {
            const buildCmd = process.platform === 'win32' 
                ? 'cd go-helper && go build -o ..\\bin\\template-helper.exe'
                : 'cd go-helper && go build -o ../bin/template-helper';
            throw new Error(`Go template helper not found. Please build it first: ${buildCmd}`);
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
        const helperBinaryName = getHelperBinaryName();
        const helperPath = path.join(this.context.extensionPath, 'bin', helperBinaryName);
        
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile!);
        const cwd = workspaceFolder?.uri.fsPath || path.dirname(templatePath);

        // Create temp data file in OS temp directory with unique name
        const dataJson = JSON.stringify(data);
        const tempDataFile = path.join(require('os').tmpdir(), `template-data-${crypto.randomUUID()}.json`);
        await fs.promises.writeFile(tempDataFile, dataJson);

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
            await fs.promises.unlink(tempDataFile);

            return stdout;
        } catch (error: any) {
            // Clean up temp file even on error
            try { await fs.promises.unlink(tempDataFile); } catch { /* ignore */ }
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
        const webview = this.panel.webview;

        // Generate a nonce for the CSP
        const nonce = crypto.randomUUID().replace(/-/g, '');

        // Replace relative paths with webview URIs
        let processedHtml = html;

        // Process CSS links
        processedHtml = processedHtml.replace(
            /<link\s+([^>]*href=["'])([^"']+)(["'][^>]*>)/gi,
            (match, before, href, after) => {
                if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//')) {
                    const assetPath = path.join(baseDir, href);
                    if (fs.existsSync(assetPath)) {
                        const assetUri = webview.asWebviewUri(vscode.Uri.file(assetPath));
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
                        const assetUri = webview.asWebviewUri(vscode.Uri.file(assetPath));
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
                        const assetUri = webview.asWebviewUri(vscode.Uri.file(assetPath));
                        return `<img ${before}${assetUri}${after}`;
                    }
                }
                return match;
            }
        );

        // Check if CSP is disabled by user setting
        const cspConfig = vscode.workspace.getConfiguration('goTemplateViewer');
        const disableCSP = cspConfig.get<boolean>('disablePreviewCSP', false);

        // Banner shown at the top of the preview
        const bannerStyle = `position:fixed;top:0;left:0;right:0;z-index:99999;padding:4px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;text-align:center;opacity:0.85;display:flex;align-items:center;justify-content:center;gap:8px;`;
        const dismissBtn = `<button id="gtv-dismiss" style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;margin-left:4px;opacity:0.8;" title="Dismiss">&times;</button>`;
        const bannerHtml = disableCSP
            ? `<div id="gtv-csp-banner" style="${bannerStyle}background:#a84300;color:#fff;"><span>⚠️ Preview CSP disabled — scripts run without restrictions (<a href="#" id="gtv-settings" style="color:#ffd;text-decoration:underline;">Settings</a>)</span>${dismissBtn}</div>`
            : `<div id="gtv-csp-banner" style="${bannerStyle}background:#1a6633;color:#fff;"><span>🔒 Preview CSP enabled — some scripts may be blocked (<a href="#" id="gtv-settings" style="color:#9df;text-decoration:underline;">Settings</a>)</span>${dismissBtn}</div>`;
        const bannerScript = `<script nonce="${nonce}">(function(){var vscode;try{vscode=acquireVsCodeApi();}catch(e){}var s=document.getElementById('gtv-settings');var d=document.getElementById('gtv-dismiss');if(s){s.addEventListener('click',function(e){e.preventDefault();if(vscode)vscode.postMessage({command:'openCSPSetting'});});}if(d){d.addEventListener('click',function(){var b=document.getElementById('gtv-csp-banner');if(b)b.style.display='none';});}})();</script>`;

        if (!disableCSP) {
            // Inject Content Security Policy into <head>
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'nonce-${nonce}' ${webview.cspSource} https:; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource} https:;">`;

            // Add nonce to inline <script> tags
            processedHtml = processedHtml.replace(
                /<script(?![^>]*\bsrc\b)([^>]*)>/gi,
                (match, attrs) => {
                    if (attrs.includes('nonce=')) {
                        return match; // Already has nonce
                    }
                    return `<script nonce="${nonce}"${attrs}>`;
                }
            );

            // Insert CSP + banner into <head>/<body>
            if (processedHtml.includes('<head>')) {
                processedHtml = processedHtml.replace('<head>', `<head>\n    ${cspMeta}`);
            } else if (processedHtml.includes('<head ')) {
                processedHtml = processedHtml.replace(/<head([^>]*)>/, `<head$1>\n    ${cspMeta}`);
            } else {
                // No <head> tag, wrap in minimal HTML structure
                processedHtml = `<!DOCTYPE html><html><head>${cspMeta}</head><body>${processedHtml}</body></html>`;
            }
        } else {
            // CSP disabled — ensure there's a basic HTML structure but no CSP meta
            if (!processedHtml.includes('<head')) {
                processedHtml = `<!DOCTYPE html><html><head></head><body>${processedHtml}</body></html>`;
            }
        }

        // Inject the banner + script after <body>
        const bannerBlock = `${bannerHtml}\n    ${bannerScript}`;
        if (processedHtml.includes('<body>')) {
            processedHtml = processedHtml.replace('<body>', `<body>\n    ${bannerBlock}`);
        } else if (processedHtml.includes('<body ')) {
            processedHtml = processedHtml.replace(/<body([^>]*)>/, `<body$1>\n    ${bannerBlock}`);
        }

        return processedHtml;
    }

    private getErrorHtml(error: string): string {
        // Parse multiple errors from validation output
        const errorLines = error.split('\n').filter(line => line.includes('template:'));
        const hasMultipleErrors = errorLines.length > 1;
        
        // Format errors as clickable items
        let errorListHtml = '';
        if (hasMultipleErrors || error.includes('validation errors:')) {
            const errors = this.parseErrorLines(error);
            if (errors.length > 0) {
                errorListHtml = `
                    <div class="error-list">
                        <h3>${errors.length} Error${errors.length > 1 ? 's' : ''} Found:</h3>
                        <ul>
                            ${errors.map(e => `
                                <li class="error-item">
                                    <span class="error-location">${this.escapeHtml(e.file)}:${e.line}:${e.column}</span>
                                    <span class="error-message">${this.escapeHtml(e.message)}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `;
            }
        }
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Template Errors</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.5;
                }
                h1 {
                    color: var(--vscode-errorForeground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                h3 {
                    color: var(--vscode-errorForeground);
                    margin-bottom: 10px;
                }
                .error-list {
                    margin: 20px 0;
                }
                .error-list ul {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .error-item {
                    background-color: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    border-radius: 4px;
                    padding: 12px;
                    margin-bottom: 8px;
                }
                .error-location {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    color: var(--vscode-textLink-foreground);
                    display: block;
                    margin-bottom: 4px;
                }
                .error-message {
                    color: var(--vscode-errorForeground);
                    display: block;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 4px;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    font-size: 12px;
                    margin-top: 20px;
                }
                .hint {
                    background-color: var(--vscode-inputValidation-infoBackground);
                    border: 1px solid var(--vscode-inputValidation-infoBorder);
                    border-radius: 4px;
                    padding: 12px;
                    margin-top: 20px;
                }
                .hint h4 {
                    margin: 0 0 8px 0;
                    color: var(--vscode-inputValidation-infoForeground);
                }
            </style>
        </head>
        <body>
            <h1>Template Errors</h1>
            ${errorListHtml}
            ${error.includes('type mismatch') ? `
                <div class="hint">
                    <h4>💡 How to fix type mismatches:</h4>
                    <p>Edit the value in the <strong>Variables</strong> panel to match the expected type:</p>
                    <ul>
                        <li>For number comparisons: use a number (e.g., <code>30</code>) not a string</li>
                        <li>For boolean comparisons: use <code>true</code> or <code>false</code></li>
                        <li>Or delete the data file to regenerate with correct types</li>
                    </ul>
                </div>
            ` : ''}
            <details>
                <summary>Raw Error Output</summary>
                <pre>${this.escapeHtml(error)}</pre>
            </details>
        </body>
        </html>`;
    }
    
    private parseErrorLines(error: string): Array<{file: string, line: number, column: number, message: string}> {
        const errors: Array<{file: string, line: number, column: number, message: string}> = [];
        const regex = /template:\s*([^:]+):(\d+):(\d+):\s*(.+)/g;
        let match;
        
        // Build template name to file path mapping
        const templateNameToFile = new Map<string, string>();
        for (const tmpl of this.templates) {
            if (tmpl.name && tmpl.filePath) {
                templateNameToFile.set(tmpl.name, path.basename(tmpl.filePath));
            }
        }
        
        while ((match = regex.exec(error)) !== null) {
            let fileName = match[1];
            
            // Resolve template names like "content" to actual file names
            if (templateNameToFile.has(fileName)) {
                const resolvedFile = templateNameToFile.get(fileName)!;
                fileName = `${resolvedFile} [${fileName}]`;
            }
            
            errors.push({
                file: fileName,
                line: parseInt(match[2]),
                column: parseInt(match[3]),
                message: match[4].trim()
            });
        }
        
        return errors;
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
        this.scheduleAnalyzeAndRender();
    }

    public updateVariable(name: string, value: any) {
        // If value is undefined, remove the variable
        if (value === undefined) {
            this.deleteDeep(this.templateData, name);
        } else {
            // Support nested paths like "User.Name" or ".User.Name"
            this.setDeep(this.templateData, name, value);
        }
        
        this.saveTemplateData(this.templateData);
        this.scheduleAnalyzeAndRender();
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

    /**
     * Set a value deep in an object using path notation.
     * Returns true if successful, false if there was a type conflict.
     */
    private setDeep(target: any, path: string, value: any): boolean {
        if (!path) {
            return false;
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
                    // Check if we can create an array here
                    const existingValue = cur[part.key];
                    if (existingValue !== undefined && !Array.isArray(existingValue) && typeof existingValue !== 'object') {
                        // Type conflict: existing primitive where we need an array
                        console.warn(`Type conflict at ${path}: cannot create array at ${part.key}, existing value is ${typeof existingValue}`);
                        return false;
                    }
                    // Setting an array element
                    if (!Array.isArray(cur[part.key])) {
                        cur[part.key] = [];
                    }
                    cur[part.key][part.index!] = value;
                } else {
                    cur[part.key] = value;
                }
                return true;
            }
            
            // Not the last part - navigate or create structure
            if (part.isArray) {
                // Check if we can create an array here
                const existingArrayValue = cur[part.key];
                if (existingArrayValue !== undefined && !Array.isArray(existingArrayValue)) {
                    if (typeof existingArrayValue !== 'object') {
                        // Type conflict: existing primitive where we need an array
                        console.warn(`Type conflict at ${path}: cannot create array at ${part.key}, existing value is ${typeof existingArrayValue}`);
                        return false;
                    }
                }
                // Handle array navigation
                if (!Array.isArray(cur[part.key])) {
                    cur[part.key] = [];
                }
                // Check if array element is a primitive when we need an object
                const existingElement = cur[part.key][part.index!];
                if (existingElement !== undefined && existingElement !== null && typeof existingElement !== 'object') {
                    // Type conflict: array element is a primitive but we need to navigate deeper
                    console.warn(`Type conflict at ${path}: ${part.key}[${part.index}] is ${typeof existingElement}, cannot add nested properties`);
                    return false;
                }
                if (!cur[part.key][part.index!]) {
                    cur[part.key][part.index!] = {};
                }
                cur = cur[part.key][part.index!];
            } else {
                // Check if existing value is a primitive when we need an object
                const existingObjValue = cur[part.key];
                if (existingObjValue !== undefined && existingObjValue !== null && typeof existingObjValue !== 'object') {
                    // Type conflict: existing primitive where we need an object
                    console.warn(`Type conflict at ${path}: ${part.key} is ${typeof existingObjValue}, cannot add nested properties`);
                    return false;
                }
                // Handle object navigation
                if (cur[part.key] === undefined || typeof cur[part.key] !== 'object' || Array.isArray(cur[part.key])) {
                    cur[part.key] = {};
                }
                cur = cur[part.key];
            }
        }
        return true;
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

        // Don't save if user explicitly unlinked and there's no linked file
        if (this.dataFileUnlinked && !this.currentDataFilePath) {
            return;
        }

        // If we have a linked data file, save to that location
        let dataFile: string;
        
        if (this.currentDataFilePath) {
            dataFile = this.currentDataFilePath;
        } else {
            // No linked file, save to auto-named file using workspace-relative path
            // to avoid collisions between files with the same basename in different directories
            const dataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data');
            await fs.promises.mkdir(dataDir, { recursive: true });

            const relativePath = path.relative(workspaceFolder.uri.fsPath, this.currentFile.fsPath);
            const sanitizedName = sanitizePathForFilename(relativePath);
            dataFile = path.join(dataDir, `${sanitizedName}.json`);
            
            // Update currentDataFilePath to track where we saved
            this.currentDataFilePath = dataFile;
        }

        try {
            // Create data object with template context metadata
            const dataWithContext = {
                ...data,
                _templateContext: {
                    entryFile: path.relative(workspaceFolder.uri.fsPath, this.currentFile.fsPath),
                    includedFiles: Array.from(this.includedFiles).map(f => 
                        path.relative(workspaceFolder.uri.fsPath, f)
                    ),
                    selectedTemplate: this.selectedTemplate || undefined,
                    lastSaved: new Date().toISOString()
                }
            };
            
            const content = JSON.stringify(dataWithContext, null, 2);
            await fs.promises.writeFile(dataFile, content);
        } catch (error) {
            showTimedNotification(`Error saving template data: ${error}`, 'error');
        }
    }

    /**
     * Load template data and optionally restore render context from saved metadata.
     * @param restoreContext If true, will restore includedFiles from saved _templateContext
     */
    private async loadTemplateData(restoreContext: boolean = false) {
        if (!this.currentFile) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.currentFile);
        if (!workspaceFolder) {
            return;
        }

        // If user explicitly unlinked and we have no current data file, skip auto-discovery
        if (this.dataFileUnlinked && !this.currentDataFilePath) {
            return;
        }

        // If we already have a data file path loaded, don't re-discover on subsequent renders
        if (this.currentDataFilePath) {
            return;
        }

        // First, check workspace configuration for linked data file
        const configLinkedFile = await this.getConfigLinkedDataFile(this.currentFile.fsPath, workspaceFolder.uri.fsPath);
        
        if (configLinkedFile) {
            try {
                await fs.promises.access(configLinkedFile);
                const content = await fs.promises.readFile(configLinkedFile, 'utf8');
                const parsed = JSON.parse(content);
                
                // Extract template context if present and restore if requested
                if (restoreContext && parsed._templateContext) {
                    await this.restoreTemplateContext(parsed._templateContext, workspaceFolder.uri.fsPath);
                }
                
                // Remove _templateContext from runtime data
                const { _templateContext, ...dataOnly } = parsed;
                this.templateData = dataOnly;
                this.currentDataFilePath = configLinkedFile;
                return;
            } catch (error) {
                console.error('Error loading config-linked data file:', error);
            }
        }

        // Second, check if the template file has a data-file annotation (for backwards compatibility)
        const commentLinkedFile = await this.getCommentLinkedDataFile(this.currentFile.fsPath, workspaceFolder.uri.fsPath);
        
        if (commentLinkedFile) {
            try {
                await fs.promises.access(commentLinkedFile);
                const content = await fs.promises.readFile(commentLinkedFile, 'utf8');
                const parsed = JSON.parse(content);
                
                // Extract template context if present and restore if requested
                if (restoreContext && parsed._templateContext) {
                    await this.restoreTemplateContext(parsed._templateContext, workspaceFolder.uri.fsPath);
                }
                
                // Remove _templateContext from runtime data
                const { _templateContext, ...dataOnly } = parsed;
                this.templateData = dataOnly;
                this.currentDataFilePath = commentLinkedFile;
                return;
            } catch (error) {
                console.error('Error loading comment-linked data file:', error);
            }
        }

        // Fall back to auto-named data file using workspace-relative path
        const relativePath = path.relative(workspaceFolder.uri.fsPath, this.currentFile.fsPath);
        const sanitizedName = sanitizePathForFilename(relativePath);
        const dataFile = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data', `${sanitizedName}.json`);

        // Also check legacy basename-only format for backwards compatibility
        const legacyDataFile = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data', `${path.basename(this.currentFile.fsPath)}.json`);

        const fileToLoad = await this.findExistingFile(dataFile, legacyDataFile);
        if (fileToLoad) {
            try {
                const content = await fs.promises.readFile(fileToLoad, 'utf8');
                const parsed = JSON.parse(content);
                
                // Verify this data file actually belongs to this template
                // by checking the _templateContext.entryFile metadata
                if (parsed._templateContext?.entryFile) {
                    const savedEntryFile = parsed._templateContext.entryFile;
                    if (savedEntryFile !== relativePath && fileToLoad === legacyDataFile) {
                        // This legacy file belongs to a different template with the same basename
                        console.log(`Skipping legacy data file - belongs to ${savedEntryFile}, not ${relativePath}`);
                        this.currentDataFilePath = undefined;
                        return;
                    }
                }
                
                // Extract template context if present and restore if requested
                if (restoreContext && parsed._templateContext) {
                    await this.restoreTemplateContext(parsed._templateContext, workspaceFolder.uri.fsPath);
                }
                
                // Remove _templateContext from runtime data
                const { _templateContext, ...dataOnly } = parsed;
                this.templateData = dataOnly;
                this.currentDataFilePath = fileToLoad;
            } catch (error) {
                console.error('Error loading template data:', error);
            }
        } else {
            this.currentDataFilePath = undefined;
        }
    }

    /**
     * Find the first existing file from the candidates list.
     */
    private async findExistingFile(...candidates: string[]): Promise<string | undefined> {
        for (const candidate of candidates) {
            try {
                await fs.promises.access(candidate);
                return candidate;
            } catch {
                // File doesn't exist, try next
            }
        }
        return undefined;
    }

    /**
     * Restore render context (includedFiles, selectedTemplate) from saved metadata
     */
    private async restoreTemplateContext(context: any, workspaceRoot: string): Promise<void> {
        if (!context) {
            return;
        }

        // Restore included files
        if (Array.isArray(context.includedFiles)) {
            this.includedFiles.clear();
            
            for (const relativePath of context.includedFiles) {
                const absolutePath = path.join(workspaceRoot, relativePath);
                try {
                    await fs.promises.access(absolutePath);
                    this.includedFiles.add(absolutePath);
                } catch {
                    console.warn(`Saved template file not found: ${relativePath}`);
                }
            }
            
            console.log(`Restored ${this.includedFiles.size} files from template context`);
        }

        // Restore selected template if specified
        if (context.selectedTemplate) {
            this.selectedTemplate = context.selectedTemplate;
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
            
            try {
                await fs.promises.access(configFile);
                const raw = await fs.promises.readFile(configFile, 'utf8');
                const config = JSON.parse(raw);
                const relativeTemplatePath = path.relative(workspaceFolder.uri.fsPath, this.currentFile.fsPath);
                
                if (config[relativeTemplatePath]) {
                    delete config[relativeTemplatePath];
                    await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2));
                    console.log('Removed data file link from config');
                }
            } catch {
                // Config file doesn't exist, nothing to remove
            }
        } catch (error) {
            console.error('Error removing data file link:', error);
        }

        // Set flag to prevent loadTemplateData from re-discovering auto-named files
        this.dataFileUnlinked = true;
        
        // Clear current data file path and reset template data
        this.currentDataFilePath = undefined;
        this.templateData = {};
    }

    private async getConfigLinkedDataFile(templatePath: string, workspaceRoot: string): Promise<string | undefined> {
        try {
            const configFile = path.join(workspaceRoot, '.vscode', 'template-data-links.json');
            
            try {
                await fs.promises.access(configFile);
            } catch {
                return undefined;
            }

            const raw = await fs.promises.readFile(configFile, 'utf8');
            const config = JSON.parse(raw);
            
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
            const content = await fs.promises.readFile(templatePath, 'utf8');
            
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
        await fs.promises.mkdir(configDir, { recursive: true });

        // Load existing config or create new
        let config: Record<string, string> = {};
        try {
            await fs.promises.access(configFile);
            const raw = await fs.promises.readFile(configFile, 'utf8');
            config = JSON.parse(raw);
        } catch {
            // File doesn't exist yet, start with empty config
        }

        // Store as workspace-relative paths
        const relativeTemplatePath = path.relative(workspaceRoot, templatePath);
        const relativeDataPath = path.relative(workspaceRoot, dataFilePath);
        
        config[relativeTemplatePath] = relativeDataPath;

        // Save config
        await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log('Saved data file link:', relativeTemplatePath, '->', relativeDataPath);
        
        // Clear unlink flag since user is now explicitly linking a file
        this.dataFileUnlinked = false;
        
        // If this is the current file, update the data file path and reload
        if (this.currentFile && templatePath === this.currentFile.fsPath) {
            this.currentDataFilePath = dataFilePath;
            
            try {
                const content = await fs.promises.readFile(dataFilePath, 'utf8');
                const parsed = JSON.parse(content);
                // Remove _templateContext from runtime data if present
                const { _templateContext, ...dataOnly } = parsed;
                this.templateData = dataOnly;
                console.log('Loaded newly linked data file');
            } catch (error) {
                console.error('Error loading linked data file:', error);
            }
        }
    }

    public refresh() {
        this.scheduleAnalyzeAndRender(0); // Immediate for explicit refresh
    }

    public dispose() {
        // Clear any pending debounce timer
        if (this.analyzeDebounceTimer) {
            clearTimeout(this.analyzeDebounceTimer);
        }
        
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