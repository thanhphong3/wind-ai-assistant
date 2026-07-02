import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { Agent } from './agent';
import { ToolsManager } from './tools';
import * as crypto from 'crypto';
import * as os from 'os';
import * as cp from 'child_process';
import * as util from 'util';
import { DiffManager } from './diffProvider';

// Centralized model mapping to avoid duplication
const MODEL_MAPPING: Record<string, string> = {
    'gemini-3.5-flash-high': 'gemini-3.5-flash',
    'gemini-3.5-flash-medium': 'gemini-3.5-flash',
    'gemini-3.5-flash-low': 'gemini-3.5-flash',
    'gemini-3.1-pro-low': 'gemini-3.5-flash',
    'gemini-3.1-pro-high': 'gemini-3.5-flash',
    'claude-3-5-sonnet': 'gemini-3.5-flash',
    'claude-3-opus': 'gemini-3.5-flash',
    'gpt-4o': 'gemini-3.5-flash'
};

const matchesPermission = (requiredScope: string, grantedScopes: Set<string>): boolean => {
    if (grantedScopes.has(requiredScope)) return true;
    if (grantedScopes.has('*')) return true;
    
    if (requiredScope.startsWith('write_file:')) {
        const reqPath = requiredScope.substring(11);
        for (const granted of grantedScopes) {
            if (granted.startsWith('write_file:')) {
                const grantedPath = granted.substring(11);
                if (grantedPath === '' || reqPath === grantedPath || reqPath.startsWith(grantedPath + '/')) {
                    return true;
                }
            }
        }
    }
    
    if (requiredScope.startsWith('command:')) {
        const reqCmd = requiredScope.substring(8);
        for (const granted of grantedScopes) {
            if (granted.startsWith('command:')) {
                const grantedCmd = granted.substring(8);
                if (grantedCmd === '*' || reqCmd === grantedCmd) {
                    return true;
                }
            }
        }
    }
    return false;
};

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.exe', '.dll', '.zip',
    '.tar', '.gz', '.mp3', '.mp4', '.webm', '.bin', '.obj', '.o', '.a',
    '.lib', '.class', '.wasm', '.ttf', '.woff', '.woff2', '.eot', '.psd',
    '.ai', '.sketch', '.bmp', '.tiff', '.7z', '.rar', '.so', '.dylib', '.vsix'
]);

class EditQueue {
    private promise = Promise.resolve();
    enqueue(fn: () => Promise<void>): Promise<void> {
        this.promise = this.promise.then(fn).catch(err => {
            console.error('Error in edit queue:', err);
        });
        return this.promise;
    }
    async wait(): Promise<void> {
        await this.promise;
    }
}

interface ChatSession {
    id: string;
    title: string;
    timestamp: number;
    messages: any[];
    agentHistory: any[];
}

interface ScheduledTask {
    id: string;
    command: string;
    type: 'interval' | 'timeout';
    intervalMs: number;
    timer?: NodeJS.Timeout;
    nextRunTime: number;
}

export class WindWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'wind-agent.chatView';
    private _view?: vscode.WebviewView;
    private _agent?: Agent;
    private _pendingToolResolves = new Map<string, (approved: boolean | string[]) => void>();
    private _activeSessionId?: string;
    private _sessions: ChatSession[] = [];
    private _aiConfigs: any[] = [];
    private _sessionModifiedFiles = new Set<string>();
    private _sessionAcceptedFiles = new Set<string>();
    private _pendingToolArgs = new Map<string, any>();
    private _streamingFiles = new Map<string, {
        absolutePath: string;
        relativePath: string;
        opened: boolean;
        toolName: string;
        startOffset?: number;
        lastReplacementLength?: number;
        queue: EditQueue;
        originalContent?: string;
        cleanContent?: string;
        targetOffset?: number;
        targetLength?: number;
    }>();
    private _workspaceFilesTimeout?: NodeJS.Timeout;
    private _suppressStreaming = false;
    private _diffManager?: DiffManager;

    public setDiffManager(diffManager: DiffManager) {
        this._diffManager = diffManager;
    }
    private _streamAsThought = false;
    private _currentThreadTitle = 'Thinking Process';
    private _activeConfigName?: string;
    private _workspaceWatcher?: vscode.FileSystemWatcher;
    private _configWatcher?: { dispose: () => void };
    private _generalFileWatcher?: vscode.FileSystemWatcher;
    private _cachedWorkspaceHash?: string;
    private _sendModifiedFilesTimer?: NodeJS.Timeout;
    private _configWatchDebounceTimer?: NodeJS.Timeout;
    private _scheduledTasks = new Map<string, ScheduledTask>();
    private _nextTaskId = 1;
    private _backgroundTasks = new Map<string, {
        sessionId: string;
        agent: Agent;
        title: string;
        isWaitingApproval: boolean;
    }>();
    private _statusBarItem?: vscode.StatusBarItem;
    private _cachedWorkspaceFiles: string[] | null = null;
    private _activeTestLoopAbortController?: AbortController;
    private _grantedPermissions = new Set<string>();

    constructor(private readonly _context: vscode.ExtensionContext) {}

    /** Utility: get workspace root or undefined */
    protected get workspaceRootPath(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private async _fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private _getSafeRelativePath(filePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error("No workspace folders open");
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const cleanRelative = filePath.replace(/^[/\\]+/, '');
        const resolved = path.resolve(workspaceRoot, cleanRelative);
        const normalizedRoot = path.resolve(workspaceRoot);
        const relative = path.relative(normalizedRoot.toLowerCase(), resolved.toLowerCase());
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Access Denied: Path escapes workspace folder bounds: ${filePath}`);
        }
        return path.relative(normalizedRoot, resolved).replace(/\\/g, '/');
    }

    public dispose() {
        if (this._workspaceWatcher) {
            this._workspaceWatcher.dispose();
            this._workspaceWatcher = undefined;
        }
        if (this._configWatcher) {
            this._configWatcher.dispose();
            this._configWatcher = undefined;
        }
        if (this._generalFileWatcher) {
            this._generalFileWatcher.dispose();
            this._generalFileWatcher = undefined;
        }
        if (this._workspaceFilesTimeout) {
            clearTimeout(this._workspaceFilesTimeout);
            this._workspaceFilesTimeout = undefined;
        }
        if (this._saveHistoryDebounceTimer) {
            clearTimeout(this._saveHistoryDebounceTimer);
            this._saveHistoryDebounceTimer = undefined;
        }
        if (this._sendModifiedFilesTimer) {
            clearTimeout(this._sendModifiedFilesTimer);
            this._sendModifiedFilesTimer = undefined;
        }
        if (this._configWatchDebounceTimer) {
            clearTimeout(this._configWatchDebounceTimer);
            this._configWatchDebounceTimer = undefined;
        }
        for (const task of this._scheduledTasks.values()) {
            if (task.timer) {
                if (task.type === 'timeout') {
                    clearTimeout(task.timer);
                } else {
                    clearInterval(task.timer);
                }
            }
        }
        this._scheduledTasks.clear();
        for (const bgTask of this._backgroundTasks.values()) {
            bgTask.agent.cancel();
        }
        this._backgroundTasks.clear();
        this._updateStatusBar();
        this._cancelActiveExecution();
        ToolsManager.dispose().catch(err => {
            console.error('Failed to dispose ToolsManager on provider disposal:', err);
        });
    }

    public get sessionModifiedFiles(): Set<string> {
        return this._sessionModifiedFiles;
    }

    public getSessionAcceptedFiles(): Set<string> {
        return this._sessionAcceptedFiles;
    }

    public getWorkspaceHash(): string {
        return this._getWorkspaceHash();
    }

    public getSafeRelativePath(filePath: string): string {
        return this._getSafeRelativePath(filePath);
    }

    public async acceptSingleFile(relativePath: string): Promise<void> {
        let safeRelative: string;
        try {
            safeRelative = this._getSafeRelativePath(relativePath);
        } catch (err) {
            console.error(err);
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceHash = this._getWorkspaceHash();
            const backupDir = path.join(os.tmpdir(), 'wind-backups', workspaceHash);
            const backupPath = path.join(backupDir, safeRelative);
            try {
                if (await this._fileExists(backupPath)) {
                    await fs.promises.unlink(backupPath);
                    // Clean up empty directories in backup recursively, up to backupDir
                    let dir = path.dirname(backupPath);
                    while (dir !== backupDir && dir.startsWith(backupDir)) {
                        if (await this._fileExists(dir) && (await fs.promises.readdir(dir)).length === 0) {
                            await fs.promises.rmdir(dir);
                            dir = path.dirname(dir);
                        } else {
                            break;
                        }
                    }
                }
            } catch (e) {
                console.error('Failed to clean up backup file:', e);
            }
            
            // Also remove from metadata.json's newFiles list if it exists
            const metadataPath = path.join(backupDir, 'metadata.json');
            if (await this._fileExists(metadataPath)) {
                try {
                    const metaStr = await fs.promises.readFile(metadataPath, 'utf8');
                    const parsed = JSON.parse(metaStr);
                    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.newFiles)) {
                        parsed.newFiles = parsed.newFiles.filter((f: string) => f !== safeRelative);
                        await fs.promises.writeFile(metadataPath, JSON.stringify(parsed, null, 2), 'utf8');
                    }
                } catch (e) {
                    console.error('Error updating metadata.json in acceptSingleFile:', e);
                }
            }

            this._sessionAcceptedFiles.add(safeRelative);
            this._sessionModifiedFiles.delete(safeRelative);

            if (this._sessionModifiedFiles.size === 0) {
                try {
                    if (await this._fileExists(backupDir)) {
                        await fs.promises.rm(backupDir, { recursive: true, force: true });
                    }
                } catch (e) {
                    console.error('Failed to clean up backup directory:', e);
                }
            }
        }
        await this._sendModifiedFiles();
    }

    public async discardSingleFile(relativePath: string): Promise<void> {
        return this._discardSingleFile(relativePath);
    }

    private _updateStatusBar() {
        if (!this._statusBarItem) return;
        const tasks = Array.from(this._backgroundTasks.values());
        if (tasks.length === 0) {
            this._statusBarItem.hide();
        } else {
            const runningCount = tasks.filter(t => !t.isWaitingApproval).length;
            const waitingCount = tasks.filter(t => t.isWaitingApproval).length;
            
            if (waitingCount > 0) {
                this._statusBarItem.text = `$(warning) Wind: ${waitingCount} waiting, ${runningCount} running`;
                this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                this._statusBarItem.text = `$(sync~spin) Wind Tasks: ${runningCount}`;
                this._statusBarItem.backgroundColor = undefined;
            }
            this._statusBarItem.show();
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this._cachedWorkspaceFiles = null;

        if (!this._statusBarItem) {
            this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this._statusBarItem.command = 'wind-agent.chatView.focus';
            this._statusBarItem.tooltip = 'Wind Background Tasks';
            this._context.subscriptions.push(this._statusBarItem);
        }
        this._updateStatusBar();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._context.extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Load persisted sessions
        this._sessions = this._context.workspaceState.get<ChatSession[]>('chatHistory') || [];

        // Watch for workspace config file changes if workspace exists
        if (this._workspaceWatcher) {
            this._workspaceWatcher.dispose();
        }
        const triggerConfigSync = () => {
            if (this._configWatchDebounceTimer) {
                clearTimeout(this._configWatchDebounceTimer);
            }
            this._configWatchDebounceTimer = setTimeout(() => {
                this._loadAndSyncConfig();
            }, 500);
        };

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            this._workspaceWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(workspaceRoot, 'ai_config.json')
            );
            this._workspaceWatcher.onDidChange(triggerConfigSync);
            this._workspaceWatcher.onDidCreate(triggerConfigSync);
            this._workspaceWatcher.onDidDelete(triggerConfigSync);
        }

        // Watch for config file changes in home directory
        if (this._configWatcher) {
            this._configWatcher.dispose();
        }
        const homeDir = os.homedir();
        const globalConfigDir = path.join(homeDir, '.wind-agent');
        const oldConfigDir = path.join(homeDir, '.wind');
        if (fs.existsSync(oldConfigDir) && !fs.existsSync(globalConfigDir)) {
            try {
                fs.renameSync(oldConfigDir, globalConfigDir);
            } catch (e) {
                console.error('Failed to migrate config dir:', e);
            }
        }
        if (!fs.existsSync(globalConfigDir)) {
            fs.promises.mkdir(globalConfigDir, { recursive: true }).then(() => {
                try {
                    const watcher = fs.watch(globalConfigDir, (_, filename) => {
                        if (filename === 'ai_config.json') {
                            this._loadAndSyncConfig();
                        }
                    });
                    watcher.on('error', (err) => {
                        console.error('fs.watch error for globalConfigDir:', err);
                    });
                    this._configWatcher = {
                        dispose: () => watcher.close()
                    };
                } catch (err: any) {
                    console.error('Failed to start config directory watcher:', err.message);
                }
            }).catch((err: any) => {
                console.error('Failed to create config directory:', err.message);
            });
        } else {
            try {
                const watcher = fs.watch(globalConfigDir, (_, filename) => {
                    if (filename === 'ai_config.json') {
                        // Debounce fs.watch which can fire multiple rapid events
                        if (this._configWatchDebounceTimer) {
                            clearTimeout(this._configWatchDebounceTimer);
                        }
                        this._configWatchDebounceTimer = setTimeout(() => {
                            this._loadAndSyncConfig();
                        }, 500);
                    }
                });
                watcher.on('error', (err) => {
                    console.error('fs.watch error for globalConfigDir:', err);
                });
                this._configWatcher = {
                    dispose: () => watcher.close()
                };
            } catch (err: any) {
                console.error('Failed to start config directory watcher:', err.message);
            }
        }



        // Watch for workspace file changes to keep file list updated in webview
        if (this._generalFileWatcher) {
            this._generalFileWatcher.dispose();
        }
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            this._generalFileWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(workspaceRoot, '**/*')
            );
            
            const isIgnored = (fsPath: string) => {
                const normalized = fsPath.replace(/\\/g, '/');
                if (normalized.includes('/node_modules/') ||
                    normalized.includes('/.git/') ||
                    normalized.includes('/out/') ||
                    normalized.includes('/dist/') ||
                    normalized.includes('/.vscode/') ||
                    normalized.includes('/bin/') ||
                    normalized.includes('/obj/') ||
                    normalized.includes('/build/') ||
                    normalized.includes('/.next/') ||
                    normalized.includes('/target/') ||
                    normalized.includes('/.venv/') ||
                    normalized.includes('/venv/') ||
                    normalized.includes('/env/') ||
                    normalized.includes('/.idea/') ||
                    normalized.includes('/.cache/') ||
                    normalized.includes('/.nuxt/') ||
                    normalized.includes('/Library/') ||
                    normalized.includes('/Temp/') ||
                    normalized.includes('/Logs/') ||
                    normalized.includes('/UserSettings/') ||
                    normalized.includes('/.vs/')) {
                    return true;
                }
                const ext = fsPath.split('.').pop()?.toLowerCase();
                return ext === 'meta' || ext === 'png' || ext === 'mat' || ext === 'wav' ||
                       ext === 'asset' || ext === 'prefab' || ext === 'anim' || ext === 'fbx' ||
                       ext === 'tga' || ext === 'mp3' || ext === 'overridecontroller' || ext === 'controller';
            };

            this._generalFileWatcher.onDidCreate(async (uri) => {
                if (!isIgnored(uri.fsPath)) {
                    try {
                        const stat = await fs.promises.stat(uri.fsPath);
                        if (stat.isFile()) {
                            const relPath = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
                            if (this._cachedWorkspaceFiles) {
                                if (!this._cachedWorkspaceFiles.includes(relPath)) {
                                    this._cachedWorkspaceFiles.push(relPath);
                                    this._cachedWorkspaceFiles.sort();
                                    if (this._cachedWorkspaceFiles.length > 10000) {
                                        this._cachedWorkspaceFiles = this._cachedWorkspaceFiles.slice(0, 10000);
                                    }
                                    this._sendWorkspaceFilesDebounced();
                                }
                            }
                        } else if (stat.isDirectory()) {
                            // If a directory was created (e.g. pasted folder), invalidate the cache to force full rebuild
                            this._cachedWorkspaceFiles = null;
                            this._sendWorkspaceFilesDebounced();
                        }
                    } catch (e) {
                        // ignore stat errors, keep existing cache intact
                    }
                }
            });
            this._generalFileWatcher.onDidDelete((uri) => {
                if (!isIgnored(uri.fsPath)) {
                    const relPath = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
                    if (this._cachedWorkspaceFiles) {
                        const originalLen = this._cachedWorkspaceFiles.length;
                        this._cachedWorkspaceFiles = this._cachedWorkspaceFiles.filter(
                            p => p !== relPath && !p.startsWith(relPath + '/')
                        );
                        if (this._cachedWorkspaceFiles.length !== originalLen) {
                            this._sendWorkspaceFilesDebounced();
                        }
                    }
                }
            });
        }

        // Message listener
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'stop':
                    this._cancelActiveExecution();
                    break;
                case 'resolveDraggedFile': {
                    const uriStr = data.uri;
                    if (!uriStr) break;
                    
                    try {
                        if (uriStr.startsWith('http://') || uriStr.startsWith('https://')) {
                            // Remote image URL, download and resolve to base64
                            const response = await axios.get(uriStr, { responseType: 'arraybuffer' });
                            const contentType = response.headers['content-type'];
                            if (typeof contentType === 'string' && contentType.startsWith('image/')) {
                                const base64 = Buffer.from(response.data, 'binary').toString('base64');
                                const dataUrl = `data:${contentType};base64,${base64}`;
                                webviewView.webview.postMessage({ type: 'draggedFileResolved', dataUrl });
                            }
                        } else {
                            // Local file path or URI
                            let filePath = '';
                            if (uriStr.startsWith('file://') || uriStr.startsWith('vscode-file://') || uriStr.startsWith('vscode-resource://') || uriStr.startsWith('vscode-webview-resource://')) {
                                let uri = vscode.Uri.parse(uriStr);
                                if (uri.scheme !== 'file') {
                                    uri = uri.with({ scheme: 'file', authority: '' });
                                }
                                filePath = uri.fsPath;
                            } else if (uriStr.includes('://')) {
                                // Fallback for any other custom VS Code scheme
                                let uri = vscode.Uri.parse(uriStr);
                                if (uri.scheme !== 'file') {
                                    uri = uri.with({ scheme: 'file', authority: '' });
                                }
                                filePath = uri.fsPath;
                            } else {
                                filePath = uriStr;
                            }

                            try {
                                filePath = decodeURIComponent(filePath);
                            } catch (e) {
                                // Ignore malformed URL decoding if it's already decoded or contains raw '%'
                            }

                            // If relative path, resolve against workspace root
                            if (!path.isAbsolute(filePath)) {
                                const workspaceFolders = vscode.workspace.workspaceFolders;
                                if (workspaceFolders && workspaceFolders.length > 0) {
                                    filePath = path.join(workspaceFolders[0].uri.fsPath, filePath);
                                }
                            }

                            if (fs.existsSync(filePath)) {
                                try {
                                    const stats = await fs.promises.stat(filePath);
                                    if (stats.isFile()) {
                                        const ext = path.extname(filePath).toLowerCase();
                                        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
                                        
                                        if (imageExtensions.includes(ext)) {
                                            const buffer = await fs.promises.readFile(filePath);
                                            let mimeType = 'image/png';
                                            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                                            else if (ext === '.gif') mimeType = 'image/gif';
                                            else if (ext === '.webp') mimeType = 'image/webp';
                                            else if (ext === '.bmp') mimeType = 'image/bmp';
                                            else if (ext === '.svg') mimeType = 'image/svg+xml';
                                            
                                            const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
                                            webviewView.webview.postMessage({ type: 'draggedFileResolved', dataUrl });
                                        } else {
                                            // Treat as text/code file reference
                                            // Only read files under 100KB to avoid UI freezing or huge contexts
                                            if (stats.size < 100 * 1024) {
                                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                                const workspaceFolders = vscode.workspace.workspaceFolders;
                                                let displayPath = filePath;
                                                if (workspaceFolders && workspaceFolders.length > 0) {
                                                    displayPath = path.relative(workspaceFolders[0].uri.fsPath, filePath);
                                                }
                                                
                                                // Simple map extension -> language ID
                                                const langMap: { [key: string]: string } = {
                                                    '.js': 'javascript',
                                                    '.ts': 'typescript',
                                                    '.tsx': 'typescriptreact',
                                                    '.jsx': 'javascriptreact',
                                                    '.json': 'json',
                                                    '.css': 'css',
                                                    '.html': 'html',
                                                    '.md': 'markdown',
                                                    '.py': 'python',
                                                    '.go': 'go',
                                                    '.rs': 'rust',
                                                    '.cs': 'csharp',
                                                    '.sh': 'bash'
                                                };
                                                const languageId = langMap[ext] || '';

                                                webviewView.webview.postMessage({
                                                    type: 'draggedFileResolved',
                                                    filePath: displayPath,
                                                    fileContentReference: fileContent,
                                                    languageId
                                                });
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error('Failed to resolve dragged file:', e);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Failed to resolve dragged file:', e);
                    }
                    break;
                }
                case 'message':
                    await this._handleUserMessage(data.text, data.model, data.mode, data.configIndex, data.images, data.contextItems);
                    break;
                case 'webviewReady': {
                    await this._loadAndSyncConfig();
                    const config = vscode.workspace.getConfiguration('windAgent');
                    const autoExecution = config.get<string>('autoExecution') || 'Ask for Approval';
                    const autoExecutePlan = config.get<boolean>('autoExecutePlan') || false;
                    const browser = config.get<string>('browser') || 'auto';
                    const enableInlineCompletion = config.get<boolean>('enableInlineCompletion') === true;
                    const inlineCompletionModel = config.get<string>('inlineCompletionModel') || 'gemini-2.5-flash';
                    const inlineCompletionTimeout = config.get<number>('inlineCompletionTimeout') || 30000;
                    webviewView.webview.postMessage({
                        type: 'settings',
                        autoExecution,
                        autoExecutePlan,
                        browser,
                        enableInlineCompletion,
                        inlineCompletionModel,
                        inlineCompletionTimeout
                    });
                    await this._sendMcpServers();
                    await this._syncModifiedFilesFromBackup();
                    await this._sendWorkspaceFiles();
                    this._sendPermissionsToWebview();
                    break;
                }
                case 'getSettings': {
                    const config = vscode.workspace.getConfiguration('windAgent');
                    const autoExecution = config.get<string>('autoExecution') || 'Ask for Approval';
                    const autoExecutePlan = config.get<boolean>('autoExecutePlan') || false;
                    const browser = config.get<string>('browser') || 'auto';
                    const enableInlineCompletion = config.get<boolean>('enableInlineCompletion') === true;
                    const inlineCompletionModel = config.get<string>('inlineCompletionModel') || 'gemini-2.5-flash';
                    const inlineCompletionTimeout = config.get<number>('inlineCompletionTimeout') || 30000;
                    webviewView.webview.postMessage({
                        type: 'settings',
                        autoExecution,
                        autoExecutePlan,
                        browser,
                        enableInlineCompletion,
                        inlineCompletionModel,
                        inlineCompletionTimeout
                    });
                    await this._sendMcpServers();
                    break;
                }
                case 'getMcpServers': {
                    await this._sendMcpServers();
                    break;
                }
                case 'addMcpServer': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        const manager = this._agent ? this._agent.toolsManager : new ToolsManager(workspaceRoot);
                        try {
                            const argsArray = data.args ? data.args.split(',').map((a: string) => a.trim()).filter((a: string) => a) : [];
                            let envObj = undefined;
                            if (data.env) {
                                try {
                                    envObj = JSON.parse(data.env);
                                } catch (e) {
                                    // Ignore
                                }
                            }
                            await manager.addMcpServer(data.name, {
                                command: data.command,
                                args: argsArray,
                                env: envObj
                            });
                            await this._sendMcpServers();
                            vscode.window.showInformationMessage(`MCP Server "${data.name}" added successfully.`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to add MCP Server: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'deleteMcpServer': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        const manager = this._agent ? this._agent.toolsManager : new ToolsManager(workspaceRoot);
                        try {
                            const confirmDelete = await vscode.window.showWarningMessage(
                                `Are you sure you want to delete the MCP Server "${data.name}"?`,
                                { modal: true },
                                'Delete'
                            );
                            if (confirmDelete === 'Delete') {
                                await manager.deleteMcpServer(data.name);
                                await this._sendMcpServers();
                                vscode.window.showInformationMessage(`MCP Server "${data.name}" deleted successfully.`);
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to delete MCP Server: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'toggleMcpServer': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        const manager = this._agent ? this._agent.toolsManager : new ToolsManager(workspaceRoot);
                        try {
                            await manager.toggleMcpServer(data.name, data.enabled);
                            await this._sendMcpServers();
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to toggle MCP Server: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'updateSetting': {
                    const config = vscode.workspace.getConfiguration('windAgent');
                    if (data.key === 'autoExecution') {
                        await config.update('autoExecution', data.value, vscode.ConfigurationTarget.Global);
                    } else if (data.key === 'autoExecutePlan') {
                        await config.update('autoExecutePlan', data.value, vscode.ConfigurationTarget.Global);
                    } else if (data.key === 'browser') {
                        await config.update('browser', data.value, vscode.ConfigurationTarget.Global);
                    } else if (data.key === 'enableInlineCompletion') {
                        await config.update('enableInlineCompletion', data.value, vscode.ConfigurationTarget.Global);
                    } else if (data.key === 'inlineCompletionModel') {
                        await config.update('inlineCompletionModel', data.value, vscode.ConfigurationTarget.Global);
                    } else if (data.key === 'inlineCompletionTimeout') {
                        await config.update('inlineCompletionTimeout', data.value, vscode.ConfigurationTarget.Global);
                    }
                    break;
                }
                case 'openConfig':
                    await this.openConfigFile();
                    break;
                case 'openMcpConfig':
                    await this.openMcpConfigFile();
                    break;
                case 'clear':
                    this._activeSessionId = undefined;
                    if (this._agent) {
                        this._agent.clearHistory();
                    }
                    this._sessionModifiedFiles.clear();
                    this._sessionAcceptedFiles.clear();
                    this._sendModifiedFiles();
                    webviewView.webview.postMessage({ type: 'clearChat' });
                    ToolsManager.dispose().catch(err => {
                        console.error('Failed to dispose ToolsManager on clear:', err);
                    });
                    break;
                case 'openFile': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        try {
                            const safeRelativePath = this._getSafeRelativePath(data.filePath);
                            const workspaceRoot = workspaceFolders[0].uri.fsPath;
                            const fullPath = path.join(workspaceRoot, safeRelativePath);
                            const workspaceHash = this._getWorkspaceHash();
                            const backupPath = path.join(os.tmpdir(), 'wind-backups', workspaceHash, safeRelativePath);

                            if (await this._fileExists(backupPath)) {
                                const backupUri = vscode.Uri.file(backupPath);
                                const currentUri = vscode.Uri.file(fullPath);
                                const fileName = path.basename(safeRelativePath);
                                await vscode.commands.executeCommand(
                                    'vscode.diff',
                                    backupUri,
                                    currentUri,
                                    `${fileName} (Wind Diff)`
                                );
                            } else {
                                const doc = await vscode.workspace.openTextDocument(fullPath);
                                await vscode.window.showTextDocument(doc);
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Cannot open file: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'openDiff': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        try {
                            const safeRelativePath = this._getSafeRelativePath(data.filePath);
                            const workspaceRoot = workspaceFolders[0].uri.fsPath;
                            const fullPath = path.join(workspaceRoot, safeRelativePath);
                            const workspaceHash = this._getWorkspaceHash();
                            const backupPath = path.join(os.tmpdir(), 'wind-backups', workspaceHash, safeRelativePath);

                            if (await this._fileExists(backupPath)) {
                                const backupUri = vscode.Uri.file(backupPath);
                                const currentUri = vscode.Uri.file(fullPath);
                                const fileName = path.basename(safeRelativePath);
                                await vscode.commands.executeCommand(
                                    'vscode.diff',
                                    backupUri,
                                    currentUri,
                                    `${fileName} (Wind Diff)`
                                );
                            } else {
                                const doc = await vscode.workspace.openTextDocument(fullPath);
                                await vscode.window.showTextDocument(doc);
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Cannot compare file: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'openFileDirectly': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        try {
                            const safeRelativePath = this._getSafeRelativePath(data.filePath);
                            const workspaceRoot = workspaceFolders[0].uri.fsPath;
                            const fullPath = path.join(workspaceRoot, safeRelativePath);
                            const doc = await vscode.workspace.openTextDocument(fullPath);
                            await vscode.window.showTextDocument(doc);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Cannot open file: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'sendToBackground': {
                    if (this._agent && this._activeSessionId) {
                        const sessionId = this._activeSessionId;
                        const session = this._sessions.find(s => s.id === sessionId);
                        const title = session ? session.title : 'Task';
                        
                        this._backgroundTasks.set(sessionId, {
                            sessionId,
                            agent: this._agent,
                            title,
                            isWaitingApproval: false
                        });
                        this._updateStatusBar();
                        
                        this._agent = undefined;

                        webviewView.webview.postMessage({
                            type: 'setLoading',
                            isLoading: false
                        });
                    }
                    break;
                }
                case 'openInBrowser': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        try {
                            const safeRelativePath = this._getSafeRelativePath(data.filePath);
                            const workspaceRoot = workspaceFolders[0].uri.fsPath;
                            const fullPath = path.join(workspaceRoot, safeRelativePath);
                            const fileUri = vscode.Uri.file(fullPath);
                            await vscode.env.openExternal(fileUri);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Cannot open in browser: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'acceptChanges': {
                    const filesToAccept = Array.from(this._sessionModifiedFiles);
                    for (const relativePath of filesToAccept) {
                        if (this._diffManager) {
                            await this._diffManager.acceptAllDiff(relativePath);
                        } else {
                            await this.acceptSingleFile(relativePath);
                        }
                    }
                    this._sessionModifiedFiles.clear();
                    await this._sendModifiedFiles();
                    vscode.window.showInformationMessage('Accepted all changes.');
                    break;
                }
                case 'discardChanges': {
                    const filesToDiscard = Array.from(this._sessionModifiedFiles);
                    for (const relativePath of filesToDiscard) {
                        if (this._diffManager) {
                            await this._diffManager.discardAllDiff(relativePath);
                        } else {
                            await this._discardSingleFile(relativePath);
                        }
                    }
                    this._sessionModifiedFiles.clear();
                    this._sessionAcceptedFiles.clear();
                    await this._sendModifiedFiles();
                    vscode.window.showInformationMessage('Discarded all changes.');
                    break;
                }
                case 'acceptSingleFile': {
                    try {
                        const relativePath = this._getSafeRelativePath(data.filePath);
                        if (this._diffManager) {
                            await this._diffManager.acceptAllDiff(relativePath);
                        } else {
                            await this.acceptSingleFile(relativePath);
                        }
                        vscode.window.showInformationMessage(`Accepted changes for ${relativePath}.`);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Accept failed: ${err.message}`);
                    }
                    break;
                }
                case 'discardSingleFile': {
                    try {
                        const relativePath = this._getSafeRelativePath(data.filePath);
                        if (this._diffManager) {
                            await this._diffManager.discardAllDiff(relativePath);
                        } else {
                            await this._discardSingleFile(relativePath);
                        }
                        vscode.window.showInformationMessage(`Discarded changes for ${relativePath}.`);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Discard failed: ${err.message}`);
                    }
                    break;
                }
                case 'approveTool':
                    this._resolvePendingTool(data.toolId, true);
                    break;
                case 'rejectTool':
                    this._resolvePendingTool(data.toolId, false);
                    break;
                case 'loadHistory':
                    this._sendHistoryToWebview();
                    break;
                case 'selectSession':
                    await this._loadSession(data.sessionId);
                    break;
                case 'deleteSession':
                    this._deleteSession(data.sessionId);
                    break;
                case 'executePlan':
                    await this._executePlan(data.tasks, data.model, data.configIndex, data.startIndex);
                    break;
                case 'editMessage':
                    await this._handleEditMessage(data.index, data.text, data.model, data.mode, data.configIndex);
                    break;
                case 'selectModel':
                    await this._context.workspaceState.update('selectedModel', data.model);
                    await this._context.workspaceState.update('selectedModelConfigIndex', data.configIndex);
                    break;
                case 'selectMode':
                    await this._context.workspaceState.update('selectedMode', data.mode);
                    break;
                case 'selectSendContext':
                    await this._context.workspaceState.update('sendContext', data.sendContext);
                    break;
                case 'selectFastAction':
                    await this._context.workspaceState.update('fastAction', data.fastAction);
                    break;

                case 'submitQuestionResponse': {
                    const toolId = data.toolId;
                    const answer: string[] = Array.isArray(data.answer) ? data.answer : [];
                    // Pass answers directly through the pending tool resolve so the
                    // onToolCall callback can call setLastQuestionResponse with the correct data.
                    this._resolvePendingTool(toolId, answer);
                    break;
                }
                case 'updateTaskStatus': {
                    const idx = data.index;
                    const status = data.status;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        const taskMdPath = path.join(workspaceRoot, 'task.md');
                        try {
                            const exists = await fs.promises.access(taskMdPath).then(() => true).catch(() => false);
                            if (exists) {
                                const content = await fs.promises.readFile(taskMdPath, 'utf8');
                                const lines = content.split('\n');
                                let checkboxIndex = 0;
                                for (let i = 0; i < lines.length; i++) {
                                    const match = lines[i].match(/^-\s*\[([\sxX/]?)\]/);
                                    if (match) {
                                        if (checkboxIndex === idx) {
                                            lines[i] = lines[i].replace(/^-\s*\[([\sxX/]?)\]/, `- [${status}]`);
                                            break;
                                        }
                                        checkboxIndex++;
                                    }
                                }
                                await this._writeWorkspaceFile(taskMdPath, lines.join('\n'));
                            }
                        } catch (e) {
                            console.error('Failed to update task.md from Webview:', e);
                        }
                    }
                    break;
                }
                case 'grantPermissionScope': {
                    const scope = data.scope;
                    if (scope) {
                        this._grantedPermissions.add(scope);
                        this._sendPermissionsToWebview();
                    }
                    break;
                }
                case 'revokePermissionScope': {
                    const scope = data.scope;
                    if (scope) {
                        this._grantedPermissions.delete(scope);
                        this._sendPermissionsToWebview();
                    }
                    break;
                }
                case 'clearPermissions': {
                    this._grantedPermissions.clear();
                    this._sendPermissionsToWebview();
                    break;
                }

                case 'refreshModels':
                    await this._loadAndSyncConfig();
                    break;

                case 'showError':
                    vscode.window.showErrorMessage(data.message);
                    break;

                case 'addAIProvider': {
                    const newConfig = data.config;
                    const configIndex = data.configIndex;
                    try {
                        const { configPath } = this._getConfigFileInfo();
                        let currentConfigs: any[] = [];
                        if (fs.existsSync(configPath)) {
                            const content = await fs.promises.readFile(configPath, 'utf8');
                            currentConfigs = JSON.parse(content);
                            if (!Array.isArray(currentConfigs)) {
                                currentConfigs = [];
                            }
                        }
                        
                        if (typeof configIndex === 'number' && configIndex >= 0 && configIndex < currentConfigs.length) {
                            currentConfigs[configIndex] = newConfig;
                            vscode.window.showInformationMessage(`Updated AI configuration: ${newConfig.name}`);
                        } else {
                            currentConfigs.push(newConfig);
                            vscode.window.showInformationMessage(`Added AI configuration: ${newConfig.name}`);
                        }
                        
                        // Write back to config file
                        await fs.promises.writeFile(configPath, JSON.stringify(currentConfigs, null, 4), 'utf8');
                        
                        // Refresh configurations and notify webview
                        await this._loadAndSyncConfig();
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Cannot save AI configuration: ${err.message}`);
                    }
                    break;
                }

                case 'deleteAIProvider': {
                    const configIndex = data.configIndex;
                    try {
                        const { configPath } = this._getConfigFileInfo();
                        if (fs.existsSync(configPath)) {
                            const content = await fs.promises.readFile(configPath, 'utf8');
                            const currentConfigs = JSON.parse(content);
                            if (Array.isArray(currentConfigs) && typeof configIndex === 'number' && configIndex >= 0 && configIndex < currentConfigs.length) {
                                const deletedName = currentConfigs[configIndex].name;
                                const confirmDelete = await vscode.window.showWarningMessage(
                                    `Are you sure you want to delete the AI configuration "${deletedName}"?`,
                                    { modal: true },
                                    'Delete'
                                );
                                
                                if (confirmDelete === 'Delete') {
                                    currentConfigs.splice(configIndex, 1);
                                    await fs.promises.writeFile(configPath, JSON.stringify(currentConfigs, null, 4), 'utf8');
                                    vscode.window.showInformationMessage(`Deleted AI configuration: ${deletedName}`);
                                    await this._loadAndSyncConfig();
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Cannot delete AI configuration: ${err.message}`);
                    }
                    break;
                }
            }
        });
    }

    private _getAPIConfig(configIndex?: number, selectedModel?: string): {
        apiKey: string | string[];
        keys: string[];
        endpoint: string;
        model: string;
        configName: string;
    } {
        const config = vscode.workspace.getConfiguration('windAgent');
        let rawKey = config.get<string | string[]>('apiKey') || '';
        let endpoint = config.get<string>('apiEndpoint') || 'https://generativelanguage.googleapis.com/v1beta/openai';
        let model = config.get<string>('model') || 'gemini-2.5-flash';
        let configName = '';
        let keys: string[];

        if (configIndex !== undefined && this._aiConfigs && this._aiConfigs[configIndex]) {
            const aiConfig = this._aiConfigs[configIndex];
            rawKey = aiConfig.apiKey || rawKey;
            configName = aiConfig.name || '';
            keys = Array.isArray(rawKey) ? rawKey : (rawKey ? [rawKey] : []);
            
            if (selectedModel) {
                model = selectedModel;
            } else if (aiConfig.resolvedModels && aiConfig.resolvedModels.length > 0) {
                model = aiConfig.resolvedModels[0];
            } else if (typeof aiConfig.model === 'string') {
                model = aiConfig.model;
            } else if (Array.isArray(aiConfig.model) && aiConfig.model.length > 0) {
                model = aiConfig.model[0];
            }

            if (aiConfig.provider === 'gemini') {
                const apiBase = (aiConfig.apiBase || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
                endpoint = `${apiBase}/v1beta/openai`;
            } else if (aiConfig.provider === 'gameloft') {
                endpoint = (aiConfig.apiBase || 'https://ask.ai.gameloft.org/api').replace(/\/+$/, '');
            } else {
                endpoint = (aiConfig.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
            }
        } else {
            keys = Array.isArray(rawKey) ? rawKey : (rawKey ? [rawKey] : []);
            if (selectedModel) {
                const isGeminiEndpoint = endpoint.includes('googleapis.com') || endpoint.includes('generativelanguage');
                model = isGeminiEndpoint ? (MODEL_MAPPING[selectedModel] || selectedModel) : selectedModel;
            }
        }

        return {
            apiKey: rawKey,
            keys,
            endpoint,
            model,
            configName
        };
    }

    public pinSelectionToChat(selectedText: string, filePath: string, startLine: number, endLine: number, languageId: string) {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({
                type: 'pinSelection',
                text: selectedText,
                filePath,
                startLine,
                endLine,
                languageId
            });
        }
    }

    public async inlineEdit(selectedText: string, languageId: string, instruction: string, token?: vscode.CancellationToken): Promise<string> {
        const configIndex = (this._aiConfigs && this._aiConfigs.length > 0) ? 0 : undefined;
        const { keys, endpoint, model, configName } = this._getAPIConfig(configIndex);

        const systemPrompt = `You are a precise code editing assistant.
Your task is to modify the provided code according to the user's instructions.
IMPORTANT rules:
1. Return ONLY the modified code.
2. Wrap the modified code in a markdown code block matching the language.
3. Do NOT include any explanations, markdown text, or comments outside the code block.
4. Keep the code style, indentation, and structure of the original code, unless requested otherwise.`;

        const userPrompt = `Here is the original code to modify:
\`\`\`${languageId}
${selectedText}
\`\`\`

User instructions:
${instruction}

Please output the modified code:`;

        const url = endpoint.replace(/\/+$/, '');
        const body = {
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2
        };

        const cachedIndex = configName 
            ? (this._context.workspaceState.get<number>(`activeKeyIndex_${configName}`) || 0)
            : 0;
        
        const keysCount = keys.length || 1;
        const startIndex = (cachedIndex >= 0 && cachedIndex < keysCount) ? cachedIndex : 0;

        let lastError: any = null;
        for (let attempt = 0; attempt < keysCount; attempt++) {
            const currentIndex = (startIndex + attempt) % keysCount;
            const currentKey = keys[currentIndex];

            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            if (currentKey) {
                headers['Authorization'] = `Bearer ${currentKey}`;
            }

            let abortController: AbortController | undefined;
            let cancelListener: vscode.Disposable | undefined;
            if (token) {
                abortController = new AbortController();
                cancelListener = token.onCancellationRequested(() => {
                    abortController!.abort();
                });
            }

            try {
                const res = await axios.post(`${url}/chat/completions`, body, { 
                    headers,
                    timeout: 30000,
                    signal: abortController?.signal
                });

                if (res.data && res.data.choices && res.data.choices.length > 0) {
                    if (configName && keys.length > 1) {
                        await this._context.workspaceState.update(`activeKeyIndex_${configName}`, currentIndex);
                    }
                    const content = res.data.choices[0].message.content || '';
                    let cleanContent = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
                    cleanContent = cleanContent.replace(/<thought>[\s\S]*$/gi, '');
                    cleanContent = cleanContent.replace(/^[\s\S]*?<\/thought>/gi, '');

                    let code = cleanContent.trim();
                    const match = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
                    if (match) {
                        code = match[1];
                    }
                    return code;
                }
                throw new Error('LLM call returned an empty response.');
            } catch (err: any) {
                lastError = err;
            } finally {
                if (cancelListener) {
                    cancelListener.dispose();
                }
            }
        }

        throw lastError || new Error('All API Keys failed for inline edit.');
    }

    public async getInlineCompletion(prefix: string, suffix: string, languageId: string, token?: vscode.CancellationToken): Promise<string> {
        const config = vscode.workspace.getConfiguration('windAgent');
        const enableInlineCompletion = config.get<boolean>('enableInlineCompletion') === true;
        if (!enableInlineCompletion) {
            return '';
        }
        if (token?.isCancellationRequested) {
            return '';
        }
        const inlineCompletionTimeout = config.get<number>('inlineCompletionTimeout') || 30000;

        const workspaceState = this._context.workspaceState;
        let targetModel = config.get<string>('inlineCompletionModel') || workspaceState.get<string>('selectedModel');
        let targetConfigIndex = workspaceState.get<number>('selectedModelConfigIndex');

        const customAutocompleteModel = config.get<string>('inlineCompletionModel');
        if (customAutocompleteModel && this._aiConfigs && this._aiConfigs.length > 0) {
            const foundIndex = this._aiConfigs.findIndex(cfg => 
                (cfg.resolvedModels && cfg.resolvedModels.includes(customAutocompleteModel)) ||
                (Array.isArray(cfg.model) && cfg.model.includes(customAutocompleteModel)) ||
                cfg.model === customAutocompleteModel
            );
            if (foundIndex !== -1) {
                targetConfigIndex = foundIndex;
                targetModel = customAutocompleteModel;
            }
        }

        const { keys, endpoint, model, configName } = this._getAPIConfig(targetConfigIndex, targetModel);

        const systemPrompt = `You are a precise code completion assistant.
Your task is to predict the next few lines of code to continue the user's code at the cursor.
IMPORTANT rules:
1. Return ONLY the code completion suggestion.
2. Do NOT use markdown code blocks (do not wrap in \`\`\`).
3. Suggest only the immediate next logical lines (max 5 lines).
4. Keep the suggestions short and relevant to the context.`;

        const userPrompt = `Language: ${languageId}

Code before cursor:
${prefix}

Code after cursor:
${suffix}

GIVE ONLY THE CODE CONTINUATION WITHOUT EXPLAINING OR MARKDOWN WRAPPING:`;

        const url = endpoint.replace(/\/+$/, '');
        const body = {
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            max_tokens: 150
        };

        const cachedIndex = configName 
            ? (workspaceState.get<number>(`activeKeyIndex_${configName}`) || 0)
            : 0;
        
        const keysCount = keys.length || 1;
        const startIndex = (cachedIndex >= 0 && cachedIndex < keysCount) ? cachedIndex : 0;

        let lastError: any = null;
        for (let attempt = 0; attempt < keysCount; attempt++) {
            if (token?.isCancellationRequested) {
                return '';
            }

            const currentIndex = (startIndex + attempt) % keysCount;
            const currentKey = keys[currentIndex];

            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            if (currentKey) {
                headers['Authorization'] = `Bearer ${currentKey}`;
            }

            let abortController: AbortController | undefined;
            let cancelListener: vscode.Disposable | undefined;
            if (token) {
                abortController = new AbortController();
                cancelListener = token.onCancellationRequested(() => {
                    abortController!.abort();
                });
            }

            try {
                const res = await axios.post(`${url}/chat/completions`, body, { 
                    headers, 
                    timeout: inlineCompletionTimeout,
                    signal: abortController?.signal
                });

                if (res.data && res.data.choices && res.data.choices.length > 0) {
                    if (configName && keys.length > 1) {
                        await workspaceState.update(`activeKeyIndex_${configName}`, currentIndex);
                    }
                    const content = res.data.choices[0].message.content || '';
                    let cleanContent = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
                    cleanContent = cleanContent.replace(/<thought>[\s\S]*$/gi, '');
                    cleanContent = cleanContent.replace(/^[\s\S]*?<\/thought>/gi, '');
                    return cleanContent.replace(/^```(?:\w+)?\n/, '').replace(/```$/, '').trimEnd();
                }
                throw new Error('LLM call returned empty suggestion.');
            } catch (err: any) {
                if (err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED')) {
                    return '';
                }
                lastError = err;
            } finally {
                if (cancelListener) {
                    cancelListener.dispose();
                }
            }
        }

        throw lastError || new Error('All API Keys failed for inline completion.');
    }

    public async fixDiagnostic(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, range: vscode.Range) {
        if (this._view) {
            this._view.show(true);
        } else {
            await vscode.commands.executeCommand('wind-agent.chatView.focus');
        }

        const relativePath = vscode.workspace.asRelativePath(document.uri);
        const startLine = range.start.line + 1;
        const errorCode = document.getText(range);
        const errorMessage = diagnostic.message;

        const messageText = `I want you to fix this error in file \`${relativePath}\` line ${startLine}:
Error: \`${errorMessage}\`
Faulty code block:
\`\`\`
${errorCode}
\`\`\``;

        setTimeout(() => {
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'requestDiagnosticFix',
                    text: messageText,
                    filePath: relativePath,
                    startLine: startLine,
                    endLine: range.end.line + 1,
                    errorMessage: errorMessage
                });
            }
        }, 500);
    }

    public clearChat() {
        if (this._view) {
            this._activeSessionId = undefined;
            if (this._agent) {
                this._agent.clearHistory();
            }
            this._sessionModifiedFiles.clear();
            this._sessionAcceptedFiles.clear();
            this._sendModifiedFiles();
            this._view.webview.postMessage({ type: 'clearChat' });
        }
    }

    public toggleHistory() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'toggleHistory' });
        }
    }

    public toggleSettings() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'toggleSettings' });
        }
    }

    private _cancelActiveExecution() {
        if (this._activeTestLoopAbortController) {
            this._activeTestLoopAbortController.abort();
            this._activeTestLoopAbortController = undefined;
        }
        if (this._activeSessionId) {
            const bgTask = this._backgroundTasks.get(this._activeSessionId);
            if (bgTask) {
                bgTask.agent.cancel();
                this._backgroundTasks.delete(this._activeSessionId);
                this._updateStatusBar();
            }
        }
        if (this._agent) {
            this._agent.cancel();
            this._agent = undefined;
        }
        for (const resolve of this._pendingToolResolves.values()) {
            resolve(false);
        }
        this._pendingToolResolves.clear();

        for (const state of this._streamingFiles.values()) {
            (async () => {
                try {
                    await state.queue.wait();
                    await this._discardSingleFile(state.relativePath);
                } catch (e) {
                    console.error('Failed to discard streaming file on cancel:', e);
                }
            })();
        }
        this._streamingFiles.clear();
    }

    private _resolvePendingTool(toolId: string, approved: boolean | string[]) {
        const resolve = this._pendingToolResolves.get(toolId);
        if (resolve) {
            resolve(approved);
            this._pendingToolResolves.delete(toolId);
        }
    }

    private async _handleUserMessage(text: string, selectedModel?: string, selectedMode?: string, configIndex?: number, images?: string[], contextItems?: any[]) {
        if (!this._view) return;

        // Get or create session
        const session = this._getOrCreateActiveSession(text);

        // Check for schedule slash command first
        if (text.startsWith('/schedule')) {
            const userMsg: any = {
                type: 'addMessage',
                sender: 'user',
                text: text,
                index: 0
            };
            if (images && images.length > 0) {
                userMsg.images = images;
            }
            if (contextItems && contextItems.length > 0) {
                userMsg.contextItems = contextItems;
            }
            const userIndex = this._appendToActiveSession(userMsg);
            userMsg.index = userIndex;
            this._view.webview.postMessage(userMsg);

            const responseText = await this._handleScheduleCommand(text);
            const agentMsg = {
                type: 'addMessage',
                sender: 'agent',
                text: responseText,
                index: 0
            };
            const agentIdx = this._appendToActiveSession(agentMsg);
            agentMsg.index = agentIdx;
            this._view?.webview.postMessage(agentMsg);
            return;
        }

        // Check for test-loop slash command
        if (text.startsWith('/test-loop')) {
            const sessionId = session.id;
            const userMsg: any = {
                type: 'addMessage',
                sender: 'user',
                text: text,
                index: 0
            };
            if (images && images.length > 0) {
                userMsg.images = images;
            }
            if (contextItems && contextItems.length > 0) {
                userMsg.contextItems = contextItems;
            }
            const userIndex = this._appendToSession(sessionId, userMsg);
            userMsg.index = userIndex;
            if (this._activeSessionId === sessionId) {
                this._view.webview.postMessage(userMsg);
            }

            if (this._activeSessionId === sessionId) {
                this._view.webview.postMessage({
                    type: 'setLoading',
                    isLoading: true,
                    title: 'Executing Test-Loop...',
                    description: 'Running tests and fixing code automatically on errors.'
                });
            }

            try {
                this._activeTestLoopAbortController = new AbortController();
                const responseText = await this._runAutoTestLoop(sessionId, text, selectedModel, configIndex, this._activeTestLoopAbortController.signal);
                const agentMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: responseText,
                    index: 0
                };
                const agentIdx = this._appendToSession(sessionId, agentMsg);
                agentMsg.index = agentIdx;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(agentMsg);
                }
            } catch (error: any) {
                const isCancel = error.message === 'Cancelled by user' || error.name === 'AbortError';
                const errorMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: isCancel ? '🛑 **Test-Loop stopped by user.**' : `❌ **Error in test loop execution:**\n${error.message}`,
                    index: 0
                };
                const errorIdx = this._appendToSession(sessionId, errorMsg);
                errorMsg.index = errorIdx;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(errorMsg);
                }
            } finally {
                this._activeTestLoopAbortController = undefined;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage({
                        type: 'setLoading',
                        isLoading: false
                    });
                }
            }
            return;
        }

        // Post user message to UI
        const userMsg: any = {
            type: 'addMessage',
            sender: 'user',
            text: text,
            index: 0
        };
        if (images && images.length > 0) {
            userMsg.images = images;
        }
        if (contextItems && contextItems.length > 0) {
            userMsg.contextItems = contextItems;
        }
        const userIndex = this._appendToActiveSession(userMsg);
        userMsg.index = userIndex;
        this._view.webview.postMessage(userMsg);

        // Parse modes for /goal and /grill-me
        let targetMode = selectedMode;
        let queryText = text;

        if (text.startsWith('/goal')) {
            targetMode = 'goal';
            queryText = text.substring(5).trim();
            if (!queryText) {
                queryText = "Execute goal autonomously.";
            }
        } else if (text.startsWith('/grill-me')) {
            targetMode = 'grill';
            queryText = text.substring(9).trim();
            if (!queryText) {
                queryText = "Conduct a requirement alignment interview.";
            }
        }

        // 2. Read configurations
        const { apiKey, endpoint, model, configName } = this._getAPIConfig(configIndex, selectedModel);

        // Get workspace path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            const errorMsg = {
                type: 'addMessage',
                sender: 'agent',
                text: 'Error: Please open a project folder (workspace) before using the Agent.',
                index: 0
            };
            const errorIdx = this._appendToActiveSession(errorMsg);
            errorMsg.index = errorIdx;
            this._view.webview.postMessage(errorMsg);
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const initialKeyIndex = configName 
            ? (this._context.workspaceState.get<number>(`activeKeyIndex_${configName}`) || 0)
            : 0;

        if (this._agent) {
            try {
                this._agent.cancel();
            } catch (err) {
                console.error('Failed to cancel existing active agent:', err);
            }
            this._agent = undefined;
        }

        this._activeConfigName = configName;

        // Use a new agent for this execution to support multitasking
        const runAgent = new Agent(
            apiKey,
            endpoint,
            model,
            workspaceRoot,
            this._getAgentCallbacks(session.id),
            initialKeyIndex
        );
        this._agent = runAgent; // Set as the active foreground agent

        // Pass the full model list from this provider for smart model fallback
        if (configIndex !== undefined && this._aiConfigs && this._aiConfigs[configIndex]) {
            const aiConfig = this._aiConfigs[configIndex];
            const providerModels: string[] = aiConfig.resolvedModels || 
                (Array.isArray(aiConfig.model) ? aiConfig.model : (aiConfig.model ? [aiConfig.model] : []));
            if (providerModels.length > 1) {
                runAgent.setModels(providerModels);
            }
        }

        const sendContext = this._context.workspaceState.get<boolean>('sendContext', true);
        const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);
        runAgent.fastAction = fastAction;

        if (sendContext) {
            if (session && session.agentHistory && session.agentHistory.length > 0) {
                runAgent.setHistory(session.agentHistory);
            }
        } else {
            runAgent.clearHistory();
        }

        // Show loading state
        this._view.webview.postMessage({
            type: 'setLoading',
            isLoading: true,
            title: 'Thinking...',
            description: targetMode === 'plan' ? 'Analyzing workspace and creating plan' : (targetMode === 'auto' ? 'Analyzing workspace and choosing approach' : (targetMode === 'goal' ? 'Executing long-running goal' : (targetMode === 'grill' ? 'Conducting alignment interview' : 'Analyzing workspace and executing steps')))
        });

        this._suppressStreaming = false;
        this._streamAsThought = (targetMode === 'agent' || targetMode === 'plan' || targetMode === 'auto' || targetMode === 'goal' || targetMode === 'grill');
        if (targetMode === 'plan') {
            this._currentThreadTitle = 'Analyzing Workspace & Drafting Plan';
        } else if (targetMode === 'agent') {
            this._currentThreadTitle = 'Analyzing Workspace & Coding';
        } else if (targetMode === 'auto') {
            this._currentThreadTitle = 'Analyzing Workspace';
        } else if (targetMode === 'goal') {
            this._currentThreadTitle = 'Executing Goal Autonomously';
        } else if (targetMode === 'grill') {
            this._currentThreadTitle = 'Requirements Alignment Interview';
        } else {
            this._currentThreadTitle = 'Thinking';
        }

        let agentPrompt = queryText;
        if (contextItems && contextItems.length > 0) {
            agentPrompt += "\n\nAttached Context:";
            for (const item of contextItems) {
                if (item.type === 'file') {
                    agentPrompt += `\n\nFile: ${item.filePath}`;
                    let fileContent = item.text;
                    if (!fileContent) {
                        try {
                            const fullPath = path.isAbsolute(item.filePath) ? item.filePath : path.join(workspaceRoot, item.filePath);
                            if (await this._fileExists(fullPath)) {
                                const stats = await fs.promises.stat(fullPath);
                                if (stats.isFile()) {
                                    fileContent = await fs.promises.readFile(fullPath, 'utf8');
                                }
                            }
                        } catch (err: any) {
                            console.error(`Failed to read file ${item.filePath}:`, err.message);
                        }
                    }
                    if (fileContent) {
                        agentPrompt += `\n\`\`\`${item.languageId || ''}\n${fileContent}\n\`\`\``;
                    }
                } else if (item.type === 'selection') {
                    agentPrompt += `\n\nFile Selection: ${item.filePath}:${item.startLine}-${item.endLine}`;
                    if (item.text) {
                        agentPrompt += `\n\`\`\`${item.languageId || ''}\n${item.text}\n\`\`\``;
                    }
                } else if (item.type === 'static') {
                    agentPrompt += `\n\nMention Directive: @${item.name}`;
                }
            }
        }

        (async () => {
            try {
                const finalResult = await runAgent.run(agentPrompt, targetMode as any, images);
                this._suppressStreaming = false;
                this._streamAsThought = false;

                const isPlanOutput = finalResult.includes('[PLAN_START]') && finalResult.includes('[PLAN_END]');
                const isPlanMode = (targetMode === 'plan') || (targetMode === 'auto' && isPlanOutput);

                let webviewResult = finalResult;
                const planTasks: string[] = [];
                if (isPlanMode) {
                    const planStartRegex = /\[PLAN_START\]/i;
                    const planEndRegex = /\[PLAN_END\]/i;
                    const planStartMatch = finalResult.match(planStartRegex);
                    const planEndMatch = finalResult.match(planEndRegex);
                    if (planStartMatch && planEndMatch && planStartMatch.index !== undefined && planEndMatch.index !== undefined) {
                        const planStartIdx = planStartMatch.index;
                        const planEndIdx = planEndMatch.index;
                        const planBlock = finalResult.substring(planStartIdx, planEndIdx + planEndMatch[0].length);
                        const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);
                        if (fastAction) {
                            webviewResult = `📝 *I have created the plan containing the tasks directly. Please review it in the editor. Once you are ready, click **Execute Plan** below.*\n\n${planBlock}`;
                        } else {
                            webviewResult = `📝 *I have created the implementation plan at \`implementation_plan.md\` in your workspace. Please review the plan in the editor. Once you are ready, click **Execute Plan** below.*\n\n${planBlock}`;
                        }
                        
                        const planContent = finalResult.substring(planStartIdx + planStartMatch[0].length, planEndIdx);
                        const lines = planContent.split('\n');
                        for (let line of lines) {
                            line = line.trim();
                            if (!line) continue;
                            let cleaned = line;
                            const checkboxMatch = cleaned.match(/^[-*+]\s*\[\s*[xX\s]?\s*\]\s*(.+)$/);
                            if (checkboxMatch) {
                                cleaned = checkboxMatch[1].trim();
                            } else {
                                const listMatch = cleaned.match(/^([-*+]|\d+[.)])\s*(.+)$/);
                                if (listMatch) {
                                      cleaned = listMatch[2].trim();
                                }
                            }
                            if (cleaned) {
                                planTasks.push(cleaned);
                            }
                        }
                    } else {
                        webviewResult = `📝 *I have created the implementation plan at \`implementation_plan.md\` in your workspace. Please review the plan in the editor.*`;
                    }
                }

                const agentMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: webviewResult,
                    index: 0
                };
                const agentIdx = this._appendToSession(session.id, agentMsg);
                agentMsg.index = agentIdx;
                if (this._activeSessionId === session.id) {
                    this._view?.webview.postMessage(agentMsg);
                }

                // Google Wind-like implementation plan file creation
                if (isPlanMode) {
                    try {
                        let planContent = finalResult;
                        const planStartRegex = /\[PLAN_START\]/i;
                        const planEndRegex = /\[PLAN_END\]/i;
                        const planStartMatch = planContent.match(planStartRegex);
                        const planEndMatch = planContent.match(planEndRegex);
                        if (planStartMatch && planEndMatch && planStartMatch.index !== undefined && planEndMatch.index !== undefined) {
                            const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);
                            if (fastAction) {
                                planContent = planContent.substring(planStartMatch.index + planStartMatch[0].length, planEndMatch.index).trim();
                            } else {
                                planContent = planContent.substring(0, planStartMatch.index) + planContent.substring(planEndMatch.index + planEndMatch[0].length);
                            }
                        }
                        planContent = planContent.replace(/\[PLAN_START\]/gi, '').replace(/\[PLAN_END\]/gi, '').trim();

                        const planFilePath = path.join(workspaceRoot, 'implementation_plan.md');
                        await fs.promises.writeFile(planFilePath, planContent, 'utf8');

                        // Automatically open the file in the editor
                        const doc = await vscode.workspace.openTextDocument(planFilePath);
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } catch (err: any) {
                        console.error('Failed to write implementation_plan.md:', err.message);
                    }

                    const autoExecutePlan = vscode.workspace.getConfiguration('windAgent').get<boolean>('autoExecutePlan') || false;
                    if (autoExecutePlan && planTasks.length > 0) {
                        setTimeout(() => {
                            this._executePlan(planTasks, selectedModel, configIndex);
                        }, 500);
                    }
                }

                // If running in background, show notification on finish
                if (this._backgroundTasks.has(session.id)) {
                    const notifyBtn = 'View';
                    vscode.window.showInformationMessage(`Wind has completed the task in session "${session.title}".`, notifyBtn).then(btn => {
                        if (btn === notifyBtn) {
                            vscode.commands.executeCommand('wind-agent.chatView.focus');
                            this._loadSession(session.id);
                        }
                    });
                }
            } catch (error: any) {
                const isCancel = error.message === 'Cancelled by user';
                const errorMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: isCancel ? '🛑 **Execution stopped by user.**' : `**Error running Agent:**\n${error.message}`,
                    index: 0
                };
                const errorIdx = this._appendToSession(session.id, errorMsg);
                errorMsg.index = errorIdx;
                if (this._activeSessionId === session.id) {
                    this._view?.webview.postMessage(errorMsg);
                }

                if (this._backgroundTasks.has(session.id) && !isCancel) {
                    vscode.window.showErrorMessage(`Wind task failed in session "${session.title}": ${error.message}`);
                }
            } finally {
                // Sync agent internal messages and save history immediately
                session.agentHistory = runAgent.getHistory();
                this._saveHistory();

                // If it's the active foreground task, clear active agent
                if (this._agent === runAgent) {
                    this._agent = undefined;
                }
                
                // Remove from background tasks map if it was there
                this._backgroundTasks.delete(session.id);
                this._updateStatusBar();

                if (this._activeSessionId === session.id) {
                    this._view?.webview.postMessage({
                        type: 'setLoading',
                        isLoading: false
                    });
                    this._sendModifiedFiles();
                }
            }
        })();
    }

    private _getConfigFileInfo() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const workspaceConfigPath = path.join(workspaceRoot, 'ai_config.json');
            if (fs.existsSync(workspaceConfigPath)) {
                return { configDir: workspaceRoot, configPath: workspaceConfigPath, isWorkspace: true };
            }
        }
        const homeDir = os.homedir();
        const configDir = path.join(homeDir, '.wind-agent');
        const oldConfigDir = path.join(homeDir, '.wind');
        if (fs.existsSync(oldConfigDir) && !fs.existsSync(configDir)) {
            try {
                fs.renameSync(oldConfigDir, configDir);
            } catch (e) {
                console.error('Failed to migrate config dir:', e);
            }
        }
        const configPath = path.join(configDir, 'ai_config.json');
        return { configDir, configPath, isWorkspace: false };
    }

    private async _loadAndSyncConfig() {
        const { configDir, configPath } = this._getConfigFileInfo();
        if (!fs.existsSync(configDir)) {
            try {
                await fs.promises.mkdir(configDir, { recursive: true });
            } catch (err: any) {
                console.error('Failed to create config directory:', err.message);
            }
        }
        if (!fs.existsSync(configPath)) {
            const defaultTemplate: any[] = [];
            try {
                await fs.promises.writeFile(configPath, JSON.stringify(defaultTemplate, null, 4), 'utf8');
            } catch (err: any) {
                console.error('Failed to create default ai_config.json:', err.message);
                this._aiConfigs = [];
                if (this._view) {
                    this._view.webview.postMessage({ type: 'updateModels', configs: [] });
                }
                return;
            }
        }

        try {
            const content = await fs.promises.readFile(configPath, 'utf8');
            const configs = JSON.parse(content);
            if (!Array.isArray(configs)) {
                throw new Error("ai_config.json must be an array of configurations");
            }

            // Map configurations initially in a non-blocking way
            const resolvedConfigs = configs.map((cfg: any) => {
                let resolvedModels: string[] = [];
                if (cfg.model === 'Autodetect') {
                    resolvedModels = ['Autodetect (Loading...)'];
                } else if (Array.isArray(cfg.model)) {
                    resolvedModels = cfg.model;
                } else if (typeof cfg.model === 'string') {
                    resolvedModels = [cfg.model];
                }

                return {
                    ...cfg,
                    resolvedModels
                };
            });

            this._aiConfigs = resolvedConfigs;

            const sendUpdate = () => {
                if (this._view) {
                    const webviewConfigs = this._aiConfigs.map(cfg => ({
                        name: cfg.name,
                        models: cfg.resolvedModels,
                        provider: cfg.provider,
                        apiKey: cfg.apiKey,
                        apiBase: cfg.apiBase,
                        rawModel: cfg.model
                    }));
                    const savedModel = this._context.workspaceState.get<string>('selectedModel');
                    const savedConfigIndex = this._context.workspaceState.get<number>('selectedModelConfigIndex');
                    const savedMode = this._context.workspaceState.get<string>('selectedMode');
                    const savedSendContext = this._context.workspaceState.get<boolean>('sendContext', true);
                    const savedFastAction = this._context.workspaceState.get<boolean>('fastAction', false);

                    this._view.webview.postMessage({
                        type: 'updateModels',
                        configs: webviewConfigs,
                        savedModel,
                        savedConfigIndex,
                        savedMode,
                        savedSendContext,
                        savedFastAction
                    });
                }
            };

            // Send initial models configuration to webview immediately (fast and non-blocking)
            sendUpdate();

            // Run autodetection asynchronously in the background for configs requesting it
            configs.forEach(async (cfg: any) => {
                if (cfg.model === 'Autodetect') {
                    try {
                        const models = await this._fetchModelsFromServer(cfg);
                        const currentCfg = this._aiConfigs.find(c => c.name === cfg.name && c.apiBase === cfg.apiBase);
                        if (currentCfg) {
                            currentCfg.resolvedModels = models;
                        }
                    } catch (err: any) {
                        console.error(`Error autodetecting models for ${cfg.name}:`, err.message);
                        const currentCfg = this._aiConfigs.find(c => c.name === cfg.name && c.apiBase === cfg.apiBase);
                        if (currentCfg) {
                            currentCfg.resolvedModels = ['Autodetect (Error loading)'];
                        }
                    }
                    sendUpdate();
                }
            });

        } catch (e: any) {
            console.error('Failed to load ai_config.json:', e);
            vscode.window.showErrorMessage(`Failed to load ai_config.json: ${e.message}`);
        }
    }

    private async _fetchModelsFromServer(cfg: any): Promise<string[]> {
        const apiBase = (cfg.apiBase || '').replace(/\/+$/, '');
        const apiKeys: string[] = Array.isArray(cfg.apiKey) 
            ? cfg.apiKey 
            : (cfg.apiKey ? [cfg.apiKey] : ['']);
        
        let lastError: any = null;
        for (const apiKey of apiKeys) {
            if (cfg.provider === 'gemini' && !apiKey) {
                continue;
            }
            try {
                if (cfg.provider === 'gemini') {
                    const url = `${apiBase}/v1beta/models?key=${apiKey}`;
                    const response = await axios.get(url, { timeout: 5000 });
                    if (response.data && Array.isArray(response.data.models)) {
                        return response.data.models.map((m: any) => {
                            const name = m.name || '';
                            return name.startsWith('models/') ? name.substring(7) : name;
                        });
                    }
                    throw new Error('Invalid Gemini models response format');
                } else {
                    const url = `${apiBase}/models`;
                    const headers: any = {};
                    if (apiKey) {
                        headers['Authorization'] = `Bearer ${apiKey}`;
                    }
                    const response = await axios.get(url, { headers, timeout: 5000 });
                    if (response.data && Array.isArray(response.data.data)) {
                        return response.data.data.map((m: any) => m.id);
                    }
                    throw new Error('Invalid OpenAI models response format');
                }
            } catch (err: any) {
                lastError = err;
            }
        }
        throw lastError || new Error('No API key worked for autodetecting models');
    }

    public async openConfigFile() {
        const { configPath } = this._getConfigFileInfo();
        
        if (!fs.existsSync(configPath)) {
            await this._loadAndSyncConfig();
        }

        try {
            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Cannot open configuration file: ${err.message}`);
        }
    }

    public async openMcpConfigFile() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let mcpPath: string;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const wsPath = path.join(workspaceRoot, '.vscode', 'mcp_config.json');
            const rootPath = path.join(workspaceRoot, 'mcp_config.json');
            if (fs.existsSync(wsPath)) {
                mcpPath = wsPath;
            } else if (fs.existsSync(rootPath)) {
                mcpPath = rootPath;
            } else {
                try {
                    await fs.promises.mkdir(path.dirname(wsPath), { recursive: true });
                    if (!fs.existsSync(wsPath)) {
                        await fs.promises.writeFile(wsPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
                    }
                    mcpPath = wsPath;
                } catch (e) {
                    mcpPath = rootPath;
                }
            }
        } else {
            mcpPath = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp_config.json');
            try {
                await fs.promises.mkdir(path.dirname(mcpPath), { recursive: true });
                if (!fs.existsSync(mcpPath)) {
                    await fs.promises.writeFile(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
                }
            } catch (e) {
                // Ignore
            }
        }

        try {
            const doc = await vscode.workspace.openTextDocument(mcpPath);
            await vscode.window.showTextDocument(doc);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Cannot open MCP configuration file: ${err.message}`);
        }
    }

    private _getOrCreateActiveSession(firstMessageText: string): ChatSession {
        const titleText = typeof firstMessageText === 'string' ? firstMessageText : '';
        const title = titleText.substring(0, 30) + (titleText.length > 30 ? '...' : '') || 'New Chat';

        if (!this._activeSessionId) {
            const newSession: ChatSession = {
                id: Date.now().toString(),
                title: title,
                timestamp: Date.now(),
                messages: [],
                agentHistory: []
            };
            this._sessions.unshift(newSession);
            this._activeSessionId = newSession.id;
            this._saveHistory();
            this._sendHistoryToWebview();
            return newSession;
        }
        
        const session = this._sessions.find(s => s.id === this._activeSessionId);
        if (!session) {
            const newSession: ChatSession = {
                id: Date.now().toString(),
                title: title,
                timestamp: Date.now(),
                messages: [],
                agentHistory: []
            };
            this._sessions.unshift(newSession);
            this._activeSessionId = newSession.id;
            this._saveHistory();
            this._sendHistoryToWebview();
            return newSession;
        }
        return session;
    }

    private _appendToSession(sessionId: string, msg: any): number {
        const session = this._sessions.find(s => s.id === sessionId);
        if (session) {
            session.messages.push(msg);
            this._saveHistoryDebounced();
            return session.messages.length - 1;
        }
        return -1;
    }

    private _appendToActiveSession(msg: any): number {
        return this._appendToSession(this._activeSessionId || '', msg);
    }

    private _saveHistoryDebounceTimer?: NodeJS.Timeout;

    private _safeSliceHistory(history: any[], maxCount: number): any[] {
        if (!history || history.length <= maxCount) return history || [];
        const systemPrompt = history[0];
        
        let sliceStart = history.length - (maxCount - 1);
        if (sliceStart <= 1) {
            return history;
        }

        // Search backwards for the nearest 'user' message to start the history slice
        while (sliceStart > 1 && history[sliceStart]?.role !== 'user') {
            sliceStart--;
        }

        if (sliceStart <= 1) {
            sliceStart = 1;
        }

        return [systemPrompt, ...history.slice(sliceStart)];
    }

    private _saveHistory() {
        // Enforce session limits to prevent workspaceState overflow (~10MB limit)
        const MAX_SESSIONS = 20;
        if (this._sessions.length > MAX_SESSIONS) {
            this._sessions = this._sessions.slice(0, MAX_SESSIONS);
        }
        // Trim large agentHistory per session to bound memory
        for (const session of this._sessions) {
            // Limit UI messages history to keep workspaceState size compact
            if (session.messages && session.messages.length > 50) {
                session.messages = session.messages.slice(-50);
            }

            // Keep UI images only for the last 3 messages
            if (session.messages) {
                const keepImagesStartIndex = Math.max(0, session.messages.length - 3);
                for (let i = 0; i < session.messages.length; i++) {
                    const msg = session.messages[i];
                    if (msg && Array.isArray(msg.images)) {
                        if (i < keepImagesStartIndex) {
                            msg.images = msg.images.map((img: string) => {
                                if (typeof img === 'string' && img.startsWith('data:') && img.includes('base64,')) {
                                    return 'data:image/png;base64,Placeholder_Image_Data_Removed_To_Save_Space';
                                }
                                return img;
                            });
                        }
                    }
                }
            }

            if (session.agentHistory && session.agentHistory.length > 60) {
                session.agentHistory = this._safeSliceHistory(session.agentHistory, 60);
            }

            // Truncate large tool result content and strip old base64 images in agentHistory
            if (session.agentHistory) {
                const userMessages = session.agentHistory.filter(msg => msg.role === 'user');
                const keepUserImagesStartIndex = Math.max(0, userMessages.length - 3);
                let userMsgCount = 0;

                for (const msg of session.agentHistory) {
                    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 2000) {
                        msg.content = msg.content.substring(0, 2000) + '\n...[truncated for storage]';
                    } else if (msg.role === 'user') {
                        if (Array.isArray(msg.content)) {
                            if (userMsgCount < keepUserImagesStartIndex) {
                                msg.content = msg.content.map((part: any) => {
                                    if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
                                        if (part.image_url.url.startsWith('data:') && part.image_url.url.includes('base64,')) {
                                            part.image_url.url = 'data:image/png;base64,Placeholder_Image_Data_Removed_To_Save_Space';
                                        }
                                    }
                                    return part;
                                });
                            }
                        }
                        userMsgCount++;
                    }
                }
            }
        }
        this._context.workspaceState.update('chatHistory', this._sessions);
    }

    private _saveHistoryDebounced() {
        if (this._saveHistoryDebounceTimer) {
            clearTimeout(this._saveHistoryDebounceTimer);
        }
        this._saveHistoryDebounceTimer = setTimeout(() => {
            this._saveHistory();
        }, 2000);
    }

    private _sendHistoryToWebview() {
        if (!this._view) return;
        const historyList = this._sessions.map(s => ({
            id: s.id,
            title: s.title,
            timestamp: s.timestamp
        }));
        this._view.webview.postMessage({
            type: 'historyList',
            history: historyList
        });
    }

    private async _loadSession(sessionId: string) {
        if (!this._view) return;
        const session = this._sessions.find(s => s.id === sessionId);
        if (!session) return;

        this._activeSessionId = session.id;

        // Sync modified files list from physical backup directory
        await this._syncModifiedFilesFromBackup();

        // Restore task statuses from task.md if it exists in workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const taskStatuses: string[] = [];
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const taskMdPath = path.join(workspaceRoot, 'task.md');
            try {
                const stat = await fs.promises.stat(taskMdPath).catch(() => null);
                if (stat && stat.isFile()) {
                    const content = await fs.promises.readFile(taskMdPath, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const match = line.match(/^-\s*\[([\sxX/]?)\]/);
                        if (match) {
                            taskStatuses.push(match[1] || ' ');
                        }
                    }
                }
            } catch (e) {
                console.error('Failed to read task.md for restoring session:', e);
            }
        }

        // Restore messages in UI
        this._view.webview.postMessage({
            type: 'restoreSession',
            messages: session.messages,
            taskStatuses: taskStatuses
        });

        // Restore loading state if this session is running in the background
        const bgTask = this._backgroundTasks.get(session.id);
        if (bgTask) {
            this._view.webview.postMessage({
                type: 'setLoading',
                isLoading: true,
                title: bgTask.isWaitingApproval ? 'Waiting for Approval...' : 'Running in Background...',
                description: bgTask.isWaitingApproval ? 'A tool is waiting for your approval.' : 'Agent is executing task in the background.'
            });
        }

        // Instantiate Agent if needed to sync the state
        const config = vscode.workspace.getConfiguration('windAgent');
        const apiKey = config.get<string>('apiKey') || '';
        const endpoint = config.get<string>('apiEndpoint') || 'https://generativelanguage.googleapis.com/v1beta/openai';
        const model = config.get<string>('model') || 'gemini-2.5-flash';
        

        if (!workspaceFolders || workspaceFolders.length === 0) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;


        if (!this._agent) {
            this._agent = new Agent(
                apiKey,
                endpoint,
                model,
                workspaceRoot,
                this._getAgentCallbacks(session.id)
            );
        }
        const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);
        this._agent.fastAction = fastAction;

        if (session.agentHistory && session.agentHistory.length > 0) {
            this._agent.setHistory(session.agentHistory);
        }
    }

    private _deleteSession(sessionId: string) {
        this._sessions = this._sessions.filter(s => s.id !== sessionId);
        if (this._activeSessionId === sessionId) {
            this._activeSessionId = undefined;
            if (this._agent) {
                this._agent.clearHistory();
            }
            this._view?.webview.postMessage({ type: 'clearChat' });
            
            // Clean up modified files lists
            this._sessionModifiedFiles.clear();
            this._sessionAcceptedFiles.clear();
            this._sendModifiedFiles();
        }
        this._saveHistory();
        this._sendHistoryToWebview();
    }

    private async _executePlan(tasks: string[], selectedModel?: string, configIndex?: number, startIndex: number = 0) {
        const sessionId = this._activeSessionId;
        if (!sessionId) return;
        const session = this._sessions.find(s => s.id === sessionId);
        if (!session) return;

        // Get workspace path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
        if (!workspaceRoot) return;

        // Helper to update task.md in the workspace root
        const updateTaskFile = async (statuses: string[]) => {
            try {
                const lines = [
                    '# Tasks',
                    '',
                    ...tasks.map((task, idx) => {
                        const status = statuses[idx] || ' ';
                        return `- [${status}] ${task}`;
                    })
                ];
                await this._writeWorkspaceFile(path.join(workspaceRoot, 'task.md'), lines.join('\n'));
            } catch (err: any) {
                console.error('Failed to update task.md:', err.message);
            }
        };

        const taskStatuses: string[] = tasks.map((_, idx) => idx < startIndex ? 'x' : ' ');
        await updateTaskFile(taskStatuses);

        // Update agent config to match selected model and configIndex
        const { apiKey, endpoint, model, configName } = this._getAPIConfig(configIndex, selectedModel);

        const initialKeyIndex = configName 
            ? (this._context.workspaceState.get<number>(`activeKeyIndex_${configName}`) || 0)
            : 0;

        const sendContext = this._context.workspaceState.get<boolean>('sendContext', true);
        const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);

        if (this._agent) {
            try {
                this._agent.cancel();
            } catch (err) {
                console.error('Failed to cancel existing active agent:', err);
            }
            this._agent = undefined;
        }

        this._activeConfigName = configName;

        // Use a new agent for this execution
        const runAgent = new Agent(
            apiKey,
            endpoint,
            model,
            workspaceRoot,
            this._getAgentCallbacks(sessionId),
            initialKeyIndex
        );
        runAgent.fastAction = fastAction;
        this._agent = runAgent;

        // Pass the full model list from this provider for smart model fallback
        if (configIndex !== undefined && this._aiConfigs && this._aiConfigs[configIndex]) {
            const aiCfg = this._aiConfigs[configIndex];
            const providerModels: string[] = aiCfg.resolvedModels || 
                (Array.isArray(aiCfg.model) ? aiCfg.model : (aiCfg.model ? [aiCfg.model] : []));
            if (providerModels.length > 1) {
                runAgent.setModels(providerModels);
            }
        }

        this._view?.webview.postMessage({
            type: 'setLoading',
            isLoading: true,
            title: 'Executing Plan...',
            description: 'Agent is executing plan steps autonomously.'
        });

        this._view?.webview.postMessage({
            type: 'planExecutionStarted',
            startIndex: startIndex
        });

        (async () => {
            try {
                for (let i = startIndex; i < tasks.length; i++) {
                    if (runAgent.isCancelled) {
                        throw new Error('Cancelled by user');
                    }
                    const task = tasks[i];
                    // Notify webview which step is starting
                    if (this._activeSessionId === sessionId) {
                        this._view?.webview.postMessage({
                            type: 'planStepStart',
                            index: i
                        });
                    }

                    taskStatuses[i] = '/';
                    await updateTaskFile(taskStatuses);

                    // Run agent for this specific task
                    const planExecPrompt = `[PLAN EXECUTION STEP ${i + 1}/${tasks.length}]
Task to perform: "${task}"

Context:
You are executing a step of the implementation plan defined in 'implementation_plan.md'.
The current overall tasks are listed and tracked in 'task.md'.
Please read 'implementation_plan.md' and 'task.md' using tools if you need to understand the full context of this step or review what has been done.
Verify that you have fully completed the requested task step before proceeding.`;
                    
                    let result = '';
                    try {
                        this._currentThreadTitle = `Executing Step ${i + 1}/${tasks.length}: ${task}`;
                        this._streamAsThought = true;
                        if (!sendContext) {
                            runAgent.clearHistory();
                        }
                        result = await runAgent.run(planExecPrompt, 'agent');
                    } catch (err) {
                        if (this._activeSessionId === sessionId) {
                            this._view?.webview.postMessage({
                                type: 'planStepFail',
                                index: i
                            });
                        }
                        throw err;
                    } finally {
                        this._streamAsThought = false;
                    }

                    // Notify webview that step completed
                    if (this._activeSessionId === sessionId) {
                        this._view?.webview.postMessage({
                            type: 'planStepComplete',
                            index: i,
                            result: result
                        });
                    }

                    taskStatuses[i] = 'x';
                    await updateTaskFile(taskStatuses);
                }

                // History will be synced and saved in the finally block

                // Add success message
                const finalMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: '🎉 **All steps in the plan have been executed successfully!**'
                };
                this._appendToSession(sessionId, finalMsg);
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(finalMsg);
                }

                // Google Wind-like walkthrough file creation
                let walkthroughText = '';
                try {
                    const walkthroughPrompt = `Please write a concise walkthrough of the changes that were just implemented in the workspace.
Your response MUST follow this exact structure:

# Walkthrough
Provide a brief summary of the completed work.

- **Changes made**: Bullet points of files created, modified, or deleted.
- **What was tested**: Descriptions of what features were tested.
- **Validation results**: Results of running builds, compiles, or manual checks.

Keep it structured, clear, and professional. Do NOT run any tools or include any external text.`;
                    this._currentThreadTitle = 'Generating Walkthrough';
                    this._suppressStreaming = false;
                    this._streamAsThought = false;
                    walkthroughText = await runAgent.run(walkthroughPrompt, 'chat');
                } catch (err) {
                    walkthroughText = '# Walkthrough\n\nAll tasks in the plan have been executed successfully!';
                } finally {
                    this._suppressStreaming = false;
                    this._streamAsThought = false;
                }

                const walkthroughMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: walkthroughText,
                    index: 0
                };
                this._appendToSession(sessionId, walkthroughMsg);
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(walkthroughMsg);
                }

                try {
                    const walkthroughPath = path.join(workspaceRoot, 'walkthrough.md');
                    await this._writeWorkspaceFile(walkthroughPath, walkthroughText);

                    // Open the walkthrough file in the editor
                    const doc = await vscode.workspace.openTextDocument(walkthroughPath);
                    await vscode.window.showTextDocument(doc, { preview: true });
                    
                    const walkMsg = {
                        type: 'addMessage',
                        sender: 'agent',
                        text: `📝 *I have created the walkthrough at \`walkthrough.md\` in your workspace. Please review it in the editor.*`
                    };
                    this._appendToSession(sessionId, walkMsg);
                    if (this._activeSessionId === sessionId) {
                        this._view?.webview.postMessage(walkMsg);
                    }
                } catch (err: any) {
                    console.error('Failed to write walkthrough.md:', err.message);
                }

                // If running in background, show notification on finish
                if (this._backgroundTasks.has(sessionId)) {
                    const notifyBtn = 'View';
                    vscode.window.showInformationMessage(`Wind has completed execution of the plan in session "${session.title}".`, notifyBtn).then(btn => {
                        if (btn === notifyBtn) {
                            vscode.commands.executeCommand('wind-agent.chatView.focus');
                            this._loadSession(sessionId);
                        }
                    });
                }

            } catch (error: any) {
                const isCancel = error.message === 'Cancelled by user';
                const failMsg = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: isCancel ? '🛑 **Plan execution stopped by user.**' : `❌ **Plan execution halted due to error:**\n${error.message}`
                };
                this._appendToSession(sessionId, failMsg);
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(failMsg);
                }

                if (this._backgroundTasks.has(sessionId) && !isCancel) {
                    vscode.window.showErrorMessage(`Wind Plan execution failed in session "${session.title}": ${error.message}`);
                }
            } finally {
                // Sync agent internal messages and save history immediately
                session.agentHistory = runAgent.getHistory();
                this._saveHistory();

                if (this._agent === runAgent) {
                    this._agent = undefined;
                }
                
                this._backgroundTasks.delete(sessionId);
                this._updateStatusBar();

                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage({
                        type: 'setLoading',
                        isLoading: false
                    });
                    this._sendModifiedFiles();
                }
            }
        })();
    }

    private async _handleEditMessage(index: number, newText: string, selectedModel?: string, selectedMode?: string, configIndex?: number) {
        if (!this._view) return;

        const session = this._sessions.find(s => s.id === this._activeSessionId);
        if (!session) return;

        const originalMsg = session.messages[index];
        const contextItems = originalMsg ? originalMsg.contextItems : undefined;
        const images = originalMsg ? originalMsg.images : undefined;

        // Count user messages in session up to index
        let userMessageCount = 0;
        for (let i = 0; i <= index; i++) {
            const msg = session.messages[i];
            if (msg && msg.type === 'addMessage' && msg.sender === 'user') {
                userMessageCount++;
            }
        }

        // Truncate agentHistory right before the userMessageCount-th user message
        if (session.agentHistory) {
            let agentUserCount = 0;
            let truncateAgentIndex = -1;
            for (let i = 0; i < session.agentHistory.length; i++) {
                if (session.agentHistory[i].role === 'user') {
                    agentUserCount++;
                    if (agentUserCount === userMessageCount) {
                        truncateAgentIndex = i;
                        break;
                    }
                }
            }
            if (truncateAgentIndex !== -1) {
                session.agentHistory = session.agentHistory.slice(0, truncateAgentIndex);
            }
        }

        // Truncate session.messages to index (exclusive)
        session.messages = session.messages.slice(0, index);
        this._saveHistory();

        // Notify webview to restore the truncated session
        this._view.webview.postMessage({
            type: 'restoreSession',
            messages: session.messages
        });

        // Trigger handle new user message
        await this._handleUserMessage(newText, selectedModel, selectedMode, configIndex, images, contextItems);
    }

    private _sendPermissionsToWebview() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'permissionsList',
                permissions: Array.from(this._grantedPermissions)
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this._context.extensionUri.fsPath, 'media', 'webview.css'))
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this._context.extensionUri.fsPath, 'media', 'webview.js'))
        );
        const htmlPath = path.join(this._context.extensionUri.fsPath, 'media', 'webview.html');

        let html = fs.readFileSync(htmlPath, 'utf8');
        html = html.replace('${styleUri}', styleUri.toString());
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace(/\${cspSource}/g, webview.cspSource);

        return html;
    }

    private async _discardSingleFile(relativePath: string): Promise<void> {
        let safeRelative: string;
        try {
            safeRelative = this._getSafeRelativePath(relativePath);
        } catch (err) {
            console.error(err);
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const workspaceHash = this._getWorkspaceHash();
            const backupDir = path.join(os.tmpdir(), 'wind-backups', workspaceHash);
            const metadataPath = path.join(backupDir, 'metadata.json');

            let metadata: { newFiles: string[] } = { newFiles: [] };
            try {
                if (await this._fileExists(metadataPath)) {
                    const metaStr = await fs.promises.readFile(metadataPath, 'utf8');
                    const parsed = JSON.parse(metaStr);
                    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.newFiles)) {
                        metadata = parsed;
                    }
                }
            } catch { /* ignore */ }

            try {
                const workspacePath = path.join(workspaceRoot, safeRelative);
                const backupPath = path.join(backupDir, safeRelative);

                // Revert open editor dirty buffers first to prevent overwrite on save/autosave
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === workspacePath);
                if (doc) {
                    let backupContent = '';
                    if (!metadata.newFiles.includes(safeRelative) && await this._fileExists(backupPath)) {
                        backupContent = await fs.promises.readFile(backupPath, 'utf8');
                    }
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(doc.getText().length)
                    );
                    edit.replace(doc.uri, fullRange, backupContent);
                    await vscode.workspace.applyEdit(edit);
                    await doc.save();
                }

                if (metadata.newFiles.includes(safeRelative)) {
                    if (await this._fileExists(workspacePath)) {
                        await fs.promises.unlink(workspacePath);
                    }
                } else if (await this._fileExists(backupPath)) {
                    await fs.promises.copyFile(backupPath, workspacePath);
                }

                // Clean up the backup file
                if (await this._fileExists(backupPath)) {
                    await fs.promises.unlink(backupPath);
                    // Clean up empty directories in backup recursively, up to backupDir
                    let dir = path.dirname(backupPath);
                    while (dir !== backupDir && dir.startsWith(backupDir)) {
                        if (await this._fileExists(dir) && (await fs.promises.readdir(dir)).length === 0) {
                            await fs.promises.rmdir(dir);
                            dir = path.dirname(dir);
                        } else {
                            break;
                        }
                    }
                }

                // Update metadata.json's newFiles list
                if (metadata.newFiles.includes(safeRelative)) {
                    metadata.newFiles = metadata.newFiles.filter((f: string) => f !== safeRelative);
                    if (await this._fileExists(metadataPath)) {
                        await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Revert failed for ${safeRelative}: ${e.message}`);
            }

            this._sessionModifiedFiles.delete(safeRelative);
            this._sessionAcceptedFiles.delete(safeRelative);

            if (this._sessionModifiedFiles.size === 0) {
                try {
                    if (await this._fileExists(backupDir)) {
                        await fs.promises.rm(backupDir, { recursive: true, force: true });
                    }
                } catch (e) {
                    console.error('Failed to clean up backup directory:', e);
                }
            }
        }
        await this._sendModifiedFiles();
    }

    private async _syncModifiedFilesFromBackup() {
        this._sessionModifiedFiles.clear();
        this._sessionAcceptedFiles.clear();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceHash = this._getWorkspaceHash();
            const backupDir = path.join(os.tmpdir(), 'wind-backups', workspaceHash);
            try {
                if (fs.existsSync(backupDir)) {
                    const walkBackups = async (dir: string) => {
                        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                await walkBackups(fullPath);
                            } else if (entry.isFile() && entry.name !== 'metadata.json') {
                                const relPath = path.relative(backupDir, fullPath).replace(/\\/g, '/');
                                this._sessionModifiedFiles.add(relPath);
                            }
                        }
                    };
                    await walkBackups(backupDir);
                }
            } catch (e) {
                console.error('Failed to sync modified files from backup:', e);
            }
        }
        await this._sendModifiedFiles();
    }

    private _getWorkspaceHash(): string {
        if (this._cachedWorkspaceHash) return this._cachedWorkspaceHash;
        const workspaceRoot = this.workspaceRootPath;
        if (!workspaceRoot) return '';
        this._cachedWorkspaceHash = crypto.createHash('md5').update(workspaceRoot).digest('hex');
        return this._cachedWorkspaceHash;
    }

    private _sendModifiedFilesDebounced() {
        if (this._sendModifiedFilesTimer) {
            clearTimeout(this._sendModifiedFilesTimer);
        }
        this._sendModifiedFilesTimer = setTimeout(() => {
            this._sendModifiedFiles();
        }, 500);
    }

    private async _sendModifiedFiles() {
        if (!this._view) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this._view.webview.postMessage({ type: 'modifiedFiles', files: [] });
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const workspaceHash = this._getWorkspaceHash();
        const backupDir = path.join(os.tmpdir(), 'wind-backups', workspaceHash);

        // Map relative paths to operations in parallel
        const filePromises = Array.from(this._sessionModifiedFiles).map(async (relativePath) => {
            const workspacePath = path.join(workspaceRoot, relativePath);
            const backupPath = path.join(backupDir, relativePath);

            let additions = 0;
            let deletions = 0;
            let status: 'modified' | 'added' | 'deleted' = 'modified';

            const workspaceExists = await this._fileExists(workspacePath);
            const backupExists = await this._fileExists(backupPath);

            // Determine if the file is binary based on extension to skip text-based diff operations
            const ext = path.extname(relativePath).toLowerCase();
            const isBinary = BINARY_EXTENSIONS.has(ext);

            if (isBinary) {
                if (!workspaceExists && backupExists) status = 'deleted';
                else if (workspaceExists && !backupExists) status = 'added';
                else status = 'modified';

                return {
                    path: relativePath,
                    additions: 0,
                    deletions: 0,
                    status,
                    accepted: false
                };
            }

            // Safety check: Skip diff line calculation for very large files (>1MB) to prevent OOM
            let isTooLarge = false;
            try {
                if (workspaceExists) {
                    const workspaceStats = await fs.promises.stat(workspacePath);
                    if (workspaceStats.size > 1024 * 1024) isTooLarge = true;
                }
                if (backupExists) {
                    const backupStats = await fs.promises.stat(backupPath);
                    if (backupStats.size > 1024 * 1024) isTooLarge = true;
                }
            } catch { /* ignore */ }

            if (isTooLarge) {
                if (!workspaceExists && backupExists) status = 'deleted';
                else if (workspaceExists && !backupExists) status = 'added';
                else status = 'modified';

                return {
                    path: relativePath,
                    additions: 0,
                    deletions: 0,
                    status,
                    accepted: false
                };
            }

            let backupIsEmpty = false;
            if (backupExists) {
                try {
                    const backupContent = await fs.promises.readFile(backupPath, 'utf8');
                    if (backupContent.trim() === '') {
                        backupIsEmpty = true;
                    }
                } catch (_e) {
                    backupIsEmpty = true;
                }
            }

            if (!workspaceExists && backupExists) {
                status = 'deleted';
                try {
                    const content = await fs.promises.readFile(backupPath, 'utf8');
                    deletions = content.split('\n').length;
                } catch (e) {
                    deletions = 1;
                }
            } else if (workspaceExists && (!backupExists || backupIsEmpty)) {
                status = 'added';
                try {
                    const content = await fs.promises.readFile(workspacePath, 'utf8');
                    additions = content.split('\n').length;
                } catch (e) {
                    additions = 1;
                }
            } else if (workspaceExists && backupExists) {
                status = 'modified';
                try {
                    // Frequency-map based diff for accurate line counting (handles duplicate lines)
                    const oldContent = await fs.promises.readFile(backupPath, 'utf8');
                    const newContent = await fs.promises.readFile(workspacePath, 'utf8');
                    const oldLines = oldContent.split('\n');
                    const newLines = newContent.split('\n');
                    
                    const oldFreq = new Map<string, number>();
                    for (const l of oldLines) {
                        oldFreq.set(l, (oldFreq.get(l) || 0) + 1);
                    }
                    const newFreq = new Map<string, number>();
                    for (const l of newLines) {
                        newFreq.set(l, (newFreq.get(l) || 0) + 1);
                    }
                    
                    additions = 0;
                    for (const [line, count] of newFreq) {
                        const oldCount = oldFreq.get(line) || 0;
                        if (count > oldCount) {
                            additions += count - oldCount;
                        }
                    }
                    deletions = 0;
                    for (const [line, count] of oldFreq) {
                        const newCount = newFreq.get(line) || 0;
                        if (count > newCount) {
                            deletions += count - newCount;
                        }
                    }
                } catch (e) {
                    additions = 0;
                    deletions = 0;
                }
            }

            return {
                path: relativePath,
                additions,
                deletions,
                status,
                accepted: false
            };
        });

        const filesList = await Promise.all(filePromises);

        for (const relativePath of this._sessionAcceptedFiles) {
            filesList.push({
                path: relativePath,
                additions: 0,
                deletions: 0,
                status: 'modified',
                accepted: true
            });
        }

        this._view?.webview.postMessage({ type: 'modifiedFiles', files: filesList });
    }

    private _getAgentCallbacks(sessionId: string) {
        return {
            onKeySuccess: (keyIndex: number) => {
                if (this._activeConfigName) {
                    this._context.workspaceState.update(`activeKeyIndex_${this._activeConfigName}`, keyIndex);
                }
            },
            onModelSwitch: (model: string, keyIndex: number) => {
                // Persist the updated key index so next run starts from the working key
                if (this._activeConfigName) {
                    this._context.workspaceState.update(`activeKeyIndex_${this._activeConfigName}`, keyIndex);
                }
                // Notify the UI that a model switch happened
                if (this._activeSessionId === sessionId && this._view) {
                    this._view.webview.postMessage({
                        type: 'modelSwitched',
                        model
                    });
                }
            },
            onLog: (logText: string) => {
                const msg: any = {
                    type: 'addMessage',
                    sender: 'agent',
                    text: logText,
                    index: 0
                };
                if (logText.startsWith('[Thought]')) {
                    msg.title = this._currentThreadTitle;
                }
                const idx = this._appendToSession(sessionId, msg);
                msg.index = idx;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(msg);
                }
            },
            onStreamChunk: (chunkText: string) => {
                if (this._suppressStreaming) return;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage({
                        type: this._streamAsThought ? 'streamThought' : 'streamChunk',
                        text: chunkText,
                        title: this._currentThreadTitle
                    });
                }
            },
            onStreamThought: (chunkText: string) => {
                if (this._suppressStreaming) return;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage({
                        type: 'streamThought',
                        text: chunkText,
                        title: this._currentThreadTitle
                    });
                }
            },
            onMessageTextUpdated: (text: string) => {
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage({
                        type: 'updateStreamingText',
                        text
                    });
                }
            },
            onToolCall: async (toolId: string, name: string, args: any, requiresApproval: boolean) => {
                this._pendingToolArgs.set(toolId, args);

                // Determine the scope of this tool call
                let requiredScope = '';
                if (name === 'runCommand' || name === 'runTerminalCommand') {
                    const cmd = (args.command || '').trim();
                    const firstWord = cmd.split(/\s+/)[0] || '';
                    requiredScope = `command:${firstWord}`;
                } else if (name === 'writeFile' || name === 'replaceFileContent' || name === 'multiReplaceFileContent') {
                    const relPath = args.relativeFilePath || '';
                    const dirName = path.dirname(relPath).replace(/\\/g, '/');
                    requiredScope = `write_file:${dirName === '.' ? '' : dirName}`;
                }

                // If askQuestion, it is a special interactive case
                const isQuestion = name === 'askQuestion';

                // Check whitelist permission
                const isPermissionGranted = requiredScope ? matchesPermission(requiredScope, this._grantedPermissions) : false;

                const config = vscode.workspace.getConfiguration('windAgent');
                const autoExecution = config.get<string>('autoExecution') || 'Ask for Approval';
                const fastAction = this._context.workspaceState.get<boolean>('fastAction', false);
                const actualRequiresApproval = isQuestion || (requiresApproval && (autoExecution !== 'Always Proceed') && !fastAction && !isPermissionGranted);

                const msg: any = {
                    type: isQuestion ? 'askQuestionCall' : 'toolCall',
                    toolId,
                    toolName: name,
                    paramValue: JSON.stringify(args, null, 2),
                    requiresApproval: actualRequiresApproval,
                    requiredScope,
                    isPermissionGranted,
                    index: 0
                };
                const idx = this._appendToSession(sessionId, msg);
                msg.index = idx;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(msg);
                }

                if (actualRequiresApproval) {
                    const bgTask = this._backgroundTasks.get(sessionId);
                    if (bgTask) {
                        bgTask.isWaitingApproval = true;
                        this._updateStatusBar();
                    }
                    return new Promise<boolean>((resolve) => {
                        this._pendingToolResolves.set(toolId, (approvedOrAnswer: any) => {
                            if (bgTask) {
                                bgTask.isWaitingApproval = false;
                                this._updateStatusBar();
                            }
                            if (isQuestion) {
                                const answers = Array.isArray(approvedOrAnswer) ? approvedOrAnswer : [];
                                // Set response on the bg task agent if available, else fallback to main agent
                                if (bgTask && bgTask.agent && bgTask.agent.toolsManager) {
                                    bgTask.agent.toolsManager.setLastQuestionResponse(answers);
                                } else if (this._agent && this._agent.toolsManager) {
                                    this._agent.toolsManager.setLastQuestionResponse(answers);
                                }
                                resolve(true);
                            } else {
                                resolve(!!approvedOrAnswer);
                            }
                        });
                    });
                }
                return true;
            },
            onToolResult: (toolId: string, name: string, success: boolean, resultMessage: string) => {
                const args = this._pendingToolArgs.get(toolId);
                if (success && args) {
                    if ((name === 'writeFile' || name === 'replaceFileContent' || name === 'multiReplaceFileContent') && args.relativeFilePath) {
                        this._sessionAcceptedFiles.delete(args.relativeFilePath);
                        this._sessionModifiedFiles.add(args.relativeFilePath);
                        if (this._diffManager) {
                            this._diffManager.initializeInlineDiff(args.relativeFilePath);
                        }
                    }
                }
                this._pendingToolArgs.delete(toolId);

                // Clean up streaming state
                const state = this._streamingFiles.get(toolId);
                if (state) {
                    (async () => {
                        try {
                            await state.queue.wait();
                            if (success) {
                                const doc = await vscode.workspace.openTextDocument(state.absolutePath);
                                await doc.save();
                                if (this._diffManager) {
                                    await this._diffManager.initializeInlineDiff(state.relativePath, state.cleanContent);
                                }
                            } else {
                                await this._discardSingleFile(state.relativePath);
                            }
                        } catch (e) {
                            console.error('Failed to finalize streaming file:', e);
                        } finally {
                            this._streamingFiles.delete(toolId);
                        }
                    })();
                }

                const msg: any = {
                    type: 'toolResult',
                    toolId,
                    success,
                    resultMessage,
                    index: 0
                };
                const idx = this._appendToSession(sessionId, msg);
                msg.index = idx;
                if (this._activeSessionId === sessionId) {
                    this._view?.webview.postMessage(msg);
                    this._sendModifiedFilesDebounced();
                }
            },
            onToolStream: (toolId: string, toolName: string, args: any) => {
                if (toolName !== 'writeFile' && toolName !== 'replaceFileContent') {
                    return;
                }
                const relativePath = args.relativeFilePath;
                if (!relativePath) return;

                let safeRelative: string;
                try {
                    safeRelative = this._getSafeRelativePath(relativePath);
                } catch (e) {
                    console.error(e);
                    return;
                }

                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) return;
                const workspaceRoot = workspaceFolders[0].uri.fsPath;
                const absolutePath = path.resolve(workspaceRoot, safeRelative);

                let state = this._streamingFiles.get(toolId);
                if (!state) {
                    state = {
                        absolutePath,
                        relativePath: safeRelative,
                        opened: false,
                        toolName,
                        queue: new EditQueue()
                    };
                    this._streamingFiles.set(toolId, state);
                }

                state.queue.enqueue(async () => {
                    if (!state!.opened) {
                        if (this._agent) {
                            try {
                                await this._agent.toolsManager.backupFile(relativePath);
                            } catch (e) {
                                console.error('Failed to backup file during stream:', e);
                            }
                        }

                        const absolutePathExists = await this._fileExists(absolutePath);
                        if (!absolutePathExists) {
                            try {
                                await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
                                await fs.promises.writeFile(absolutePath, '', 'utf8');
                            } catch (e) {
                                console.error('Failed to create empty file:', e);
                            }
                        }

                        // Read original content before any modifications
                        let originalContent = '';
                        if (await this._fileExists(absolutePath)) {
                            try {
                                originalContent = await fs.promises.readFile(absolutePath, 'utf8');
                            } catch (e) {
                                console.error(e);
                            }
                        }
                        state!.originalContent = originalContent;
                        state!.cleanContent = originalContent;

                        this._sessionAcceptedFiles.delete(relativePath);
                        this._sessionModifiedFiles.add(relativePath);
                        if (this._activeSessionId === sessionId) {
                            this._sendModifiedFiles();
                        }

                        try {
                            const doc = await vscode.workspace.openTextDocument(absolutePath);
                            if (this._activeSessionId === sessionId) {
                                await vscode.window.showTextDocument(doc, { preview: false });
                            }
                            state!.opened = true;
                        } catch (e) {
                            console.error('Failed to open document:', e);
                            return;
                        }
                    }

                    try {
                        const doc = await vscode.workspace.openTextDocument(absolutePath);
                        
                        if (toolName === 'writeFile') {
                            const partialContent = args.content;
                            if (partialContent !== undefined) {
                                state!.cleanContent = partialContent;
                                if (!this._diffManager) {
                                    const edit = new vscode.WorkspaceEdit();
                                    const fullRange = new vscode.Range(
                                        doc.positionAt(0),
                                        doc.positionAt(doc.getText().length)
                                    );
                                    edit.replace(doc.uri, fullRange, partialContent);
                                    await vscode.workspace.applyEdit(edit);
                                }
                            }
                        } else if (toolName === 'replaceFileContent') {
                            const targetContent = args.targetContent;
                            const replacementContent = args.replacementContent;

                            if (targetContent !== undefined && replacementContent !== undefined) {
                                const docText = doc.getText();
                                const hasCRLF = state!.originalContent?.includes('\r\n') || docText.includes('\r\n');
                                const normalizedTarget = hasCRLF ? targetContent.replace(/\r?\n/g, '\r\n') : targetContent.replace(/\r\n/g, '\n');
                                const normalizedReplacement = hasCRLF ? replacementContent.replace(/\r?\n/g, '\r\n') : replacementContent.replace(/\r\n/g, '\n');

                                const originalContent = state!.originalContent;
                                if (state!.targetOffset === undefined && originalContent !== undefined) {
                                    const offset = originalContent.indexOf(normalizedTarget);
                                    if (offset !== -1) {
                                        state!.targetOffset = offset;
                                        state!.targetLength = normalizedTarget.length;
                                    }
                                }

                                if (state!.targetOffset !== undefined && state!.targetLength !== undefined && originalContent !== undefined) {
                                    const start = state!.targetOffset;
                                    const len = state!.targetLength;
                                    const cleanContent = originalContent.substring(0, start) + 
                                                         normalizedReplacement + 
                                                         originalContent.substring(start + len);
                                    state!.cleanContent = cleanContent;

                                    if (!this._diffManager) {
                                        if (state!.startOffset === undefined) {
                                            const docOffset = docText.indexOf(normalizedTarget);
                                            if (docOffset !== -1) {
                                                state!.startOffset = docOffset;
                                                state!.lastReplacementLength = normalizedTarget.length;
                                            }
                                        }

                                        if (state!.startOffset !== undefined && state!.lastReplacementLength !== undefined) {
                                            const editRange = new vscode.Range(
                                                doc.positionAt(state!.startOffset),
                                                doc.positionAt(state!.startOffset + state!.lastReplacementLength)
                                            );
                                            const edit = new vscode.WorkspaceEdit();
                                            edit.replace(doc.uri, editRange, normalizedReplacement);
                                            await vscode.workspace.applyEdit(edit);
                                            state!.lastReplacementLength = normalizedReplacement.length;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Failed to apply stream edit:', e);
                    }
                });
            },
            onBrowserScreenshot: (base64: string) => {
                if (this._activeSessionId === sessionId && this._view) {
                    this._view.webview.postMessage({
                        type: 'browserScreenshotUpdate',
                        screenshot: base64
                    });
                }
            }
        };
    }

    private _sendWorkspaceFilesDebounced() {
        if (this._workspaceFilesTimeout) {
            clearTimeout(this._workspaceFilesTimeout);
        }
        this._workspaceFilesTimeout = setTimeout(() => {
            this._sendWorkspaceFiles();
        }, 500);
    }

    private async _sendWorkspaceFiles() {
        if (!this._view) {
            return;
        }
        try {
            if (this._cachedWorkspaceFiles) {
                this._view.webview.postMessage({
                    type: 'workspaceFiles',
                    files: this._cachedWorkspaceFiles
                });
                return;
            }
            const files = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode/**,**/bin/**,**/obj/**,**/build/**,**/.next/**,**/target/**,**/.venv/**,**/venv/**,**/env/**,**/.idea/**,**/.cache/**,**/.nuxt/**,**/Library/**,**/Temp/**,**/Logs/**,**/UserSettings/**,**/.vs/**,**/*.meta,**/*.png,**/*.mat,**/*.wav,**/*.asset,**/*.prefab,**/*.anim,**/*.fbx,**/*.tga,**/*.mp3,**/*.overrideController,**/*.controller}',
                10001
            );
            let relativePaths = files.map(file => vscode.workspace.asRelativePath(file).replace(/\\/g, '/'));
            if (relativePaths.length > 10000) {
                relativePaths = relativePaths.slice(0, 10000);
            }
            this._cachedWorkspaceFiles = relativePaths;
            this._view.webview.postMessage({
                type: 'workspaceFiles',
                files: relativePaths
            });
        } catch (e) {
            console.error('Error finding workspace files:', e);
        }
    }

    private async _writeWorkspaceFile(absolutePath: string, content: string): Promise<void> {
        try {
            // Ensure parent directory exists
            await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

            const fileUri = vscode.Uri.file(absolutePath);
            const fileExists = await fs.promises.access(absolutePath).then(() => true).catch(() => false);
            if (!fileExists) {
                await fs.promises.writeFile(absolutePath, '', 'utf8');
            }
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            edit.replace(fileUri, fullRange, content);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            } else {
                await fs.promises.writeFile(absolutePath, content, 'utf8');
            }
        } catch (error) {
            try {
                await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
            } catch { /* ignore */ }
            await fs.promises.writeFile(absolutePath, content, 'utf8');
        }
    }

    private async _handleScheduleCommand(text: string): Promise<string> {
        const trimmed = text.trim();
        if (trimmed === '/schedule' || trimmed === '/schedule list') {
            return this._listScheduledTasks();
        }
        
        const cancelMatch = trimmed.match(/^\/schedule\s+cancel\s+(\S+)/i);
        if (cancelMatch) {
            const taskId = cancelMatch[1];
            const cancelled = this._cancelScheduledTask(taskId);
            if (cancelled) {
                return `⏰ **Scheduled task \`${taskId}\` has been successfully cancelled.**`;
            } else {
                return `⚠️ **Scheduled task with ID \`${taskId}\` was not found.**`;
            }
        }

        // Parse: /schedule "command" every|in X units
        const schedulePartRegex = /\s+(every|in)\s+(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)?$/i;
        const match = trimmed.match(schedulePartRegex);
        if (!match || !trimmed.startsWith('/schedule')) {
            return `❌ **Incorrect command syntax for \`/schedule\`.**\n` +
                   `Use one of the following syntaxes:\n` +
                   `- \`/schedule "command/goal" every <number> <unit>\`\n` +
                   `- \`/schedule "command/goal" in <number> <unit>\`\n` +
                   `- \`/schedule list\`\n` +
                   `- \`/schedule cancel <id>\`\n` +
                   `*Example: \`/schedule "git status" every 10s\` or \`/schedule "run npm test" in 2 minutes\`***`;
        }

        const typeWord = match[1].toLowerCase(); // 'every' or 'in'
        const valueNum = parseInt(match[2], 10);
        const unit = (match[3] || 's').toLowerCase();

        // Extract command part
        const schedulePartStr = match[0];
        const commandPart = trimmed.substring(0, trimmed.length - schedulePartStr.length).replace(/^\/schedule\s+/, '').trim();
        let command = commandPart;
        if (command.startsWith('"') && command.endsWith('"')) {
            command = command.substring(1, command.length - 1);
        }

        let multiplier = 1000; // default seconds
        if (['m', 'min', 'minute', 'minutes'].includes(unit)) {
            multiplier = 60 * 1000;
        } else if (['h', 'hr', 'hour', 'hours'].includes(unit)) {
            multiplier = 60 * 60 * 1000;
        } else if (['d', 'day', 'days'].includes(unit)) {
            multiplier = 24 * 60 * 60 * 1000;
        }

        const intervalMs = valueNum * multiplier;
        const taskId = `task_${this._nextTaskId++}`;
        const type = typeWord === 'every' ? 'interval' : 'timeout';
        const nextRunTime = Date.now() + intervalMs;

        const scheduledTask: ScheduledTask = {
            id: taskId,
            command: command,
            type: type,
            intervalMs: intervalMs,
            nextRunTime: nextRunTime
        };

        const executeScheduledTask = async () => {
            if (!this._view) return;
            
            // Post notification / log to chat webview
            const notificationMsg = {
                type: 'addMessage',
                sender: 'agent',
                text: `⏰ **[Scheduler] Automatically activating background task \`${taskId}\`:**\n> Command/Goal: "${command}"`
            };
            this._view.webview.postMessage(notificationMsg);
            this._appendToActiveSession(notificationMsg);
            
            const savedModel = this._context.workspaceState.get<string>('selectedModel') || 'gemini-3.5-flash-high';
            const savedConfigIndex = this._context.workspaceState.get<number>('selectedModelConfigIndex');
            const savedMode = this._context.workspaceState.get<string>('selectedMode') || 'agent';

            try {
                await this._handleUserMessage(command, savedModel, savedMode, savedConfigIndex);
            } catch (err: any) {
                console.error(`Error running scheduled task ${taskId}:`, err);
            }

            if (type === 'timeout') {
                this._scheduledTasks.delete(taskId);
            } else {
                scheduledTask.nextRunTime = Date.now() + intervalMs;
            }
        };

        if (type === 'timeout') {
            scheduledTask.timer = setTimeout(executeScheduledTask, intervalMs);
        } else {
            scheduledTask.timer = setInterval(executeScheduledTask, intervalMs);
        }

        this._scheduledTasks.set(taskId, scheduledTask);

        const typeStr = typeWord === 'every' ? 'every' : 'in';
        return `⏰ **Successfully scheduled task:**\n` +
               `- **ID**: \`${taskId}\`\n` +
               `- **Task**: "${command}"\n` +
               `- **Time**: ${typeStr} \`${valueNum}${unit}\` (${intervalMs / 1000}s)`;
    }

    private _listScheduledTasks(): string {
        if (this._scheduledTasks.size === 0) {
            return `⏰ **There are currently no active scheduled tasks.**`;
        }

        let response = `⏰ **List of active scheduled tasks:**\n\n`;
        for (const task of this._scheduledTasks.values()) {
            const remainingSec = Math.max(0, Math.round((task.nextRunTime - Date.now()) / 1000));
            const modeStr = task.type === 'interval' ? 'Interval' : 'One-shot';
            const cycleStr = task.type === 'interval' ? ` every ${task.intervalMs / 1000}s` : '';
            response += `- **ID**: \`${task.id}\` | **Type**: ${modeStr}${cycleStr} | **Remaining**: ${remainingSec}s\n  - **Task**: "${task.command}"\n`;
        }
        return response;
    }

    private _cancelScheduledTask(id: string): boolean {
        const task = this._scheduledTasks.get(id);
        if (task) {
            if (task.timer) {
                if (task.type === 'timeout') {
                    clearTimeout(task.timer);
                } else {
                    clearInterval(task.timer);
                }
            }
            this._scheduledTasks.delete(id);
            return true;
        }
        return false;
    }

    private async _runAutoTestLoop(sessionId: string, text: string, selectedModel?: string, configIndex?: number, signal?: AbortSignal): Promise<string> {
        const trimmed = text.trim();
        if (!trimmed.startsWith('/test-loop')) {
            return `❌ **Incorrect command syntax for \`/test-loop\`.**`;
        }

        const lastSpaceIndex = trimmed.lastIndexOf(' ');
        if (lastSpaceIndex === -1 || lastSpaceIndex <= 10) {
            return `❌ **Incorrect command syntax for \`/test-loop\`.**\n` +
                   `Use the following syntax:\n` +
                   `- \`/test-loop "test command" <path to file to fix>\`\n` +
                   `*Example: \`/test-loop "npm run compile" src/agent.ts\`*`;
        }

        const relativeFilePath = trimmed.substring(lastSpaceIndex + 1).trim();
        const commandPart = trimmed.substring(0, lastSpaceIndex).substring(10).trim();
        let testCommand = commandPart;
        if (testCommand.startsWith('"') && testCommand.endsWith('"')) {
            testCommand = testCommand.substring(1, testCommand.length - 1);
        }

        if (!relativeFilePath || !testCommand) {
            return `❌ **Incorrect command syntax for \`/test-loop\`.**\n` +
                   `Use the following syntax:\n` +
                   `- \`/test-loop "test command" <path to file to fix>\`\n` +
                   `*Example: \`/test-loop "npm run compile" src/agent.ts\`*`;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return `❌ **Workspace not found.**`;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const absolutePath = path.resolve(workspaceRoot, relativeFilePath);
        
        try {
            await fs.promises.access(absolutePath);
        } catch {
            return `❌ **File does not exist at path:** \`${relativeFilePath}\``;
        }

        const postLog = (msgText: string) => {
            const msg: any = {
                type: 'addMessage',
                sender: 'agent',
                text: msgText,
                index: 0
            };
            const idx = this._appendToSession(sessionId, msg);
            msg.index = idx;
            if (this._activeSessionId === sessionId) {
                this._view?.webview.postMessage(msg);
            }
        };

        const execAsync = util.promisify(cp.exec);

        let iteration = 1;
        const maxRetries = 5;
        let success = false;

        while (iteration <= maxRetries) {
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            postLog(`🔄 **[Test-Loop #${iteration}]** Running command: \`${testCommand}\`...`);
            
            let stdout: string;
            let stderr: string;
            let runError: any = null;

            try {
                const res = await execAsync(testCommand, { cwd: workspaceRoot, timeout: 60000, signal });
                stdout = res.stdout || '';
                stderr = res.stderr || '';
            } catch (err: any) {
                runError = err;
                stdout = err.stdout || '';
                stderr = err.stderr || '';
            }

            const outputLog = (stdout + '\n' + stderr).trim();
            if (!runError) {
                postLog(`✅ **Compilation/Testing succeeded!** No errors occurred in cycle #${iteration}.`);
                success = true;
                break;
            }

            postLog(`❌ **Error detected in cycle #${iteration}:**\n\`\`\`\n${outputLog.substring(0, 1000)}${outputLog.length > 1000 ? '\n...[Log truncated]' : ''}\n\`\`\``);

            if (iteration === maxRetries) {
                break;
            }

            postLog(`🧠 **LLM Self-Healing:** Analyzing the error and planning a fix for file \`${relativeFilePath}\`...`);

            const currentCode = await fs.promises.readFile(absolutePath, 'utf8');
            const fixPrompt = `You are a self-healing compiler assistant.
The following test/compilation command failed:
\`\`\`
${testCommand}
\`\`\`

Here is the error log:
\`\`\`
${outputLog}
\`\`\`

Here is the current code of the file "${relativeFilePath}":
\`\`\`
${currentCode}
\`\`\`

Analyze the error and the code. Output the COMPLETE corrected code for the file "${relativeFilePath}".
IMPORTANT rules:
1. Return ONLY the modified code wrapped in a markdown code block matching the language extension.
2. Do NOT include any explanations, introduction, or conversation outside the code block.`;

            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }

            let correctedCode: string;
            try {
                correctedCode = await this._getLLMSelfHealingFix(fixPrompt, selectedModel, configIndex, signal);
            } catch (err: any) {
                postLog(`⚠️ **Error calling LLM:** ${err.message}. Retrying...`);
                iteration++;
                continue;
            }

            if (!correctedCode || correctedCode.trim() === '') {
                postLog(`⚠️ **LLM returned empty result.** Cannot proceed with modification.`);
                iteration++;
                continue;
            }

            try {
                if (this._agent) {
                    await this._agent.toolsManager.backupFile(relativeFilePath);
                } else {
                    const tempTools = new ToolsManager(workspaceRoot);
                    await tempTools.backupFile(relativeFilePath);
                }
                await this._writeWorkspaceFile(absolutePath, correctedCode);
                
                this._sessionAcceptedFiles.delete(relativeFilePath);
                this._sessionModifiedFiles.add(relativeFilePath);
                this._sendModifiedFiles();

                postLog(`✍️ **Automatically applied the bug fix to file \`${relativeFilePath}\`. Restarting compilation/testing...**`);
            } catch (err: any) {
                postLog(`❌ **Cannot write modified file:** ${err.message}`);
                break;
            }

            iteration++;
        }

        if (success) {
            return `🎉 **Completed test loop successfully!** All changes have been verified and compiled/tested successfully.`;
        } else {
            return `🛑 **Test loop finished after ${maxRetries} failed retries.** Please inspect the remaining compilation/testing errors manually.`;
        }
    }

    private async _getLLMSelfHealingFix(prompt: string, selectedModel?: string, configIndex?: number, signal?: AbortSignal): Promise<string> {
        const { keys, endpoint, model, configName } = this._getAPIConfig(configIndex, selectedModel);

        const url = endpoint.replace(/\/+$/, '');
        const body = {
            model: model,
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: 0.1
        };

        const cachedIndex = configName 
            ? (this._context.workspaceState.get<number>(`activeKeyIndex_${configName}`) || 0)
            : 0;
        
        const keysCount = keys.length || 1;
        const startIndex = (cachedIndex >= 0 && cachedIndex < keysCount) ? cachedIndex : 0;

        let lastError: any = null;
        for (let attempt = 0; attempt < keysCount; attempt++) {
            const currentIndex = (startIndex + attempt) % keysCount;
            const currentKey = keys[currentIndex];

            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            if (currentKey) {
                headers['Authorization'] = `Bearer ${currentKey}`;
            }

            try {
                const res = await axios.post(`${url}/chat/completions`, body, { headers, timeout: 30000, signal });

                if (res.data && res.data.choices && res.data.choices.length > 0) {
                    if (configName && keys.length > 1) {
                        await this._context.workspaceState.update(`activeKeyIndex_${configName}`, currentIndex);
                    }
                    const content = res.data.choices[0].message.content || '';
                    let cleanContent = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
                    cleanContent = cleanContent.replace(/<thought>[\s\S]*$/gi, '');
                    cleanContent = cleanContent.replace(/^[\s\S]*?<\/thought>/gi, '');

                    let code = cleanContent.trim();
                    const match = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
                    if (match) {
                        code = match[1];
                    }
                    return code;
                }
                throw new Error('LLM call returned an empty response.');
            } catch (err: any) {
                lastError = err;
            }
        }
        throw lastError || new Error('All API Keys failed for self-healing fix.');
    }

    private async _sendMcpServers() {
        if (!this._view) return;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const manager = this._agent ? this._agent.toolsManager : new ToolsManager(workspaceRoot);
            try {
                const servers = await manager.getMcpServers();
                
                // Construct presets dynamically with absolute paths resolved on user's system!
                const isWindows = process.platform === 'win32';
                const unityExecutableName = isWindows ? 'relay_win.exe' : (process.platform === 'darwin' ? 'relay_mac' : 'relay_linux');
                const unityPath = path.join(os.homedir(), '.unity', 'relay', unityExecutableName);

                const presets = [
                    {
                        label: '🎮 Unity MCP',
                        name: 'unity-mcp',
                        command: unityPath,
                        args: ['--mcp'],
                        env: {}
                    },
                    {
                        label: '🌐 Everything MCP',
                        name: 'everything-mcp',
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-everything'],
                        env: {}
                    },
                    {
                        label: '📁 Filesystem MCP',
                        name: 'filesystem-mcp',
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot],
                        env: {}
                    },
                    {
                        label: '🧠 Memory MCP',
                        name: 'memory-mcp',
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-memory'],
                        env: {}
                    }
                ];

                this._view.webview.postMessage({
                    type: 'mcpServers',
                    servers,
                    presets
                });
            } catch (err: any) {
                console.error('Failed to get MCP servers:', err);
            }
        }
    }
}
