// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GoTemplatePreviewProvider } from './previewProvider';
import { RenderContextProvider, TemplateVariablesProvider, TemplateDependenciesProvider, VariableItem } from './templateViewProviders';

// Auto-dismissing notification helper (5 second timeout)
function showTimedNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    const timeout = 5000;
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: false },
        async (progress) => {
            const icon = type === 'error' ? '$(error)' : type === 'warning' ? '$(warning)' : '$(info)';
            progress.report({ message: `${icon} ${message}` });
            await new Promise(resolve => setTimeout(resolve, timeout));
        }
    );
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const activationTime = Date.now();
	console.log('='.repeat(60));
	console.log('Go Template Viewer extension is activating...');
	console.log(`Extension path: ${context.extensionPath}`);
	console.log(`VS Code version: ${vscode.version}`);
	
	// Check if Go helper binary exists
	const helperBinaryName = process.platform === 'win32' ? 'template-helper.exe' : 'template-helper';
	const helperPath = path.join(context.extensionPath, 'bin', helperBinaryName);
	const helperExists = fs.existsSync(helperPath);
	
	console.log(`Go helper binary: ${helperExists ? 'FOUND' : 'MISSING'}`);
	console.log(`Expected at: ${helperPath}`);
	
	if (!helperExists) {
		const goHelperSrc = path.join(context.extensionPath, 'go-helper');
		const isWindows = process.platform === 'win32';
		const buildCmd = isWindows 
			? 'go build -o ..\\bin\\template-helper.exe'
			: 'go build -o ../bin/template-helper';
		const buildCmdFromRoot = isWindows
			? 'cd go-helper && go build -o ..\\bin\\template-helper.exe'
			: 'cd go-helper && go build -o ../bin/template-helper';
		
		const buildInstructions = `
The Go template helper binary is not found. This is required for template analysis and rendering.

To build it:
1. Open terminal in: ${goHelperSrc}
2. Run: ${buildCmd}

Or run from workspace root:
${buildCmdFromRoot}
		`.trim();
		
		console.warn('Go helper binary not found!');
		console.warn(buildInstructions);
		
		vscode.window.showWarningMessage(
			'Go Template Viewer: Helper binary not found. Click "Show Instructions" to build it.',
			'Show Instructions',
			'Dismiss'
		).then(selection => {
			if (selection === 'Show Instructions') {
				vscode.window.showInformationMessage(buildInstructions, { modal: true });
			}
		});
	}

	// Create providers
	console.log('Creating providers...');
	const previewProvider = new GoTemplatePreviewProvider(context);
	const renderContextProvider = new RenderContextProvider();
	const variablesProvider = new TemplateVariablesProvider();
	const dependenciesProvider = new TemplateDependenciesProvider();

	// Register tree views in the activity bar
	const renderContextView = vscode.window.createTreeView('goTemplateRenderContext', {
		treeDataProvider: renderContextProvider,
		showCollapseAll: false
	});

	const variablesView = vscode.window.createTreeView('goTemplateVariables', {
		treeDataProvider: variablesProvider,
		showCollapseAll: false
	});

	const dependenciesView = vscode.window.createTreeView('goTemplateDependencies', {
		treeDataProvider: dependenciesProvider,
		showCollapseAll: false
	});

	// Auto-open preview when template variables view becomes visible
	variablesView.onDidChangeVisibility(async (e) => {
		if (e.visible) {
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				const fileName = activeEditor.document.uri.fsPath;
				const isTemplateFile = /\.(html|tmpl|tpl|gohtml)$/.test(fileName);
				
				if (isTemplateFile) {
					// Check if preview is already open by checking context
					const isPreviewActive = vscode.workspace.getConfiguration().get('goTemplatePreviewActive');
					if (!isPreviewActive) {
						await vscode.commands.executeCommand('go-template-viewer.openPreview', activeEditor.document.uri);
					}
				}
			}
		}
	});

	// Connect preview to all providers
	previewProvider.onDataChange((variables, dataFilePath, dependencies, htmxInfo) => {
		console.log('Extension onDataChange callback called:', {
			variableCount: variables.length,
			dataFilePath,
			dependencyCount: dependencies?.length,
			htmxDetected: htmxInfo?.detected
		});
		
		// Get context info
		const includedFiles = previewProvider.getIncludedFiles();
		const entryFile = includedFiles[0]; // First file is always entry
		const templates = previewProvider.getTemplates().map(t => ({
			name: t.name,
			filePath: t.filePath,
			isBlock: t.isBlock || false,
			calls: t.calls || []
		}));

		console.log('Updating providers with:', {
			entryFile,
			includedFiles,
			templateCount: templates.length
		});

		// Update render context view
		renderContextProvider.refresh(entryFile, includedFiles, dataFilePath);

		// Get the actual template data from preview provider and update variables view
		const templateData = previewProvider.getTemplateData();
		variablesProvider.setData(templateData, dataFilePath);
		
		// Update dependencies view with HTMX info integrated
		if (dependencies) {
			dependenciesProvider.refresh(dependencies, templates, includedFiles, htmxInfo);
		}
	});

	// Connect variables provider changes back to preview
	variablesProvider.onVariableChange((name, value) => {
		// When name is empty, the entire data object was updated
		if (name === '') {
			previewProvider.setTemplateData(value);
		} else {
			previewProvider.updateVariable(name, value);
		}
	});

	// Register commands
	const openPreviewCommand = vscode.commands.registerCommand('go-template-viewer.openPreview', async (uri?: vscode.Uri) => {
		let fileUri = uri;
		
		if (!fileUri) {
			// If no URI provided, use active editor
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				fileUri = activeEditor.document.uri;
			} else {
				showTimedNotification('No file selected or open', 'error');
				return;
			}
		}

		// Check if file is a template file
		const fileName = fileUri.fsPath;
		const isTemplateFile = /\.(html|tmpl|tpl|gohtml)$/.test(fileName);
		
		if (!isTemplateFile) {
			showTimedNotification('Selected file does not appear to be a template file', 'warning');
		}

		try {
			// Don't reset context if preview already exists - just show it
			await previewProvider.openPreview(fileUri, false);
		} catch (error) {
			showTimedNotification(`Error opening preview: ${error}`, 'error');
		}
	});

	const refreshPreviewCommand = vscode.commands.registerCommand('go-template-viewer.refreshPreview', () => {
		previewProvider.refresh();
	});

	const exportHtmlCommand = vscode.commands.registerCommand('goTemplateViewer.exportHtml', async () => {
		await previewProvider.exportHtml();
	});

	const editDataValueCommand = vscode.commands.registerCommand('goTemplateViewer.editDataValue', async (item: VariableItem) => {
		await variablesProvider.editValue(item);
	});

	const duplicateArrayItemCommand = vscode.commands.registerCommand('goTemplateViewer.duplicateArrayItem', async (item: VariableItem) => {
		await variablesProvider.duplicateArrayItem(item);
	});

	const addArrayItemCommand = vscode.commands.registerCommand('goTemplateViewer.addArrayItem', async (item: VariableItem) => {
		await variablesProvider.addArrayItem(item);
	});

	const deleteDataItemCommand = vscode.commands.registerCommand('goTemplateViewer.deleteDataItem', async (item: VariableItem) => {
		const confirm = await vscode.window.showWarningMessage(
			`Delete ${item.label}?`,
			{ modal: true },
			'Delete'
		);
		if (confirm === 'Delete') {
			await variablesProvider.deleteItem(item);
		}
	});

	const openDataFileCommand = vscode.commands.registerCommand('goTemplateViewer.openDataFile', async () => {
		const dataFilePath = variablesProvider.getDataFilePath();
		if (dataFilePath) {
			const doc = await vscode.workspace.openTextDocument(dataFilePath);
			await vscode.window.showTextDocument(doc);
		} else {
			showTimedNotification('No data file is currently linked');
		}
	});

	const editVariableCommand = vscode.commands.registerCommand('goTemplateViewer.editVariable', async (item: VariableItem) => {
		await variablesProvider.editValue(item);
	});
	
	const changeEntryFileCommand = vscode.commands.registerCommand('goTemplateViewer.changeEntryFile', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			showTimedNotification('No workspace folder open', 'error');
			return;
		}
		
		const files = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: {
				'Template Files': ['html', 'tmpl', 'tpl', 'gohtml'],
				'All Files': ['*']
			},
			defaultUri: workspaceFolder.uri,
			openLabel: 'Select File'
		});
		
		if (!files || files.length === 0) {
			return;
		}
		
		// Reset context when explicitly changing entry file
		await previewProvider.openPreview(files[0], true);
	});
	
	const manageDataFileCommand = vscode.commands.registerCommand('goTemplateViewer.manageDataFile', async () => {
		const options = [
			{ label: '📂 Select Existing Data File', action: 'select' },
			{ label: '💾 Save Current Data to New File', action: 'save' },
			{ label: '🔗 Link to Template', action: 'link' }
		];
		
		const selected = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose an action'
		});
		
		if (!selected) {
			return;
		}
		
		if (selected.action === 'select' || selected.action === 'link') {
			await vscode.commands.executeCommand('go-template-viewer.linkDataFile');
		} else if (selected.action === 'save') {
			// Save current data to a new file
			const currentData = previewProvider.getTemplateData();
			if (!currentData || Object.keys(currentData).length === 0) {
				showTimedNotification('No template data to save', 'warning');
				return;
			}
			
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				showTimedNotification('No workspace folder open', 'error');
				return;
			}
			
			const defaultUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data'));
			
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: defaultUri,
				filters: { 'JSON Files': ['json'] },
				saveLabel: 'Save Template Data'
			});
			
			if (saveUri) {
				try {
					const content = JSON.stringify(currentData, null, 2);
					await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
					showTimedNotification(`Saved template data to ${path.basename(saveUri.fsPath)}`);
				} catch (error) {
					showTimedNotification(`Error saving data file: ${error}`, 'error');
				}
			}
		}
	});
	
	const addTemplateFileCommand = vscode.commands.registerCommand('goTemplateViewer.addTemplateFile', async (dependencyName?: string) => {
		// Show file picker for template files
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			showTimedNotification('No workspace folder open', 'error');
			return;
		}
		
		const files = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: {
				'Template Files': ['html', 'tmpl', 'tpl', 'gohtml'],
				'All Files': ['*']
			},
			defaultUri: workspaceFolder.uri,
			openLabel: 'Select File'
		});
		
		if (!files || files.length === 0) {
			return;
		}
		
		const filePath = files[0].fsPath;
		await previewProvider.addTemplateFile(filePath);
		
		showTimedNotification(`Added ${require('path').basename(filePath)} to render context`);
	});
	
	const removeTemplateFileCommand = vscode.commands.registerCommand('goTemplateViewer.removeTemplateFile', async (filePath: string) => {
		await previewProvider.removeTemplateFile(filePath);
		showTimedNotification(`Removed ${require('path').basename(filePath)} from render context`);
	});

	const linkDataFileCommand = vscode.commands.registerCommand('go-template-viewer.linkDataFile', async (uri?: vscode.Uri) => {
		let fileUri = uri;
		
		if (!fileUri) {
			// Try to get from preview provider first
			const currentFile = previewProvider.getCurrentFile();
			if (currentFile) {
				fileUri = vscode.Uri.file(currentFile);
			} else {
				// Fall back to active editor
				const activeEditor = vscode.window.activeTextEditor;
				if (activeEditor) {
					fileUri = activeEditor.document.uri;
				} else {
					vscode.window.showErrorMessage('No template file loaded. Please open a template preview first.');
					return;
				}
			}
		}

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('File must be in a workspace');
			return;
		}

		// First, check for existing data files and offer quick-pick
		const dataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', 'template-data');
		let existingFiles: string[] = [];
		
		if (fs.existsSync(dataDir)) {
			try {
				const files = fs.readdirSync(dataDir);
				existingFiles = files.filter(f => f.endsWith('.json')).map(f => path.join(dataDir, f));
			} catch (error) {
				console.error('Error reading data directory:', error);
			}
		}

		let dataFile: vscode.Uri | undefined;

		// If there are existing files, offer quick-pick first
		if (existingFiles.length > 0) {
			const items = [
				...existingFiles.map(f => ({
					label: path.basename(f),
					description: vscode.workspace.asRelativePath(f, false),
					filePath: f
				})),
				{
					label: '$(folder-opened) Browse for file...',
					description: 'Select a different JSON file',
					filePath: undefined
				}
			];

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select an existing data file or browse for one'
			});

			if (!selected) {
				return;
			}

			if (selected.filePath) {
				dataFile = vscode.Uri.file(selected.filePath);
			}
		}

		// If no selection made or user chose to browse
		if (!dataFile) {
			const dataFiles = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: {
					'JSON Files': ['json']
				},
				defaultUri: vscode.Uri.file(dataDir),
				openLabel: 'Select Data File'
			});

			if (!dataFiles || dataFiles.length === 0) {
				return;
			}

			dataFile = dataFiles[0];
		}
		
		// Save the link in workspace config
		await previewProvider.setDataFileLink(fileUri.fsPath, dataFile.fsPath);

		// Make path relative to workspace for display
		const relativePath = vscode.workspace.asRelativePath(dataFile, false);

		vscode.window.showInformationMessage(`Linked data file: ${relativePath}`);
		
		// Refresh preview if open
		previewProvider.refresh();
	});

	const removeDataFileCommand = vscode.commands.registerCommand('goTemplateViewer.removeDataFile', async () => {
		// Remove the data file link from the current template
		const currentFile = previewProvider.getCurrentFile();
		if (!currentFile) {
			vscode.window.showErrorMessage('No template file loaded');
			return;
		}

		const currentDataFile = variablesProvider.getDataFilePath();
		if (!currentDataFile) {
			vscode.window.showInformationMessage('No data file is currently linked');
			return;
		}

		// Clear the data file link in preview provider
		await previewProvider.unlinkDataFile();
		
		// Refresh all views
		renderContextProvider.refresh();
		variablesProvider.refresh([], undefined); // Clear variables view
		
		vscode.window.showInformationMessage('Data file link removed');
		
		// Refresh preview to rebuild variables from templates
		previewProvider.refresh();
	});

	// Watch for document saves to refresh preview
	const documentSaveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
		const fileName = document.uri.fsPath;
		const isTemplateFile = /\.(html|tmpl|tpl|gohtml)$/.test(fileName);
		const isJsonDataFile = fileName.endsWith('.json') && fileName.includes('.vscode/template-data');
		
		if (isTemplateFile) {
			console.log('Template file saved, refreshing preview:', fileName);
			previewProvider.refresh();
		} else if (isJsonDataFile) {
			// Data file was saved - reload and refresh if it's the current data file
			const currentDataFile = variablesProvider.getDataFilePath();
			if (currentDataFile === fileName) {
				console.log('Data file saved, refreshing preview:', fileName);
				previewProvider.refresh();
			}
		}
	});

	// Register disposables
	context.subscriptions.push(
		openPreviewCommand,
		refreshPreviewCommand,
		exportHtmlCommand,
		editVariableCommand,
		editDataValueCommand,
		duplicateArrayItemCommand,
		addArrayItemCommand,
		deleteDataItemCommand,
		openDataFileCommand,
		changeEntryFileCommand,
		manageDataFileCommand,
		addTemplateFileCommand,
		removeTemplateFileCommand,
		linkDataFileCommand,
		removeDataFileCommand,
		documentSaveWatcher,
		renderContextView,
		variablesView,
		dependenciesView,
		previewProvider
	);

	const activationDuration = Date.now() - activationTime;
	console.log(`Extension activation completed in ${activationDuration}ms`);
	console.log(`Registered ${context.subscriptions.length} disposables`);
	console.log('Commands registered:');
	console.log('  - go-template-viewer.openPreview');
	console.log('  - go-template-viewer.refreshPreview');
	console.log('  - goTemplateViewer.editVariable');
	console.log('  - goTemplateViewer.changeEntryFile');
	console.log('  - goTemplateViewer.manageDataFile');
	console.log('  - goTemplateViewer.addTemplateFile');
	console.log('  - goTemplateViewer.removeTemplateFile');
	console.log('  - go-template-viewer.linkDataFile');
	console.log('Views registered:');
	console.log('  - goTemplateRenderContext');
	console.log('  - goTemplateVariables');
	console.log('  - goTemplateDependencies');
	console.log('='.repeat(60));
	
	// Show welcome message only if helper exists
	if (helperExists) {
		vscode.window.showInformationMessage('Go Template Viewer is ready! Right-click on a template file to open preview.');
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log('Go Template Viewer extension is deactivating...');
}
