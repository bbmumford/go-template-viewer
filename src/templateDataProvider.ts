import * as vscode from 'vscode';
import { GoTemplateParser, ParsedTemplate, GoTemplateVariable, GoTemplateDependency } from './goTemplateParser';

export class TemplateDataProvider implements vscode.TreeDataProvider<TemplateDataItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TemplateDataItem | undefined | null | void> = new vscode.EventEmitter<TemplateDataItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TemplateDataItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private parsedData: ParsedTemplate | undefined;

    constructor() {}

    refresh(parsedData?: ParsedTemplate): void {
        this.parsedData = parsedData;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TemplateDataItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TemplateDataItem): Thenable<TemplateDataItem[]> {
        if (!this.parsedData) {
            return Promise.resolve([]);
        }

        if (!element) {
            // Root level items
            return Promise.resolve([
                new TemplateDataItem(
                    'Variables',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'variables',
                    undefined,
                    this.parsedData.variables.length
                ),
                new TemplateDataItem(
                    'Dependencies',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'dependencies',
                    undefined,
                    this.parsedData.dependencies.length
                ),
                new TemplateDataItem(
                    'Functions',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'functions',
                    undefined,
                    this.parsedData.functions.length
                )
            ]);
        } else {
            // Child items
            switch (element.contextValue) {
                case 'variables':
                    return Promise.resolve(
                        this.parsedData.variables.map(variable => 
                            new TemplateDataItem(
                                `${variable.name} (${variable.type})`,
                                vscode.TreeItemCollapsibleState.None,
                                'variable',
                                variable
                            )
                        )
                    );
                case 'dependencies':
                    return Promise.resolve(
                        this.parsedData.dependencies.map(dep => 
                            new TemplateDataItem(
                                `${dep.name} (${dep.type})`,
                                vscode.TreeItemCollapsibleState.None,
                                'dependency',
                                dep
                            )
                        )
                    );
                case 'functions':
                    return Promise.resolve(
                        this.parsedData.functions.map(func => 
                            new TemplateDataItem(
                                func,
                                vscode.TreeItemCollapsibleState.None,
                                'function',
                                { name: func, type: 'function' }
                            )
                        )
                    );
                default:
                    return Promise.resolve([]);
            }
        }
    }
}

export class TemplateDataItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly data?: GoTemplateVariable | GoTemplateDependency | any,
        public readonly count?: number
    ) {
        super(label, collapsibleState);

        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
    }

    private getTooltip(): string {
        if (this.contextValue === 'variable' && this.data) {
            return `Variable: ${this.data.name} (Type: ${this.data.type})${this.data.line ? ` at line ${this.data.line}` : ''}`;
        } else if (this.contextValue === 'dependency' && this.data) {
            return `Dependency: ${this.data.name} (Type: ${this.data.type})${this.data.line ? ` at line ${this.data.line}` : ''}`;
        } else if (this.contextValue === 'function' && this.data) {
            return `Function: ${this.data.name}`;
        }
        return this.label;
    }

    private getDescription(): string {
        if (this.count !== undefined) {
            return `(${this.count})`;
        }
        if (this.data && this.data.line) {
            return `Line ${this.data.line}`;
        }
        return '';
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.contextValue) {
            case 'variables':
                return new vscode.ThemeIcon('symbol-variable');
            case 'dependencies':
                return new vscode.ThemeIcon('references');
            case 'functions':
                return new vscode.ThemeIcon('symbol-function');
            case 'variable':
                return new vscode.ThemeIcon('symbol-field');
            case 'dependency':
                return new vscode.ThemeIcon('file-symlink-file');
            case 'function':
                return new vscode.ThemeIcon('symbol-method');
            default:
                return new vscode.ThemeIcon('file');
        }
    }
}