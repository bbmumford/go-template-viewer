import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { showTimedNotification, getHelperBinaryName } from './utils';
import { GoTemplatePreviewProvider } from './previewProvider';

export interface ServerConfig {
    pagesDir: string;
    layoutsDir: string;
    partialsDir: string;
    staticDir: string;
    layoutFile: string;
    indexFile: string;
    port: number;
    // Context-driven mode fields
    contextFiles?: string[];
    entryFile?: string;
    dataFile?: string;
    dataDir?: string;
    contentRoot?: string;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ServerLogData {
    sharedFiles: string[];
    discoveredPages: Array<{ url: string; file: string }>;
    watchedDirs: string[];
    mode: 'context' | 'convention' | 'unknown';
}

export class DevServerProvider implements vscode.Disposable {
    private process: ChildProcess | undefined;
    private status: ServerStatus = 'stopped';
    private port: number = 0;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;
    private onStatusChangeCallback?: (status: ServerStatus, port?: number) => void;
    private onServerInfoCallback?: (config: ServerConfig | undefined, logData: ServerLogData) => void;
    private disposables: vscode.Disposable[] = [];
    private previewProvider?: GoTemplatePreviewProvider;
    private lastConfig?: ServerConfig;
    private logData: ServerLogData = { sharedFiles: [], discoveredPages: [], watchedDirs: [], mode: 'unknown' };

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('Go Template Server');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'goTemplateViewer.toggleServer';
        this.updateStatusBar();
        this.statusBarItem.show();
        this.disposables.push(this.outputChannel, this.statusBarItem);
    }

    onStatusChange(callback: (status: ServerStatus, port?: number) => void) {
        this.onStatusChangeCallback = callback;
    }

    onServerInfo(callback: (config: ServerConfig | undefined, logData: ServerLogData) => void) {
        this.onServerInfoCallback = callback;
    }

    getLastConfig(): ServerConfig | undefined {
        return this.lastConfig;
    }

    getLogData(): ServerLogData {
        return this.logData;
    }

    setPreviewProvider(provider: GoTemplatePreviewProvider) {
        this.previewProvider = provider;
    }

    getStatus(): ServerStatus {
        return this.status;
    }

    getPort(): number {
        return this.port;
    }

    isRunning(): boolean {
        return this.status === 'running';
    }

    async startServer(): Promise<void> {
        if (this.status === 'running' || this.status === 'starting') {
            showTimedNotification('Server is already running', 'info');
            return;
        }

        const helperBinaryName = getHelperBinaryName();
        const helperPath = path.join(this.context.extensionPath, 'bin', helperBinaryName);

        if (!fs.existsSync(helperPath)) {
            showTimedNotification('Go helper binary not found. Build it first.', 'error');
            return;
        }

        const config = this.buildConfig();
        if (!config) {
            return;
        }

        this.lastConfig = config;
        this.logData = {
            sharedFiles: [],
            discoveredPages: [],
            watchedDirs: [],
            mode: (config.contextFiles && config.contextFiles.length > 0) ? 'context' : 'convention'
        };

        this.setStatus('starting');
        this.outputChannel.clear();
        this.outputChannel.appendLine(`Starting Go Template Dev Server...`);
        
        if (config.contextFiles && config.contextFiles.length > 0) {
            this.outputChannel.appendLine(`  Entry:    ${path.basename(config.entryFile || '')}`);
            this.outputChannel.appendLine(`  Files:    ${config.contextFiles.map(f => path.basename(f)).join(', ')}`);
            if (config.dataFile) {
                this.outputChannel.appendLine(`  Data:     ${path.basename(config.dataFile)}`);
            }
        } else {
            this.outputChannel.appendLine(`  Pages:    ${config.pagesDir}`);
            this.outputChannel.appendLine(`  Layouts:  ${config.layoutsDir}`);
            this.outputChannel.appendLine(`  Partials: ${config.partialsDir}`);
            this.outputChannel.appendLine(`  Static:   ${config.staticDir}`);
            this.outputChannel.appendLine(`  Layout:   ${config.layoutFile}`);
        }
        this.outputChannel.appendLine(`  Port:     ${config.port}`);
        this.outputChannel.appendLine('');

        const configJSON = JSON.stringify(config);

        try {
            this.process = spawn(helperPath, ['serve', '-config', configJSON], {
                cwd: this.getWorkspaceRoot(config.entryFile),
                env: { ...process.env },
            });

            this.process.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                this.outputChannel.append(text);

                // Look for the SERVE_READY signal with port number
                const match = text.match(/SERVE_READY\|port=(\d+)/);
                if (match) {
                    this.port = parseInt(match[1], 10);
                    this.setStatus('running');
                    this.notifyServerInfo();
                    showTimedNotification(`Server running at http://localhost:${this.port}`);
                }
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                const text = data.toString();
                this.outputChannel.append(text);
                this.parseServerLog(text);
            });

            this.process.on('close', (code) => {
                this.outputChannel.appendLine(`\nServer process exited with code ${code}`);
                if (this.status !== 'stopped') {
                    this.setStatus(code === 0 ? 'stopped' : 'error');
                    if (code !== 0 && code !== null) {
                        showTimedNotification(`Server exited with code ${code}`, 'error');
                    }
                }
                this.process = undefined;
                this.port = 0;
            });

            this.process.on('error', (err) => {
                this.outputChannel.appendLine(`Server error: ${err.message}`);
                this.setStatus('error');
                showTimedNotification(`Server error: ${err.message}`, 'error');
                this.process = undefined;
                this.port = 0;
            });

        } catch (error) {
            this.setStatus('error');
            showTimedNotification(`Failed to start server: ${error}`, 'error');
        }
    }

    async stopServer(): Promise<void> {
        if (!this.process) {
            this.setStatus('stopped');
            return;
        }

        this.outputChannel.appendLine('\nStopping server...');
        this.setStatus('stopped');

        // Kill the process tree
        if (process.platform === 'win32') {
            // On Windows, use taskkill to kill the process tree
            const { exec } = require('child_process');
            exec(`taskkill /pid ${this.process.pid} /T /F`, () => {});
        } else {
            this.process.kill('SIGTERM');
            // Force kill after 3 seconds if still running
            const proc = this.process;
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            }, 3000);
        }

        this.process = undefined;
        this.port = 0;
        this.lastConfig = undefined;
        this.logData = { sharedFiles: [], discoveredPages: [], watchedDirs: [], mode: 'unknown' };
        this.notifyServerInfo();
        showTimedNotification('Server stopped');
    }

    async toggleServer(): Promise<void> {
        if (this.isRunning() || this.status === 'starting') {
            await this.stopServer();
        } else {
            await this.startServer();
        }
    }

    async openInBrowser(): Promise<void> {
        if (!this.isRunning()) {
            showTimedNotification('Server is not running. Start it first.', 'warning');
            return;
        }
        const url = `http://localhost:${this.port}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private buildConfig(): ServerConfig | undefined {
        // Check if we have an active render context from the preview provider
        const entryFile = this.previewProvider?.getCurrentFile();
        const includedFiles = this.previewProvider?.getIncludedFiles() ?? [];
        const dataFilePath = this.previewProvider?.getDataFilePath();

        // Resolve workspace root relative to the entry file (or first folder as fallback)
        const workspaceRoot = this.getWorkspaceRoot(entryFile);
        if (!workspaceRoot) {
            showTimedNotification('No workspace folder open', 'error');
            return undefined;
        }

        const vsConfig = vscode.workspace.getConfiguration('goTemplateViewer');
        const port = vsConfig.get<number>('serverPort', 3000);
        const contentRoot = vsConfig.get<string>('contentRoot', '');

        if (entryFile && includedFiles.length > 0) {
            // Context-driven mode: use the extension's render context
            const dataDir = path.join(workspaceRoot, '.vscode', 'template-data');

            this.outputChannel.appendLine('Mode: Context-driven (using render context)');

            return {
                // Convention fields are empty in context mode
                pagesDir: '',
                layoutsDir: '',
                partialsDir: '',
                staticDir: '',
                layoutFile: '',
                indexFile: '',
                port,
                // Context-driven fields
                contextFiles: includedFiles,
                entryFile: entryFile,
                dataFile: dataFilePath || '',
                dataDir: fs.existsSync(dataDir) ? dataDir : '',
                contentRoot: contentRoot ? (path.isAbsolute(contentRoot) ? contentRoot : path.join(workspaceRoot, contentRoot)) : '',
            };
        }

        // Convention mode: use configured directories
        const pagesDir = vsConfig.get<string>('serverPagesDir', 'pages');
        const layoutsDir = vsConfig.get<string>('serverLayoutsDir', 'layouts');
        const partialsDir = vsConfig.get<string>('serverPartialsDir', 'partials');
        const staticDir = vsConfig.get<string>('serverStaticDir', 'static');
        const layoutFile = vsConfig.get<string>('serverLayoutFile', 'base.html');
        const indexFile = vsConfig.get<string>('serverIndexFile', '');

        const resolve = (dir: string) => path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);

        const resolvedPagesDir = resolve(pagesDir);
        if (!fs.existsSync(resolvedPagesDir)) {
            showTimedNotification(
                `No active preview context and pages directory not found: ${pagesDir}. ` +
                `Either open a template preview first, or create a ${pagesDir}/ directory.`,
                'error'
            );
            return undefined;
        }

        this.outputChannel.appendLine('Mode: Convention-based (pages/layouts/partials)');

        return {
            pagesDir: resolvedPagesDir,
            layoutsDir: resolve(layoutsDir),
            partialsDir: resolve(partialsDir),
            staticDir: resolve(staticDir),
            layoutFile,
            indexFile,
            port,
        };
    }

    private getWorkspaceRoot(forFile?: string): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }

        // If a file path is given, find the workspace folder that contains it
        if (forFile) {
            const fileUri = vscode.Uri.file(forFile);
            const folder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (folder) {
                return folder.uri.fsPath;
            }
        }

        // Fallback: use the first workspace folder
        return folders[0].uri.fsPath;
    }

    private setStatus(status: ServerStatus) {
        this.status = status;
        this.updateStatusBar();
        vscode.commands.executeCommand('setContext', 'goTemplateServerRunning', status === 'running');
        vscode.commands.executeCommand('setContext', 'goTemplateServerStatus', status);
        this.onStatusChangeCallback?.(status, this.port);
    }

    private updateStatusBar() {
        switch (this.status) {
            case 'stopped':
                this.statusBarItem.text = '$(play) Template Server';
                this.statusBarItem.tooltip = 'Click to start the Go Template Dev Server';
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'starting':
                this.statusBarItem.text = '$(loading~spin) Template Server';
                this.statusBarItem.tooltip = 'Server is starting...';
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'running':
                this.statusBarItem.text = `$(debug-stop) Server :${this.port}`;
                this.statusBarItem.tooltip = `Server running at http://localhost:${this.port}\nClick to stop`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case 'error':
                this.statusBarItem.text = '$(error) Template Server';
                this.statusBarItem.tooltip = 'Server encountered an error. Click to restart.';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }
    }

    showOutput() {
        this.outputChannel.show();
    }

    private parseServerLog(text: string) {
        const lines = text.split('\n');
        let changed = false;

        for (const line of lines) {
            // Shared files: "📄 Shared (entry): base.html" or "📄 Shared (partial): navbar.html"
            // or "📄 Auto-discovered shared: partials/navbar.html"
            const sharedMatch = line.match(/Shared \((entry|partial)\):\s*(.+)/);
            if (sharedMatch) {
                const file = sharedMatch[2].trim();
                if (!this.logData.sharedFiles.includes(file)) {
                    this.logData.sharedFiles.push(file);
                    changed = true;
                }
            }
            const autoSharedMatch = line.match(/Auto-discovered shared:\s*(.+)/);
            if (autoSharedMatch) {
                const file = autoSharedMatch[1].trim();
                if (!this.logData.sharedFiles.includes(file)) {
                    this.logData.sharedFiles.push(file);
                    changed = true;
                }
            }

            // Discovered pages: "📑 Page: /dashboard → dashboard.html"
            const pageMatch = line.match(/Page:\s*(\S+)\s*→\s*(\S+)/);
            if (pageMatch) {
                const url = pageMatch[1].trim();
                const file = pageMatch[2].trim();
                if (!this.logData.discoveredPages.some(p => p.url === url)) {
                    this.logData.discoveredPages.push({ url, file });
                    changed = true;
                }
            }

            // Convention mode directories from config
            // (these come from our own outputChannel lines, not stderr, but
            //  the watched dirs come from the Go server's log output)
        }

        if (changed) {
            this.notifyServerInfo();
        }
    }

    private notifyServerInfo() {
        if (this.onServerInfoCallback) {
            this.onServerInfoCallback(this.lastConfig, this.logData);
        }
    }

    dispose() {
        if (this.process) {
            this.stopServer();
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
