/**
 * Type definitions for Go Template Viewer
 */

export interface TemplateVariable {
    path: string;
    type: string;
    context: string;
    filePath: string;
    suggested?: any;
    inferredType?: string;
}

export interface TemplateDependency {
    name: string;
    type: 'template' | 'block' | 'define' | string;
    path?: string;
    filePath?: string;
    required: boolean;
    satisfied?: boolean; // Whether this dependency is met by included files
    providedBy?: string; // Which file provides this
}

export interface TemplateDefinition {
    name: string;
    filePath: string;
    isBlock?: boolean;
    calls?: string[];
}

export interface HtmxDependency {
    type: 'hx-get' | 'hx-post' | 'hx-put' | 'hx-delete' | 'hx-patch' | 'hx-trigger';
    url: string;
    target?: string; // hx-target value
    swap?: string;   // hx-swap value
    trigger?: string; // hx-trigger value
    filePath: string;
    line?: number;
    satisfied?: boolean; // Whether a matching fragment/endpoint exists
    context?: string; // Surrounding HTML context for display
    isHtmlFragment?: boolean; // Whether this likely returns HTML
    suggestedFragments?: string[]; // Suggested fragment files
}

export interface HtmxInfo {
    detected: boolean;
    version?: string;
    dependencies: HtmxDependency[];
}

export interface TemplateAnalysisResult {
    entryFile: string;
    templates: { [key: string]: TemplateDefinition };
    variables: TemplateVariable[];
    dependencies: TemplateDependency[];
    htmx?: HtmxInfo;
}

export interface TemplateData {
    [key: string]: any;
}

export interface GoHelperError extends Error {
    stderr?: string;
    stdout?: string;
}
