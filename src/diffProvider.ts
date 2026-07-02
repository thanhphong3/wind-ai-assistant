import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WindWebviewProvider } from './webviewProvider';

export interface DiffChange {
    type: 'added' | 'removed' | 'common';
    value: string;
    originalLine?: number;
    currentLine?: number;
}

export interface InlineDiffLine {
    text: string;
    type: 'added' | 'removed' | 'common';
}

export interface InlineDiffHunk {
    id: string;
    startLine: number; // 0-indexed line in the MERGED document
    endLine: number;   // 0-indexed end line (exclusive) in the MERGED document
    removedCount: number;
    addedCount: number;
    removedLines: string[];
    addedLines: string[];
    // Track original location inside the backup file
    originalStartLine: number;
    originalEndLine: number;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// LCS-based line diff algorithm
export function diffLines(oldLines: string[], newLines: string[]): DiffChange[] {
    const N = oldLines.length;
    const M = newLines.length;

    if (N === 0) {
        return newLines.map((line, idx) => ({ type: 'added', value: line, currentLine: idx }));
    }
    if (M === 0) {
        return oldLines.map((line, idx) => ({ type: 'removed', value: line, originalLine: idx }));
    }

    if (N * M > 1000000) {
        return [
            ...oldLines.map((line, idx) => ({ type: 'removed' as const, value: line, originalLine: idx })),
            ...newLines.map((line, idx) => ({ type: 'added' as const, value: line, currentLine: idx }))
        ];
    }

    const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));

    for (let i = 1; i <= N; i++) {
        for (let j = 1; j <= M; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const result: DiffChange[] = [];
    let i = N, j = M;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.unshift({
                type: 'common',
                value: oldLines[i - 1],
                originalLine: i - 1,
                currentLine: j - 1
            });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({
                type: 'added',
                value: newLines[j - 1],
                currentLine: j - 1
            });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            result.unshift({
                type: 'removed',
                value: oldLines[i - 1],
                originalLine: i - 1
            });
            i--;
        }
    }
    return result;
}

export function mergeDiffLines(changes: DiffChange[]): InlineDiffLine[] {
    const merged: InlineDiffLine[] = [];
    let pendingRemoved: string[] = [];
    let pendingAdded: string[] = [];

    for (const change of changes) {
        if (change.type === 'common') {
            for (const r of pendingRemoved) {
                merged.push({ text: r, type: 'removed' });
            }
            for (const a of pendingAdded) {
                merged.push({ text: a, type: 'added' });
            }
            pendingRemoved = [];
            pendingAdded = [];
            merged.push({ text: change.value, type: 'common' });
        } else if (change.type === 'removed') {
            pendingRemoved.push(change.value);
        } else if (change.type === 'added') {
            pendingAdded.push(change.value);
        }
    }

    for (const r of pendingRemoved) {
        merged.push({ text: r, type: 'removed' });
    }
    for (const a of pendingAdded) {
        merged.push({ text: a, type: 'added' });
    }

    return merged;
}

export function getInlineDiffHunks(mergedLines: InlineDiffLine[], _changes: DiffChange[]): InlineDiffHunk[] {
    const hunks: InlineDiffHunk[] = [];
    let currentHunkStart = -1;
    let removedLines: string[] = [];
    let addedLines: string[] = [];

    // A simpler way to get original line ranges is tracking origLine index during merge:
    let origLineIdx = 0;
    
    // Group contiguous non-common lines from mergedLines
    for (let i = 0; i < mergedLines.length; i++) {
        const line = mergedLines[i];
        if (line.type !== 'common') {
            if (currentHunkStart === -1) {
                currentHunkStart = i;
            }
            if (line.type === 'removed') {
                removedLines.push(line.text);
            } else {
                addedLines.push(line.text);
            }
        } else {
            if (currentHunkStart !== -1) {
                // Calculate original range in backup
                // The removed lines were taken directly from the backup starting at our tracked origLineIdx
                const originalStartLine = origLineIdx;
                const originalEndLine = origLineIdx + removedLines.length;
                
                hunks.push({
                    id: `hunk_${hunks.length}_${Date.now()}`,
                    startLine: currentHunkStart,
                    endLine: i,
                    removedCount: removedLines.length,
                    addedCount: addedLines.length,
                    removedLines,
                    addedLines,
                    originalStartLine,
                    originalEndLine
                });
                
                origLineIdx += removedLines.length;
                currentHunkStart = -1;
                removedLines = [];
                addedLines = [];
            }
            // For common line, we increment the original index
            origLineIdx++;
        }
    }

    if (currentHunkStart !== -1) {
        const originalStartLine = origLineIdx;
        const originalEndLine = origLineIdx + removedLines.length;
        hunks.push({
            id: `hunk_${hunks.length}_${Date.now()}`,
            startLine: currentHunkStart,
            endLine: mergedLines.length,
            removedCount: removedLines.length,
            addedCount: addedLines.length,
            removedLines,
            addedLines,
            originalStartLine,
            originalEndLine
        });
    }

    return hunks;
}

export class DiffManager implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private _fileHunksCache = new Map<string, InlineDiffHunk[]>();
    private _initializedDiffFiles = new Set<string>();
    private _isApplyingInternalEdit = false;

    private _addedLineDecorationType: vscode.TextEditorDecorationType;
    private _deletedLineDecorationType: vscode.TextEditorDecorationType;

    constructor(private provider: WindWebviewProvider) {
        this._addedLineDecorationType = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(74, 222, 128, 0.15)',
            overviewRulerColor: 'rgba(74, 222, 128, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            before: {
                contentText: '+',
                color: 'rgba(74, 222, 128, 0.8)',
                margin: '0 0.8em 0 0.4em',
                fontWeight: 'bold'
            }
        });

        this._deletedLineDecorationType = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            overviewRulerColor: 'rgba(239, 68, 68, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            before: {
                contentText: '-',
                color: 'rgba(239, 68, 68, 0.8)',
                margin: '0 0.8em 0 0.4em',
                fontWeight: 'bold'
            }
        });
    }

    public register(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ pattern: '**' }, this)
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('wind-agent.acceptDiffHunk', async (relativePath: string, hunkId: string) => {
                await this.acceptHunk(relativePath, hunkId);
            }),
            vscode.commands.registerCommand('wind-agent.discardDiffHunk', async (relativePath: string, hunkId: string) => {
                await this.discardHunk(relativePath, hunkId);
            }),
            vscode.commands.registerCommand('wind-agent.acceptInlineHunkAtCursor', async () => {
                await this.acceptHunkAtCursor();
            }),
            vscode.commands.registerCommand('wind-agent.discardInlineHunkAtCursor', async () => {
                await this.discardHunkAtCursor();
            }),
            vscode.commands.registerCommand('wind-agent.acceptAllDiff', async (relativePath: string) => {
                await this.acceptAllDiff(relativePath);
            }),
            vscode.commands.registerCommand('wind-agent.discardAllDiff', async (relativePath: string) => {
                await this.discardAllDiff(relativePath);
            })
        );

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) this.updateDecorationsForEditor(editor);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this._isApplyingInternalEdit) return;

                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document === event.document) {
                    let relativePath: string;
                    try {
                        relativePath = this.provider.getSafeRelativePath(editor.document.uri.fsPath);
                    } catch {
                        return;
                    }

                    if (this._initializedDiffFiles.has(relativePath)) {
                        const hunks = this._fileHunksCache.get(relativePath) || [];
                        this.updateHunkLinesOnEdit(hunks, event);
                        this.triggerUpdateDecorations(editor);
                    }
                }
            })
        );
    }

    private _debounceTimer: NodeJS.Timeout | undefined;
    private triggerUpdateDecorations(editor: vscode.TextEditor) {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this.updateDecorationsForEditor(editor);
        }, 300);
    }

    private updateHunkLinesOnEdit(hunks: InlineDiffHunk[], event: vscode.TextDocumentChangeEvent) {
        for (const change of event.contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const linesAdded = change.text.split('\n').length - 1;
            const linesRemoved = endLine - startLine;
            const delta = linesAdded - linesRemoved;

            if (delta === 0) continue;

            for (const hunk of hunks) {
                if (startLine < hunk.startLine) {
                    hunk.startLine += delta;
                    hunk.endLine += delta;
                } else if (startLine >= hunk.startLine && startLine < hunk.endLine) {
                    hunk.endLine += delta;
                    if (startLine >= hunk.startLine + hunk.removedCount) {
                        hunk.addedCount += delta;
                    } else {
                        hunk.removedCount += delta;
                    }
                }
            }
        }
    }

    public isFileModified(relativePath: string): boolean {
        return this.provider.sessionModifiedFiles.has(relativePath);
    }

    public async getBackupContent(relativePath: string): Promise<string | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return null;
        const backupDir = path.join(os.tmpdir(), 'wind-backups', this.provider.getWorkspaceHash());
        const backupPath = path.join(backupDir, relativePath);
        if (await fileExists(backupPath)) {
            try {
                return await fs.readFile(backupPath, 'utf8');
            } catch {
                return null;
            }
        }
        return null;
    }

    public refresh() {
        this._onDidChangeCodeLenses.fire();
        for (const editor of vscode.window.visibleTextEditors) {
            this.updateDecorationsForEditor(editor);
        }
    }

    public async initializeInlineDiff(relativePath: string, cleanContent?: string) {
        if (this._initializedDiffFiles.has(relativePath)) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const workspacePath = path.join(workspaceRoot, relativePath);
        const backupDir = path.join(os.tmpdir(), 'wind-backups', this.provider.getWorkspaceHash());
        const backupPath = path.join(backupDir, relativePath);

        if (!(await fileExists(backupPath)) || !(await fileExists(workspacePath))) return;

        try {
            const originalText = await fs.readFile(backupPath, 'utf8');
            const currentText = cleanContent !== undefined ? cleanContent : await fs.readFile(workspacePath, 'utf8');

            const oldLines = originalText.split(/\r?\n/);
            const newLines = currentText.split(/\r?\n/);

            const diffResult = diffLines(oldLines, newLines);
            const merged = mergeDiffLines(diffResult);
            const hunks = getInlineDiffHunks(merged, diffResult);

            if (hunks.length === 0) return;

            const doc = await vscode.workspace.openTextDocument(workspacePath);
            const editor = await vscode.window.showTextDocument(doc);

            const hasCRLF = originalText.includes('\r\n') || currentText.includes('\r\n');
            const mergedText = merged.map(l => l.text).join(hasCRLF ? '\r\n' : '\n');

            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            edit.replace(doc.uri, fullRange, mergedText);

            this._isApplyingInternalEdit = true;
            const success = await vscode.workspace.applyEdit(edit);
            await doc.save();
            this._isApplyingInternalEdit = false;

            if (success) {
                this._initializedDiffFiles.add(relativePath);
                this._fileHunksCache.set(relativePath, hunks);
                await vscode.commands.executeCommand('setContext', 'windAgent.isInDiffMode', true);
                this.updateDecorationsForEditor(editor);
                this._onDidChangeCodeLenses.fire();
            }
        } catch (e) {
            console.error('Failed to initialize inline diff:', e);
            this._isApplyingInternalEdit = false;
        }
    }

    public updateDecorationsForEditor(editor: vscode.TextEditor) {
        const document = editor.document;
        let relativePath: string;
        try {
            relativePath = this.provider.getSafeRelativePath(document.uri.fsPath);
        } catch {
            return;
        }

        if (!this._initializedDiffFiles.has(relativePath) || !this.isFileModified(relativePath)) {
            editor.setDecorations(this._addedLineDecorationType, []);
            editor.setDecorations(this._deletedLineDecorationType, []);
            return;
        }

        const hunks = this._fileHunksCache.get(relativePath) || [];
        const addedDecorations: vscode.DecorationOptions[] = [];
        const deletedDecorations: vscode.DecorationOptions[] = [];

        for (const hunk of hunks) {
            if (hunk.removedCount > 0) {
                const range = new vscode.Range(
                    hunk.startLine, 0,
                    hunk.startLine + hunk.removedCount - 1, 10000
                );
                deletedDecorations.push({ range });
            }

            if (hunk.addedCount > 0) {
                const range = new vscode.Range(
                    hunk.startLine + hunk.removedCount, 0,
                    hunk.endLine - 1, 10000
                );
                addedDecorations.push({ range });
            }
        }

        editor.setDecorations(this._addedLineDecorationType, addedDecorations);
        editor.setDecorations(this._deletedLineDecorationType, deletedDecorations);
    }

    provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        let relativePath: string;
        try {
            relativePath = this.provider.getSafeRelativePath(document.uri.fsPath);
        } catch {
            return [];
        }

        if (!this._initializedDiffFiles.has(relativePath) || !this.isFileModified(relativePath)) {
            return [];
        }

        const hunks = this._fileHunksCache.get(relativePath) || [];
        if (hunks.length === 0) {
            return [];
        }

        const topRange = new vscode.Range(0, 0, 0, 0);
        lenses.push(new vscode.CodeLens(topRange, {
            title: `✓ Accept All (${hunks.length} changes)`,
            command: 'wind-agent.acceptAllDiff',
            arguments: [relativePath]
        }));
        lenses.push(new vscode.CodeLens(topRange, {
            title: `✕ Revert All`,
            command: 'wind-agent.discardAllDiff',
            arguments: [relativePath]
        }));

        for (const hunk of hunks) {
            const range = new vscode.Range(hunk.startLine, 0, hunk.startLine, 0);
            lenses.push(new vscode.CodeLens(range, {
                title: `✓ Accept`,
                command: 'wind-agent.acceptDiffHunk',
                arguments: [relativePath, hunk.id]
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: `✕ Revert`,
                command: 'wind-agent.discardDiffHunk',
                arguments: [relativePath, hunk.id]
            }));
        }

        return lenses;
    }

    private getCleanDocumentText(document: vscode.TextDocument, hunks: InlineDiffHunk[]): string {
        const lines = document.getText().split(/\r?\n/);
        const redLineIndices = new Set<number>();

        for (const hunk of hunks) {
            for (let i = 0; i < hunk.removedCount; i++) {
                redLineIndices.add(hunk.startLine + i);
            }
        }

        const clean = lines.filter((_, idx) => !redLineIndices.has(idx));
        return clean.join('\n');
    }

    private async recalculateInlineDiff(relativePath: string, editor: vscode.TextEditor) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const workspacePath = path.join(workspaceRoot, relativePath);
        const backupDir = path.join(os.tmpdir(), 'wind-backups', this.provider.getWorkspaceHash());
        const backupPath = path.join(backupDir, relativePath);

        if (!(await fileExists(backupPath)) || !(await fileExists(workspacePath))) return;

        try {
            const document = editor.document;
            const hunks = this._fileHunksCache.get(relativePath) || [];

            const cleanText = this.getCleanDocumentText(document, hunks);
            const originalText = await fs.readFile(backupPath, 'utf8');

            const oldLines = originalText.split(/\r?\n/);
            const newLines = cleanText.split(/\r?\n/);

            const diffResult = diffLines(oldLines, newLines);
            const merged = mergeDiffLines(diffResult);
            const newHunks = getInlineDiffHunks(merged, diffResult);

            const hasCRLF = originalText.includes('\r\n') || cleanText.includes('\r\n');
            const mergedText = merged.map(l => l.text).join(hasCRLF ? '\r\n' : '\n');

            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            edit.replace(document.uri, fullRange, mergedText);

            this._isApplyingInternalEdit = true;
            await vscode.workspace.applyEdit(edit);
            await document.save();
            this._isApplyingInternalEdit = false;

            this._fileHunksCache.set(relativePath, newHunks);

            if (newHunks.length === 0) {
                this._initializedDiffFiles.delete(relativePath);
                this._fileHunksCache.delete(relativePath);
                await this.provider.acceptSingleFile(relativePath);

                if (this._initializedDiffFiles.size === 0) {
                    await vscode.commands.executeCommand('setContext', 'windAgent.isInDiffMode', false);
                }
            }

            this.updateDecorationsForEditor(editor);
            this._onDidChangeCodeLenses.fire();
        } catch (e) {
            console.error('Failed to recalculate inline diff:', e);
            this._isApplyingInternalEdit = false;
        }
    }

    public async acceptHunk(relativePath: string, hunkId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const backupDir = path.join(os.tmpdir(), 'wind-backups', this.provider.getWorkspaceHash());
        const backupPath = path.join(backupDir, relativePath);

        const hunks = this._fileHunksCache.get(relativePath) || [];
        const hunk = hunks.find(h => h.id === hunkId);
        if (!hunk) return;

        const doc = await vscode.workspace.openTextDocument(path.join(workspaceFolders[0].uri.fsPath, relativePath));
        const editor = await vscode.window.showTextDocument(doc);

        if (hunk.removedCount > 0) {
            const edit = new vscode.WorkspaceEdit();
            const startPos = new vscode.Position(hunk.startLine, 0);
            let endPos: vscode.Position;

            if (hunk.startLine + hunk.removedCount >= doc.lineCount) {
                if (hunk.startLine > 0) {
                    const prevLineText = doc.lineAt(hunk.startLine - 1).text;
                    const prevLineEnd = new vscode.Position(hunk.startLine - 1, prevLineText.length);
                    endPos = new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
                    edit.delete(doc.uri, new vscode.Range(prevLineEnd, endPos));
                } else {
                    endPos = new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
                    edit.delete(doc.uri, new vscode.Range(startPos, endPos));
                }
            } else {
                endPos = new vscode.Position(hunk.startLine + hunk.removedCount, 0);
                edit.delete(doc.uri, new vscode.Range(startPos, endPos));
            }

            this._isApplyingInternalEdit = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            this._isApplyingInternalEdit = false;
        }

        if (await fileExists(backupPath)) {
            try {
                const originalContent = await fs.readFile(backupPath, 'utf8');
                const hasCRLF = originalContent.includes('\r\n');
                const lines = originalContent.split(/\r?\n/);
                lines.splice(hunk.originalStartLine, hunk.originalEndLine - hunk.originalStartLine, ...hunk.addedLines);
                await fs.writeFile(backupPath, lines.join(hasCRLF ? '\r\n' : '\n'), 'utf8');
            } catch (e) {
                console.error('Failed to update backup file:', e);
            }
        }

        const remainingHunks = hunks.filter(h => h.id !== hunkId);
        this._fileHunksCache.set(relativePath, remainingHunks);

        await this.recalculateInlineDiff(relativePath, editor);
    }

    public async discardHunk(relativePath: string, hunkId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspacePath = path.join(workspaceFolders[0].uri.fsPath, relativePath);

        const hunks = this._fileHunksCache.get(relativePath) || [];
        const hunk = hunks.find(h => h.id === hunkId);
        if (!hunk) return;

        const doc = await vscode.workspace.openTextDocument(workspacePath);
        const editor = await vscode.window.showTextDocument(doc);

        if (hunk.addedCount > 0) {
            const edit = new vscode.WorkspaceEdit();
            const startLine = hunk.startLine + hunk.removedCount;
            const endLine = hunk.endLine;
            const startPos = new vscode.Position(startLine, 0);
            let endPos: vscode.Position;

            if (endLine >= doc.lineCount) {
                if (startLine > 0) {
                    const prevLineText = doc.lineAt(startLine - 1).text;
                    const prevLineEnd = new vscode.Position(startLine - 1, prevLineText.length);
                    endPos = new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
                    edit.delete(doc.uri, new vscode.Range(prevLineEnd, endPos));
                } else {
                    endPos = new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
                    edit.delete(doc.uri, new vscode.Range(startPos, endPos));
                }
            } else {
                endPos = new vscode.Position(endLine, 0);
                edit.delete(doc.uri, new vscode.Range(startPos, endPos));
            }

            this._isApplyingInternalEdit = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            this._isApplyingInternalEdit = false;
        }

        const remainingHunks = hunks.filter(h => h.id !== hunkId);
        this._fileHunksCache.set(relativePath, remainingHunks);

        await this.recalculateInlineDiff(relativePath, editor);
    }

    public async acceptHunkAtCursor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        let relativePath: string;
        try {
            relativePath = this.provider.getSafeRelativePath(editor.document.uri.fsPath);
        } catch {
            return;
        }

        const hunks = this._fileHunksCache.get(relativePath) || [];
        const cursorLine = editor.selection.active.line;

        const hunk = hunks.find(h => cursorLine >= h.startLine && cursorLine < h.endLine);
        if (hunk) {
            await this.acceptHunk(relativePath, hunk.id);
        }
    }

    public async discardHunkAtCursor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        let relativePath: string;
        try {
            relativePath = this.provider.getSafeRelativePath(editor.document.uri.fsPath);
        } catch {
            return;
        }

        const hunks = this._fileHunksCache.get(relativePath) || [];
        const cursorLine = editor.selection.active.line;

        const hunk = hunks.find(h => cursorLine >= h.startLine && cursorLine < h.endLine);
        if (hunk) {
            await this.discardHunk(relativePath, hunk.id);
        }
    }

    public async acceptAllDiff(relativePath: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspacePath = path.join(workspaceFolders[0].uri.fsPath, relativePath);

        const doc = await vscode.workspace.openTextDocument(workspacePath);
        const hunks = this._fileHunksCache.get(relativePath) || [];
        const cleanText = this.getCleanDocumentText(doc, hunks);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(doc.uri, fullRange, cleanText);

        this._isApplyingInternalEdit = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        this._isApplyingInternalEdit = false;

        this._initializedDiffFiles.delete(relativePath);
        this._fileHunksCache.delete(relativePath);

        await this.provider.acceptSingleFile(relativePath);

        if (this._initializedDiffFiles.size === 0) {
            await vscode.commands.executeCommand('setContext', 'windAgent.isInDiffMode', false);
        }

        this.refresh();
    }

    public async discardAllDiff(relativePath: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const workspacePath = path.join(workspaceRoot, relativePath);
        const backupDir = path.join(os.tmpdir(), 'wind-backups', this.provider.getWorkspaceHash());
        const backupPath = path.join(backupDir, relativePath);

        if (await fileExists(backupPath)) {
            const originalContent = await fs.readFile(backupPath, 'utf8');
            const doc = await vscode.workspace.openTextDocument(workspacePath);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            edit.replace(doc.uri, fullRange, originalContent);

            this._isApplyingInternalEdit = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            this._isApplyingInternalEdit = false;
        }

        this._initializedDiffFiles.delete(relativePath);
        this._fileHunksCache.delete(relativePath);

        await this.provider.discardSingleFile(relativePath);

        if (this._initializedDiffFiles.size === 0) {
            await vscode.commands.executeCommand('setContext', 'windAgent.isInDiffMode', false);
        }

        this.refresh();
    }

    public async updateStreamingDiff(relativePath: string, originalContent: string, cleanContent: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const workspacePath = path.join(workspaceRoot, relativePath);

        try {
            const oldLines = originalContent.split(/\r?\n/);
            const newLines = cleanContent.split(/\r?\n/);

            const diffResult = diffLines(oldLines, newLines);
            const merged = mergeDiffLines(diffResult);
            const hunks = getInlineDiffHunks(merged, diffResult);

            const doc = await vscode.workspace.openTextDocument(workspacePath);
            const editor = await vscode.window.showTextDocument(doc);

            const hasCRLF = originalContent.includes('\r\n') || cleanContent.includes('\r\n');
            const mergedText = merged.map(l => l.text).join(hasCRLF ? '\r\n' : '\n');

            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            edit.replace(doc.uri, fullRange, mergedText);

            this._isApplyingInternalEdit = true;
            const success = await vscode.workspace.applyEdit(edit);
            this._isApplyingInternalEdit = false;

            if (success) {
                this._initializedDiffFiles.add(relativePath);
                this._fileHunksCache.set(relativePath, hunks);
                await vscode.commands.executeCommand('setContext', 'windAgent.isInDiffMode', true);
                this.updateDecorationsForEditor(editor);
            }
        } catch (e) {
            console.error('Failed to update streaming diff:', e);
            this._isApplyingInternalEdit = false;
        }
    }
}
