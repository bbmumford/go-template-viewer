export interface GoTemplateVariable {
    name: string;
    type: 'variable' | 'field' | 'function';
    context?: string;
    line?: number;
    column?: number;
}

export interface GoTemplateDependency {
    name: string;
    type: 'template' | 'block' | 'partial';
    path?: string;
    line?: number;
}

export interface ParsedTemplate {
    variables: GoTemplateVariable[];
    dependencies: GoTemplateDependency[];
    blocks: string[];
    functions: string[];
}

export class GoTemplateParser {
    private static readonly TEMPLATE_ACTIONS = /\{\{[^}]*\}\}/g;
    private static readonly VARIABLE_PATTERN = /\$[a-zA-Z_][a-zA-Z0-9_]*/g;
    private static readonly FIELD_PATTERN = /\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    private static readonly TEMPLATE_PATTERN = /\{\{\s*template\s+["']([^"']+)["']/g;
    private static readonly BLOCK_PATTERN = /\{\{\s*block\s+["']([^"']+)["']/g;
    private static readonly DEFINE_PATTERN = /\{\{\s*define\s+["']([^"']+)["']/g;
    private static readonly FUNCTION_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+/g;

    public static parse(content: string): ParsedTemplate {
        const variables: GoTemplateVariable[] = [];
        const dependencies: GoTemplateDependency[] = [];
        const blocks: string[] = [];
        const functions: string[] = [];

        const lines = content.split('\n');
        
        lines.forEach((line, lineNumber) => {
            // Find template actions
            const actions = line.match(this.TEMPLATE_ACTIONS);
            if (!actions) {
                return;
            }

            actions.forEach(action => {
                const column = line.indexOf(action);
                
                // Parse variables
                const variableMatches = action.match(this.VARIABLE_PATTERN);
                if (variableMatches) {
                    variableMatches.forEach(match => {
                        const varName = match.substring(1); // Remove $
                        if (!variables.some(v => v.name === varName)) {
                            variables.push({
                                name: varName,
                                type: 'variable',
                                line: lineNumber + 1,
                                column
                            });
                        }
                    });
                }

                // Parse field access (.Field)
                const fieldMatches = action.match(this.FIELD_PATTERN);
                if (fieldMatches) {
                    fieldMatches.forEach(match => {
                        const fieldName = match.substring(1); // Remove .
                        if (!variables.some(v => v.name === fieldName)) {
                            variables.push({
                                name: fieldName,
                                type: 'field',
                                line: lineNumber + 1,
                                column
                            });
                        }
                    });
                }

                // Parse template dependencies
                const templateMatch = action.match(this.TEMPLATE_PATTERN);
                if (templateMatch) {
                    templateMatch.forEach(match => {
                        const templateName = match.match(/["']([^"']+)["']/)?.[1];
                        if (templateName && !dependencies.some(d => d.name === templateName)) {
                            dependencies.push({
                                name: templateName,
                                type: 'template',
                                line: lineNumber + 1
                            });
                        }
                    });
                }

                // Parse block definitions
                const blockMatch = action.match(this.BLOCK_PATTERN);
                if (blockMatch) {
                    blockMatch.forEach(match => {
                        const blockName = match.match(/["']([^"']+)["']/)?.[1];
                        if (blockName && !blocks.includes(blockName)) {
                            blocks.push(blockName);
                            dependencies.push({
                                name: blockName,
                                type: 'block',
                                line: lineNumber + 1
                            });
                        }
                    });
                }

                // Parse define statements
                const defineMatch = action.match(this.DEFINE_PATTERN);
                if (defineMatch) {
                    defineMatch.forEach(match => {
                        const defineName = match.match(/["']([^"']+)["']/)?.[1];
                        if (defineName && !blocks.includes(defineName)) {
                            blocks.push(defineName);
                        }
                    });
                }

                // Parse function calls
                const functionMatches = action.match(this.FUNCTION_PATTERN);
                if (functionMatches) {
                    functionMatches.forEach(match => {
                        const funcName = match.trim().split(/\s+/)[0].replace('{{', '').trim();
                        if (funcName && !this.isBuiltinFunction(funcName) && !functions.includes(funcName)) {
                            functions.push(funcName);
                            variables.push({
                                name: funcName,
                                type: 'function',
                                line: lineNumber + 1,
                                column
                            });
                        }
                    });
                }
            });
        });

        return {
            variables: this.deduplicateVariables(variables),
            dependencies,
            blocks,
            functions
        };
    }

    private static isBuiltinFunction(name: string): boolean {
        const builtins = [
            'and', 'call', 'html', 'index', 'slice', 'js', 'len', 'not', 'or', 'print', 'printf', 'println',
            'urlquery', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'range', 'if', 'else', 'end', 'with', 'template',
            'define', 'block', 'include'
        ];
        return builtins.includes(name);
    }

    private static deduplicateVariables(variables: GoTemplateVariable[]): GoTemplateVariable[] {
        const seen = new Set<string>();
        return variables.filter(variable => {
            const key = `${variable.name}-${variable.type}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }
}