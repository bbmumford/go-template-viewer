import * as vscode from 'vscode';
import * as path from 'path';
import { TemplateDependency, HtmxDependency } from './types';

// ============================================================================
// RENDER CONTEXT PROVIDER
// ============================================================================

export class RenderContextProvider implements vscode.TreeDataProvider<RenderContextItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<RenderContextItem | undefined | null | void> = new vscode.EventEmitter<RenderContextItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<RenderContextItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private entryFile?: string;
    private includedFiles: string[] = [];
    private dataFilePath?: string;
    private onChangeEntryCallback?: () => void;
    private onAddFileCallback?: () => void;
    private onRemoveFileCallback?: (filePath: string) => void;
    private onChangeDataFileCallback?: () => void;
    private onSaveDataFileCallback?: () => void;

    constructor() {}

    refresh(entryFile?: string, includedFiles?: string[], dataFilePath?: string): void {
        this.entryFile = entryFile;
        this.includedFiles = includedFiles || [];
        this.dataFilePath = dataFilePath;
        this._onDidChangeTreeData.fire();
    }

    onChangeEntry(callback: () => void): void {
        this.onChangeEntryCallback = callback;
    }

    onAddFile(callback: () => void): void {
        this.onAddFileCallback = callback;
    }

    onRemoveFile(callback: (filePath: string) => void): void {
        this.onRemoveFileCallback = callback;
    }

    onChangeDataFile(callback: () => void): void {
        this.onChangeDataFileCallback = callback;
    }

    onSaveDataFile(callback: () => void): void {
        this.onSaveDataFileCallback = callback;
    }

    getTreeItem(element: RenderContextItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: RenderContextItem): Thenable<RenderContextItem[]> {
        if (!element) {
            const items: RenderContextItem[] = [];

            // Entry file (rendering target) - always show
            items.push(new RenderingItem(this.entryFile, this));

            // Data file
            items.push(new DataFileContextItem(this.dataFilePath, this));

            // Included files section header
            if (this.includedFiles.length > 1) {
                items.push(new SectionHeaderItem('Included Templates'));
                this.includedFiles.slice(1).forEach(file => {
                    items.push(new IncludedTemplateItem(file, this));
                });
            }

            // Add button - only show if we have an entry file
            if (this.entryFile) {
                items.push(new AddTemplateButtonItem(this));
            }

            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}

type RenderContextItem = RenderingItem | DataFileContextItem | IncludedTemplateItem | AddTemplateButtonItem | SectionHeaderItem;

class RenderingItem extends vscode.TreeItem {
    constructor(
        private filePath: string | undefined,
        private provider: RenderContextProvider
    ) {
        let label: string;
        let description: string;
        let tooltip: string;
        
        if (filePath) {
            const fileName = path.basename(filePath);
            label = `Rendering: ${fileName}`;
            description = 'entry file';
            tooltip = `Current entry file: ${filePath}\nClick to change`;
        } else {
            label = 'Rendering: (none)';
            description = 'click to select';
            tooltip = 'No preview open\nClick to select a file to preview';
        }
        
        super(label, vscode.TreeItemCollapsibleState.None);

        this.description = description;
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.yellow'));
        this.contextValue = 'renderingEntry';
        this.command = {
            command: 'goTemplateViewer.changeEntryFile',
            title: 'Change Entry File',
            arguments: []
        };
    }
}

class DataFileContextItem extends vscode.TreeItem {
    constructor(
        private dataFilePath: string | undefined,
        private provider: RenderContextProvider
    ) {
        const label = dataFilePath ? `Data: ${path.basename(dataFilePath)}` : 'Data: (none)';
        super(label, vscode.TreeItemCollapsibleState.None);

        this.description = dataFilePath ? 'click to change' : 'click to select';
        this.tooltip = dataFilePath 
            ? `Data file: ${dataFilePath}\nClick to change or save`
            : 'No data file linked\nClick to select or save current data';
        this.iconPath = new vscode.ThemeIcon('json', new vscode.ThemeColor('charts.purple'));
        this.contextValue = 'dataFileContext';
        this.command = {
            command: 'goTemplateViewer.manageDataFile',
            title: 'Manage Data File',
            arguments: []
        };
    }
}

class SectionHeaderItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = '';
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'sectionHeader';
    }
}

class IncludedTemplateItem extends vscode.TreeItem {
    constructor(
        private filePath: string,
        private provider: RenderContextProvider
    ) {
        const fileName = path.basename(filePath);
        super(` - ${fileName}`, vscode.TreeItemCollapsibleState.None);

        this.description = 'click to remove';
        this.tooltip = `Included template: ${filePath}\nClick to remove from render`;
        this.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.blue'));
        this.contextValue = 'includedTemplate';
        this.command = {
            command: 'goTemplateViewer.removeTemplateFile',
            title: 'Remove from Render',
            arguments: [filePath]
        };
    }
}

class AddTemplateButtonItem extends vscode.TreeItem {
    constructor(private provider: RenderContextProvider) {
        super('Add Template File', vscode.TreeItemCollapsibleState.None);

        this.description = '';
        this.tooltip = 'Add another template file to the render context';
        this.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('charts.green'));
        this.contextValue = 'addTemplateButton';
        this.command = {
            command: 'goTemplateViewer.addTemplateFile',
            title: 'Add Template File',
            arguments: []
        };
    }
}

// ============================================================================
// TEMPLATE VARIABLES PROVIDER
// ============================================================================

export interface TemplateVariable {
    name: string;
    path?: string;
    type: string;
    inferredType?: string;
    value?: any;
    filePath?: string; // Source file for this variable
    context?: string;
}

export interface TemplateInfo {
    name: string;
    filePath: string;
    isBlock: boolean;
    calls: string[];
}

export class TemplateVariablesProvider implements vscode.TreeDataProvider<DataTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DataTreeItem | undefined | null | void> = new vscode.EventEmitter<DataTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DataTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private templateData: any = {};
    private onVariableChangeCallback?: (name: string, value: any) => void;
    private dataFilePath?: string;

    constructor() {}

    setData(data: any, dataFilePath?: string): void {
        this.templateData = data || {};
        this.dataFilePath = dataFilePath;
        this._onDidChangeTreeData.fire();
    }

    getDataFilePath(): string | undefined {
        return this.dataFilePath;
    }

    refresh(variables: TemplateVariable[], includedFiles?: string[]): void {
        // This method signature is kept for compatibility but we ignore variables
        // since we now display the actual data structure
        this._onDidChangeTreeData.fire();
    }

    onVariableChange(callback: (name: string, value: any) => void): void {
        this.onVariableChangeCallback = callback;
    }

    getTreeItem(element: DataTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DataTreeItem): Thenable<DataTreeItem[]> {
        if (!element) {
            // Root level - show all top-level properties
            return Promise.resolve(this.buildTreeItems(this.templateData, ''));
        }

        // Show children of this element
        if (element.value !== null && typeof element.value === 'object') {
            return Promise.resolve(this.buildTreeItems(element.value, element.path));
        }

        return Promise.resolve([]);
    }

    private buildTreeItems(obj: any, parentPath: string): DataTreeItem[] {
        const items: DataTreeItem[] = [];

        if (Array.isArray(obj)) {
            // For arrays, show each item with index
            obj.forEach((item, index) => {
                const path = parentPath ? `${parentPath}[${index}]` : `[${index}]`;
                items.push(new DataTreeItem(
                    `[${index}]`,
                    path,
                    item,
                    this
                ));
            });
        } else if (obj && typeof obj === 'object') {
            // For objects, show each property
            Object.keys(obj).forEach(key => {
                const path = parentPath ? `${parentPath}.${key}` : key;
                items.push(new DataTreeItem(
                    key,
                    path,
                    obj[key],
                    this
                ));
            });
        }

        return items;
    }

    async editValue(item: DataTreeItem): Promise<void> {
        const currentValue = item.value !== undefined && item.value !== null
            ? (typeof item.value === 'object' ? JSON.stringify(item.value, null, 2) : String(item.value))
            : '';
        
        const value = await vscode.window.showInputBox({
            prompt: `Enter value for ${item.label}`,
            placeHolder: typeof item.value,
            value: currentValue,
            validateInput: (text) => {
                if (!text) {
                    return null; // Allow empty
                }
                // Try to parse as JSON for objects/arrays
                if (text.startsWith('{') || text.startsWith('[')) {
                    try {
                        JSON.parse(text);
                        return null;
                    } catch (e) {
                        return 'Invalid JSON';
                    }
                }
                return null;
            }
        });

        if (value !== undefined) {
            let parsedValue: any = value;
            
            if (value === '') {
                parsedValue = '';
            } else if (value.startsWith('{') || value.startsWith('[')) {
                try {
                    parsedValue = JSON.parse(value);
                } catch (e) {
                    parsedValue = value;
                }
            } else if (value === 'true' || value === 'false') {
                parsedValue = value === 'true';
            } else if (!isNaN(Number(value)) && value !== '') {
                parsedValue = Number(value);
            }

            // Update the value in the data structure
            this.setValueAtPath(item.path, parsedValue);
            this._onDidChangeTreeData.fire();
            
            if (this.onVariableChangeCallback) {
                // Notify with entire updated data structure
                this.onVariableChangeCallback('', this.templateData);
            }
        }
    }

    async duplicateArrayItem(item: DataTreeItem): Promise<void> {
        // Parse the path to find parent array and index
        const pathMatch = item.path.match(/^(.+)\[(\d+)\]$/);
        if (!pathMatch) {
            return;
        }

        const arrayPath = pathMatch[1];
        const index = parseInt(pathMatch[2]);
        
        const array = this.getValueAtPath(arrayPath);
        if (!Array.isArray(array)) {
            return;
        }

        // Duplicate the item
        const duplicated = JSON.parse(JSON.stringify(array[index]));
        array.splice(index + 1, 0, duplicated);
        
        this._onDidChangeTreeData.fire();
        
        if (this.onVariableChangeCallback) {
            this.onVariableChangeCallback('', this.templateData);
        }
    }

    async addArrayItem(item: DataTreeItem): Promise<void> {
        const array = item.value;
        if (!Array.isArray(array)) {
            return;
        }

        // Add empty item based on structure of first item
        let newItem: any = {};
        if (array.length > 0) {
            const firstItem = array[0];
            if (typeof firstItem === 'object' && firstItem !== null) {
                // Create empty object with same keys
                newItem = {};
                Object.keys(firstItem).forEach(key => {
                    newItem[key] = '';
                });
            } else {
                newItem = '';
            }
        }
        
        array.push(newItem);
        this._onDidChangeTreeData.fire();
        
        if (this.onVariableChangeCallback) {
            this.onVariableChangeCallback('', this.templateData);
        }
    }

    async deleteItem(item: DataTreeItem): Promise<void> {
        // Check if this is an array item
        const pathMatch = item.path.match(/^(.+)\[(\d+)\]$/);
        if (pathMatch) {
            const arrayPath = pathMatch[1];
            const index = parseInt(pathMatch[2]);
            
            const array = this.getValueAtPath(arrayPath);
            if (Array.isArray(array)) {
                array.splice(index, 1);
                this._onDidChangeTreeData.fire();
                
                if (this.onVariableChangeCallback) {
                    this.onVariableChangeCallback('', this.templateData);
                }
            }
        } else {
            // Delete object property
            const lastDot = item.path.lastIndexOf('.');
            if (lastDot > 0) {
                const parentPath = item.path.substring(0, lastDot);
                const key = item.path.substring(lastDot + 1);
                const parent = this.getValueAtPath(parentPath);
                if (parent && typeof parent === 'object') {
                    delete parent[key];
                    this._onDidChangeTreeData.fire();
                    
                    if (this.onVariableChangeCallback) {
                        this.onVariableChangeCallback('', this.templateData);
                    }
                }
            } else {
                // Root level property
                delete this.templateData[item.path];
                this._onDidChangeTreeData.fire();
                
                if (this.onVariableChangeCallback) {
                    this.onVariableChangeCallback('', this.templateData);
                }
            }
        }
    }

    private getValueAtPath(path: string): any {
        if (!path) {
            return this.templateData;
        }

        const parts = this.parsePath(path);
        let current = this.templateData;

        for (const part of parts) {
            if (current === undefined || current === null) {
                return undefined;
            }
            current = current[part];
        }

        return current;
    }

    private setValueAtPath(path: string, value: any): void {
        const parts = this.parsePath(path);
        let current = this.templateData;

        for (let i = 0; i < parts.length - 1; i++) {
            if (current[parts[i]] === undefined) {
                current[parts[i]] = {};
            }
            current = current[parts[i]];
        }

        current[parts[parts.length - 1]] = value;
    }

    private parsePath(path: string): (string | number)[] {
        const parts: (string | number)[] = [];
        const segments = path.split(/\.|\[|\]/).filter(s => s !== '');
        
        for (const seg of segments) {
            if (/^\d+$/.test(seg)) {
                parts.push(parseInt(seg));
            } else {
                parts.push(seg);
            }
        }
        
        return parts;
    }
}

export class DataTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly path: string,
        public readonly value: any,
        private provider: TemplateVariablesProvider
    ) {
        const isExpandable = value !== null && typeof value === 'object';
        super(label, isExpandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        
        this.description = this.getDescription();
        this.tooltip = this.getTooltip();
        this.iconPath = this.getIcon();
        this.contextValue = this.getContextValue();
        
        // Make non-expandable items editable
        if (!isExpandable) {
            this.command = {
                command: 'goTemplateViewer.editDataValue',
                title: 'Edit Value',
                arguments: [this]
            };
        }
    }

    private getDescription(): string {
        if (this.value === null) {
            return 'null';
        }
        if (this.value === undefined) {
            return 'undefined';
        }
        if (Array.isArray(this.value)) {
            return `array[${this.value.length}]`;
        }
        if (typeof this.value === 'object') {
            return 'object';
        }
        if (typeof this.value === 'string') {
            return `"${this.value}"`;
        }
        return String(this.value);
    }

    private getTooltip(): string {
        const parts = [`Path: ${this.path}`];
        
        if (typeof this.value === 'object' && this.value !== null) {
            parts.push(`Type: ${Array.isArray(this.value) ? 'array' : 'object'}`);
        } else {
            parts.push(`Type: ${typeof this.value}`);
            parts.push(`Value: ${this.value}`);
        }
        
        return parts.join('\n');
    }

    private getIcon(): vscode.ThemeIcon {
        if (Array.isArray(this.value)) {
            return new vscode.ThemeIcon('symbol-array', new vscode.ThemeColor('symbolIcon.arrayForeground'));
        }
        if (typeof this.value === 'object' && this.value !== null) {
            return new vscode.ThemeIcon('symbol-object', new vscode.ThemeColor('symbolIcon.objectForeground'));
        }
        if (typeof this.value === 'string') {
            return new vscode.ThemeIcon('symbol-string', new vscode.ThemeColor('symbolIcon.stringForeground'));
        }
        if (typeof this.value === 'number') {
            return new vscode.ThemeIcon('symbol-number', new vscode.ThemeColor('symbolIcon.numberForeground'));
        }
        if (typeof this.value === 'boolean') {
            return new vscode.ThemeIcon('symbol-boolean', new vscode.ThemeColor('symbolIcon.booleanForeground'));
        }
        return new vscode.ThemeIcon('symbol-field');
    }

    private getContextValue(): string {
        const isArray = Array.isArray(this.value);
        const isArrayItem = /\[\d+\]$/.test(this.path);
        
        if (isArrayItem) {
            return 'arrayItem';
        }
        if (isArray) {
            return 'array';
        }
        if (typeof this.value === 'object' && this.value !== null) {
            return 'object';
        }
        return 'value';
    }
}

// Keep VariableItem export for backward compatibility with extension.ts
export type VariableItem = DataTreeItem;

// ============================================================================
// TEMPLATE DEPENDENCIES PROVIDER
// ============================================================================

export class TemplateDependenciesProvider implements vscode.TreeDataProvider<DependencyTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DependencyTreeItem | undefined | null | void> = new vscode.EventEmitter<DependencyTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DependencyTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private dependencies: TemplateDependency[] = [];
    private templates: any[] = []; // All available templates from workspace
    private includedFiles: string[] = []; // Files actually included in render
    private htmxDependencies: HtmxDependency[] = [];
    private htmxDetected: boolean = false;
    private htmxVersion?: string;

    constructor() {}

    refresh(dependencies: TemplateDependency[], templates?: any[], includedFiles?: string[], htmxInfo?: { detected: boolean; version?: string; dependencies: HtmxDependency[] }): void {
        console.log('TemplateDependenciesProvider.refresh called:', {
            dependencies: dependencies.map(d => d.name),
            templates: templates?.map(t => t.name),
            includedFiles,
            htmxDetected: htmxInfo?.detected,
            htmxDepsCount: htmxInfo?.dependencies.length
        });
        
        this.dependencies = dependencies;
        
        if (templates) {
            this.templates = templates;
        }
        
        if (includedFiles) {
            this.includedFiles = includedFiles;
        }

        if (htmxInfo) {
            this.htmxDetected = htmxInfo.detected;
            this.htmxVersion = htmxInfo.version;
            this.htmxDependencies = htmxInfo.dependencies || [];
        }
        
        // Mark which dependencies are satisfied by INCLUDED files only
        this.dependencies.forEach(dep => {
            const provider = this.templates.find(t => t.name === dep.name);
            
            if (provider) {
                // Check if this provider is in the included files
                dep.satisfied = this.includedFiles.some(file => 
                    provider.filePath.includes(path.basename(file))
                );
                dep.providedBy = provider.filePath;
                console.log(`Dependency '${dep.name}': satisfied=${dep.satisfied}, provider=${provider.filePath}, included=${this.includedFiles}`);
            } else {
                dep.satisfied = false;
                dep.providedBy = undefined;
                console.log(`Dependency '${dep.name}': no provider found`);
            }
        });
        
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DependencyTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DependencyTreeItem): Thenable<DependencyTreeItem[]> {
        if (!element) {
            const items: DependencyTreeItem[] = [];

            // Template dependencies section
            if (this.dependencies.length > 0) {
                items.push(new DependencySectionHeaderItem('Template Dependencies'));
                items.push(...this.dependencies.map(dep => new DependencyItem(dep)));
            }

            // HTMX section - only show if detected AND has dependencies
            if (this.htmxDetected && this.htmxDependencies.length > 0) {
                const htmxHeader = new HtmxSectionHeaderItem(
                    this.htmxVersion ? `HTMX (v${this.htmxVersion})` : 'HTMX Endpoints',
                    this.htmxDependencies.length
                );
                items.push(htmxHeader);
            }

            return Promise.resolve(items);
        }

        // Handle collapsible sections
        if (element instanceof HtmxSectionHeaderItem) {
            if (this.htmxDependencies.length === 0) {
                return Promise.resolve([new HtmxStatusItem('No HTMX requests found', true)]);
            }

            // Group by type
            const items: DependencyTreeItem[] = [];
            const byType = new Map<string, HtmxDependency[]>();
            for (const dep of this.htmxDependencies) {
                if (!byType.has(dep.type)) {
                    byType.set(dep.type, []);
                }
                byType.get(dep.type)!.push(dep);
            }

            // Add items grouped by type
            for (const [type, deps] of byType) {
                items.push(new HtmxTypeHeaderItem(type, deps.length));
                for (const dep of deps) {
                    items.push(new HtmxRequestItem(dep));
                }
            }

            return Promise.resolve(items);
        }

        return Promise.resolve([]);
    }
}

type DependencyTreeItem = DependencyItem | DependencySectionHeaderItem | HtmxSectionHeaderItem | HtmxStatusItem | HtmxTypeHeaderItem | HtmxRequestItem;

class DependencySectionHeaderItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        this.contextValue = 'dependencySectionHeader';
    }
}

class HtmxSectionHeaderItem extends vscode.TreeItem {
    constructor(label: string, count: number) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = count > 0 ? `${count} requests` : 'no requests';
        this.iconPath = new vscode.ThemeIcon('globe', new vscode.ThemeColor('charts.purple'));
        this.contextValue = 'htmxSectionHeader';
    }
}

export class DependencyItem extends vscode.TreeItem {
    constructor(public readonly dependency: TemplateDependency) {
        super(dependency.name, vscode.TreeItemCollapsibleState.None);
        
        // Show satisfaction status
        const status = dependency.satisfied ? '✅' : '❌';
        const typeLabel = dependency.type === 'template' ? 'template' : 'block';
        
        // Show filename if satisfied
        if (dependency.satisfied && dependency.providedBy) {
            const fileName = path.basename(dependency.providedBy);
            this.description = `${status} ${fileName}`;
        } else {
            this.description = `${status} ${typeLabel}`;
        }
        
        // Build tooltip
        const tooltipParts = [
            `${typeLabel}: ${dependency.name}`,
            dependency.satisfied 
                ? `✅ Provided by: ${dependency.providedBy}` 
                : `❌ Missing - add a template file that defines "${dependency.name}"`
        ];
        this.tooltip = tooltipParts.join('\n');
        
        // Different icons based on status
        if (dependency.satisfied) {
            this.iconPath = new vscode.ThemeIcon(
                dependency.type === 'template' ? 'file-symlink-file' : 'symbol-method',
                new vscode.ThemeColor('testing.iconPassed')
            );
        } else {
            this.iconPath = new vscode.ThemeIcon(
                'warning',
                new vscode.ThemeColor('testing.iconFailed')
            );
                        // Make it clickable to add the file
            this.contextValue = 'missingDependency';
            this.command = {
                command: 'goTemplateViewer.addTemplateFile',
                title: 'Add Template File',
                arguments: [dependency.name]
            };
        }
    }
}

// ============================================================================
// HTMX TREE ITEM CLASSES
// ============================================================================

class HtmxStatusItem extends vscode.TreeItem {
    constructor(
        message: string,
        detected: boolean
    ) {
        super(message, vscode.TreeItemCollapsibleState.None);
        
        this.iconPath = new vscode.ThemeIcon(
            detected ? 'check' : 'close',
            detected ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('charts.gray')
        );
        this.contextValue = 'htmxStatus';
    }
}

class HtmxTypeHeaderItem extends vscode.TreeItem {
    constructor(
        type: string,
        count: number
    ) {
        super(`${type} (${count})`, vscode.TreeItemCollapsibleState.None);
        
        this.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.blue'));
        this.contextValue = 'htmxTypeHeader';
        this.description = '';
    }
}

class HtmxRequestItem extends vscode.TreeItem {
    constructor(
        public readonly dependency: HtmxDependency
    ) {
        const fileName = path.basename(dependency.filePath);
        
        // All HTMX requests are non-collapsible now (no children to show)
        super(dependency.url, vscode.TreeItemCollapsibleState.None);
        
        this.description = fileName;
        this.tooltip = this.buildTooltip(dependency);
        
        // Simple icon based on request type
        const iconName = dependency.type === 'hx-get' ? 'arrow-down' : 'arrow-up';
        this.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.purple'));
        
        this.contextValue = 'htmxRequest';
        
        // Make clickable to jump to source
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [
                vscode.Uri.file(dependency.filePath),
                { selection: new vscode.Range((dependency.line || 1) - 1, 0, (dependency.line || 1) - 1, 0) }
            ]
        };
    }

    private buildTooltip(dep: HtmxDependency): string {
        const parts = [
            `URL: ${dep.url}`,
            `Type: ${dep.type}`,
            `File: ${dep.filePath}:${dep.line}`
        ];
        
        if (dep.target) {
            parts.push(`Target: ${dep.target}`);
        }
        if (dep.swap) {
            parts.push(`Swap: ${dep.swap}`);
        }
        if (dep.trigger) {
            parts.push(`Trigger: ${dep.trigger}`);
        }
        if (dep.context) {
            parts.push(`\nContext: ${dep.context}`);
        }
        
        return parts.join('\n');
    }
}

// ============================================================================
// SERVER INFO PROVIDER
// ============================================================================

export interface ServerInfoData {
    mode: 'context' | 'convention' | 'unknown';
    port: number;
    // Context mode
    entryFile?: string;
    contextFiles?: string[];
    dataFile?: string;
    dataDir?: string;
    contentRoot?: string;
    // Convention mode
    pagesDir?: string;
    layoutsDir?: string;
    partialsDir?: string;
    staticDir?: string;
    layoutFile?: string;
    // Discovered from server logs
    sharedFiles?: string[];
    discoveredPages?: Array<{ url: string; file: string }>;
    watchedDirs?: string[];
}

export class ServerInfoProvider implements vscode.TreeDataProvider<ServerInfoItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ServerInfoItem | undefined | null | void> = new vscode.EventEmitter<ServerInfoItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ServerInfoItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private info: ServerInfoData | undefined;

    constructor() {}

    refresh(info?: ServerInfoData): void {
        this.info = info;
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.info = undefined;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ServerInfoItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ServerInfoItem): Thenable<ServerInfoItem[]> {
        if (!this.info) {
            return Promise.resolve([]);
        }

        if (!element) {
            // Root level
            const items: ServerInfoItem[] = [];
            const info = this.info;

            // Server status
            items.push(new ServerInfoValueItem(
                `Server :${info.port}`,
                `http://localhost:${info.port}`,
                'radio-tower',
                'charts.green'
            ));

            // Mode
            const modeLabel = info.mode === 'context' ? 'Context Mode' : 'Convention Mode';
            const modeIcon = info.mode === 'context' ? 'extensions' : 'folder-library';
            items.push(new ServerInfoValueItem(modeLabel, '', modeIcon, 'charts.blue'));

            if (info.mode === 'context') {
                // Context mode sections
                if (info.entryFile) {
                    items.push(new ServerInfoValueItem(
                        `Entry: ${path.basename(info.entryFile)}`,
                        path.dirname(info.entryFile),
                        'target',
                        'charts.yellow'
                    ));
                }

                // Shared files section
                if (info.sharedFiles && info.sharedFiles.length > 0) {
                    items.push(new ServerInfoSectionItem('Shared Templates', info.sharedFiles.length, 'files', info.sharedFiles.map(f => ({
                        label: path.basename(f),
                        description: vscode.workspace.asRelativePath(f, false),
                        icon: 'file-code',
                        color: 'charts.blue'
                    }))));
                }

                // Discovered pages section
                if (info.discoveredPages && info.discoveredPages.length > 0) {
                    items.push(new ServerInfoSectionItem('Discovered Pages', info.discoveredPages.length, 'book', info.discoveredPages.map(p => ({
                        label: p.url,
                        description: path.basename(p.file),
                        icon: 'globe',
                        color: 'charts.purple'
                    }))));
                }

                // Data
                if (info.dataFile) {
                    items.push(new ServerInfoValueItem(
                        `Data: ${path.basename(info.dataFile)}`,
                        vscode.workspace.asRelativePath(info.dataFile, false),
                        'json',
                        'charts.purple'
                    ));
                }

            } else if (info.mode === 'convention') {
                // Convention mode directories
                if (info.pagesDir) {
                    items.push(new ServerInfoDirItem('Pages', info.pagesDir));
                }
                if (info.layoutsDir) {
                    items.push(new ServerInfoDirItem('Layouts', info.layoutsDir));
                }
                if (info.partialsDir) {
                    items.push(new ServerInfoDirItem('Partials', info.partialsDir));
                }
                if (info.staticDir) {
                    items.push(new ServerInfoDirItem('Static', info.staticDir));
                }
                if (info.layoutFile) {
                    items.push(new ServerInfoValueItem(
                        `Layout: ${info.layoutFile}`,
                        '',
                        'file-code',
                        'charts.blue'
                    ));
                }
            }

            // Watched directories
            if (info.watchedDirs && info.watchedDirs.length > 0) {
                items.push(new ServerInfoSectionItem('Watched Directories', info.watchedDirs.length, 'eye', info.watchedDirs.map(d => ({
                    label: path.basename(d),
                    description: vscode.workspace.asRelativePath(d, false),
                    icon: 'folder',
                    color: 'charts.orange'
                }))));
            }

            // Content root
            if (info.contentRoot) {
                items.push(new ServerInfoDirItem('Content Root', info.contentRoot));
            }

            return Promise.resolve(items);
        }

        // Section children
        if (element instanceof ServerInfoSectionItem) {
            return Promise.resolve(element.children.map(c =>
                new ServerInfoValueItem(c.label, c.description, c.icon, c.color)
            ));
        }

        return Promise.resolve([]);
    }
}

type ServerInfoItem = ServerInfoValueItem | ServerInfoSectionItem | ServerInfoDirItem;

class ServerInfoValueItem extends vscode.TreeItem {
    constructor(
        label: string,
        description: string,
        icon: string,
        color: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        this.contextValue = 'serverInfoValue';
    }
}

class ServerInfoDirItem extends vscode.TreeItem {
    constructor(
        label: string,
        dirPath: string
    ) {
        const relativePath = vscode.workspace.asRelativePath(dirPath, false);
        super(`${label}: ${relativePath}`, vscode.TreeItemCollapsibleState.None);
        this.description = '';
        this.tooltip = dirPath;
        this.iconPath = new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('charts.orange'));
        this.contextValue = 'serverInfoDir';
        this.command = {
            command: 'revealInExplorer',
            title: 'Reveal in Explorer',
            arguments: [vscode.Uri.file(dirPath)]
        };
    }
}

class ServerInfoSectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        count: number,
        icon: string,
        public readonly children: Array<{ label: string; description: string; icon: string; color: string }>
    ) {
        super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor('charts.blue'));
        this.contextValue = 'serverInfoSection';
    }
}
