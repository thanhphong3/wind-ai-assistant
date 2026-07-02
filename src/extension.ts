import * as vscode from 'vscode';
import { WindWebviewProvider } from './webviewProvider';
import { ToolsManager } from './tools';
import { DiffManager } from './diffProvider';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    console.log('Wind extension is now active!');

    // Reset MCP configs on first installation/run
    const firstInstallKey = 'wind-agent.firstInstall';
    const isFirstInstall = !context.globalState.get<boolean>(firstInstallKey);
    if (isFirstInstall) {
        (async () => {
            try {
                const globalPath = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp_config.json');
                await fs.mkdir(path.dirname(globalPath), { recursive: true });
                await fs.writeFile(globalPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
                console.log('[Extension] Initialized empty global mcp_config.json on first install.');
            } catch (e) {
                console.error('[Extension] Failed to initialize empty global mcp_config.json:', e);
            }
        })();
        context.globalState.update(firstInstallKey, true);
    }

    const provider = new WindWebviewProvider(context);
    context.subscriptions.push(provider);

    // Register DiffManager
    const diffManager = new DiffManager(provider);
    diffManager.register(context);
    provider.setDiffManager(diffManager);

    // Create Autocomplete Output Channel for error logging and tracking
    const autocompleteOutputChannel = vscode.window.createOutputChannel('Wind Autocomplete');
    context.subscriptions.push(autocompleteOutputChannel);

    // Create Autocomplete Status Bar Item
    const autocompleteStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    autocompleteStatusBarItem.text = "$(symbol-event) Wind: Ready";
    autocompleteStatusBarItem.tooltip = "Click to show Wind Autocomplete Logs";
    autocompleteStatusBarItem.command = "wind-agent.showAutocompleteLogs";
    autocompleteStatusBarItem.show();
    context.subscriptions.push(autocompleteStatusBarItem);

    // Reset status bar when user types or moves cursor
    const resetStatusBar = () => {
        if (autocompleteStatusBarItem.text === "$(symbol-event) Wind: Suggestion Ready" || autocompleteStatusBarItem.text === "$(error) Wind: Error") {
            autocompleteStatusBarItem.text = "$(symbol-event) Wind: Ready";
            autocompleteStatusBarItem.tooltip = "Click to show Wind Autocomplete Logs";
        }
    };
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(resetStatusBar),
        vscode.workspace.onDidChangeTextDocument(resetStatusBar)
    );

    // Register command to display output channel logs
    context.subscriptions.push(
        vscode.commands.registerCommand('wind-agent.showAutocompleteLogs', () => {
            autocompleteOutputChannel.show();
        })
    );

    let autocompleteTimeout: NodeJS.Timeout | undefined;
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            WindWebviewProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        ),
        vscode.commands.registerCommand('wind-agent.clearChat', () => {
            provider.clearChat();
        }),
        vscode.commands.registerCommand('wind-agent.showHistory', () => {
            provider.toggleHistory();
        }),
        vscode.commands.registerCommand('wind-agent.showSettings', () => {
            provider.toggleSettings();
        }),
        vscode.commands.registerCommand('wind-agent.pinSelectionToChat', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (!selectedText) {
                return;
            }
            const filePath = vscode.workspace.asRelativePath(editor.document.uri);
            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;
            const languageId = editor.document.languageId;
            provider.pinSelectionToChat(selectedText, filePath, startLine, endLine, languageId);
        }),
        vscode.commands.registerCommand('wind-agent.inlineEdit', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No file is currently open.');
                return;
            }
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (!selectedText) {
                vscode.window.showInformationMessage('Please select the code you want to edit.');
                return;
            }

            const instruction = await vscode.window.showInputBox({
                prompt: 'Enter instruction to edit the selected code',
                placeHolder: 'Example: Add try-catch, optimize this function...'
            });
            if (!instruction) {
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Wind: Processing inline code edit...",
                cancellable: true
            }, async (_progress, token) => {
                try {
                    const modifiedCode = await provider.inlineEdit(selectedText, editor.document.languageId, instruction, token);
                    if (modifiedCode) {
                        await editor.edit(editBuilder => {
                            editBuilder.replace(selection, modifiedCode);
                        });
                        vscode.window.showInformationMessage('Inline code updated successfully.');
                    }
                } catch (err: any) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    vscode.window.showErrorMessage(`Inline code edit failed: ${err.message}`);
                }
            });
        }),
        vscode.commands.registerCommand('wind-agent.openConfig', async () => {
            await provider.openConfigFile();
        }),
        vscode.commands.registerCommand('wind-agent.openInBrowser', async (uri?: vscode.Uri) => {
            let targetUri = uri;
            if (!targetUri) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    targetUri = editor.document.uri;
                }
            }
            if (!targetUri) {
                vscode.window.showErrorMessage('No file found to open.');
                return;
            }
            try {
                await vscode.env.openExternal(targetUri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Cannot open file: ${err.message}`);
            }
        }),
        vscode.languages.registerInlineCompletionItemProvider(
                { pattern: '**' },
                {
                    async provideInlineCompletionItems(document, position, _context, token) {
                        const config = vscode.workspace.getConfiguration('windAgent');
                        const enableInlineCompletion = config.get<boolean>('enableInlineCompletion') !== false;
                        
                        const timeStr = new Date().toLocaleTimeString();
                        const relativePath = vscode.workspace.asRelativePath(document.uri);
                        
                        if (!enableInlineCompletion) {
                            autocompleteOutputChannel.appendLine(`[${timeStr}] [INFO] Autocomplete ignored for ${relativePath} (disabled in settings).`);
                            return [];
                        }

                        // 600ms debounce
                        if (autocompleteTimeout) {
                            clearTimeout(autocompleteTimeout);
                        }
                        await new Promise(resolve => {
                            autocompleteTimeout = setTimeout(resolve, 600);
                        });
                    if (token.isCancellationRequested) {
                        return [];
                    }

                    // Set loading state on Status Bar
                    autocompleteStatusBarItem.text = "$(sync~spin) Wind: Generating...";
                    autocompleteStatusBarItem.tooltip = "Wind is thinking of code completions...";
                    
                    autocompleteOutputChannel.appendLine(`[${timeStr}] [INFO] Autocomplete triggered for ${relativePath} at line ${position.line + 1}, col ${position.character + 1}.`);

                    const text = document.getText();
                    const offset = document.offsetAt(position);
                    const prefix = text.substring(0, offset);
                    const suffix = text.substring(offset);

                    const truncatedPrefix = prefix.length > 2000 ? prefix.slice(-2000) : prefix;
                    const truncatedSuffix = suffix.length > 1000 ? suffix.slice(0, 1000) : suffix;

                    try {
                        const completionText = await provider.getInlineCompletion(
                            truncatedPrefix,
                            truncatedSuffix,
                            document.languageId,
                            token
                        );

                        if (completionText && completionText.trim()) {
                            autocompleteStatusBarItem.text = "$(symbol-event) Wind: Suggestion Ready";
                            autocompleteStatusBarItem.tooltip = `Last suggestion generated at ${new Date().toLocaleTimeString()}`;
                            
                            autocompleteOutputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [INFO] Autocomplete success.\n--- COMPLETED SUGGESTION ---\n${completionText}\n---`);
                            
                            // Calculate the longest common overlap between line prefix and completion suggestion
                            const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
                            let overlapLength = 0;
                            const maxOverlap = Math.min(linePrefix.length, completionText.length);
                            for (let i = maxOverlap; i > 0; i--) {
                                const suffix = linePrefix.slice(-i);
                                if (completionText.startsWith(suffix)) {
                                    overlapLength = i;
                                    break;
                                }
                            }

                            const completionItem = new vscode.InlineCompletionItem(completionText);
                            const startPosition = position.translate(0, -overlapLength);
                            completionItem.range = new vscode.Range(startPosition, position);
                            return [completionItem];
                        } else {
                            autocompleteStatusBarItem.text = "$(symbol-event) Wind: Ready";
                            autocompleteStatusBarItem.tooltip = "Click to show Wind Autocomplete Logs";
                            if (token.isCancellationRequested) {
                                autocompleteOutputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [INFO] Autocomplete canceled.`);
                            } else {
                                autocompleteOutputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [INFO] Autocomplete returned empty suggestion.`);
                            }
                        }
                    } catch (e: any) {
                        if (token.isCancellationRequested) {
                            autocompleteStatusBarItem.text = "$(symbol-event) Wind: Ready";
                            autocompleteStatusBarItem.tooltip = "Click to show Wind Autocomplete Logs";
                            autocompleteOutputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [INFO] Autocomplete canceled during request.`);
                        } else {
                            autocompleteStatusBarItem.text = "$(error) Wind: Error";
                            autocompleteStatusBarItem.tooltip = `Autocomplete failed: ${e.message}. Click to see logs.`;
                            autocompleteOutputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [ERROR] Autocomplete failed:\nError: ${e.message}\nStack: ${e.stack}`);
                        }
                    }
                    return [];
                }
            }
        ),
        vscode.commands.registerCommand('wind-agent.fixDiagnostic', async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic, range: vscode.Range) => {
            await provider.fixDiagnostic(document, diagnostic, range);
        }),
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**' },
            {
                provideCodeActions(document, _range, context, _token) {
                    const diagnostics = context.diagnostics;
                    if (!diagnostics || diagnostics.length === 0) {
                        return [];
                    }

                    const actions: vscode.CodeAction[] = [];
                    for (const diagnostic of diagnostics) {
                        const action = new vscode.CodeAction(
                            `Fix with Wind: ${diagnostic.message}`,
                            vscode.CodeActionKind.QuickFix
                        );
                        action.command = {
                            command: 'wind-agent.fixDiagnostic',
                            title: 'Fix with Wind',
                            arguments: [document, diagnostic, diagnostic.range]
                        };
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        actions.push(action);
                    }
                    return actions;
                }
            },
            {
                providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
            }
        )
    );
}

export function deactivate() {
    return ToolsManager.dispose();
}
