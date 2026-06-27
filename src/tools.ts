import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import * as crypto from 'crypto';
import * as os from 'os';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { StringDecoder } from 'string_decoder';
import { McpManager } from './mcp';

const execAsync = promisify(exec);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            return reject(new Error('Cancelled by user'));
        }
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener('abort', abort);
            }
            resolve();
        }, ms);
        function abort() {
            clearTimeout(timer);
            reject(new Error('Cancelled by user'));
        }
        if (signal) {
            signal.addEventListener('abort', abort);
        }
    });
}

// Module-level constants to avoid re-creating per invocation
const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.exe', '.dll', '.zip',
    '.tar', '.gz', '.mp3', '.mp4', '.webm', '.bin', '.obj', '.o', '.a',
    '.lib', '.class', '.wasm', '.ttf', '.woff', '.woff2', '.eot', '.psd',
    '.ai', '.sketch', '.bmp', '.tiff', '.7z', '.rar', '.so', '.dylib', '.vsix'
]);

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
    };
}

export const TOOLS: ToolDefinition[] = [
    {
        name: 'listFiles',
        description: 'Lists all files in the current workspace directory recursively.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'listDir',
        description: 'Lists the immediate contents (files and directories) of a specific directory path relative to the workspace root.',
        parameters: {
            type: 'object',
            properties: {
                relativeDirPath: {
                    type: 'string',
                    description: 'The directory path relative to the workspace root. Use empty string or "." for the workspace root.'
                }
            },
            required: []
        }
    },
    {
        name: 'readFile',
        description: 'Reads the content of a file in the workspace, optionally between specific line ranges.',
        parameters: {
            type: 'object',
            properties: {
                relativeFilePath: {
                    type: 'string',
                    description: 'The path to the file relative to the workspace root.'
                },
                startLine: {
                    type: 'number',
                    description: 'The starting line number to read (1-indexed, inclusive).'
                },
                endLine: {
                    type: 'number',
                    description: 'The ending line number to read (1-indexed, inclusive).'
                }
            },
            required: ['relativeFilePath']
        }
    },
    {
        name: 'writeFile',
        description: 'Creates a new file or overwrites an existing file in the workspace with new content.',
        parameters: {
            type: 'object',
            properties: {
                relativeFilePath: {
                    type: 'string',
                    description: 'The path to write to relative to the workspace root.'
                },
                content: {
                    type: 'string',
                    description: 'The content to write to the file.'
                }
            },
            required: ['relativeFilePath', 'content']
        }
    },
    {
        name: 'runCommand',
        description: 'Executes a command line instruction in the terminal in the workspace root.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute.'
                },
                runInBackground: {
                    type: 'boolean',
                    description: 'Whether to run the command in the background (asynchronous). Useful for servers, pings, or long-running builds.'
                }
            },
            required: ['command']
        }
    },
    {
        name: 'getCommandStatus',
        description: 'Checks the running status and retrieves the latest output log of a background command.',
        parameters: {
            type: 'object',
            properties: {
                commandId: {
                    type: 'string',
                    description: 'The unique ID of the background command.'
                }
            },
            required: ['commandId']
        }
    },
    {
        name: 'sendCommandInput',
        description: 'Interacts with a running background command by sending stdin text input or terminating the process.',
        parameters: {
            type: 'object',
            properties: {
                commandId: {
                    type: 'string',
                    description: 'The unique ID of the background command.'
                },
                input: {
                    type: 'string',
                    description: 'The text input to send to the process stdin.'
                },
                terminate: {
                    type: 'boolean',
                    description: 'If set to true, terminates/kills the background process.'
                }
            },
            required: ['commandId']
        }
    },
    {
        name: 'replaceFileContent',
        description: 'Replaces a specific contiguous block of text inside a file with new content.',
        parameters: {
            type: 'object',
            properties: {
                relativeFilePath: {
                    type: 'string',
                    description: 'The path to the file relative to the workspace root.'
                },
                targetContent: {
                    type: 'string',
                    description: 'The exact block of text to search for and replace.'
                },
                replacementContent: {
                    type: 'string',
                    description: 'The new content to replace the targetContent with.'
                }
            },
            required: ['relativeFilePath', 'targetContent', 'replacementContent']
        }
    },
    {
        name: 'multiReplaceFileContent',
        description: 'Replaces multiple non-contiguous blocks of text in a single file.',
        parameters: {
            type: 'object',
            properties: {
                relativeFilePath: {
                    type: 'string',
                    description: 'The path to the file relative to the workspace root.'
                },
                replacements: {
                    type: 'array',
                    description: 'A list of replacements to apply to the file.',
                    items: {
                        type: 'object',
                        properties: {
                            targetContent: {
                                type: 'string',
                                description: 'The exact block of text to search for and replace.'
                            },
                            replacementContent: {
                                type: 'string',
                                description: 'The new content to replace the targetContent with.'
                            }
                        },
                        required: ['targetContent', 'replacementContent']
                    }
                }
            },
            required: ['relativeFilePath', 'replacements']
        }
    },
    {
        name: 'fetchUrl',
        description: 'Fetches the content of a URL (web page or API endpoint) and returns it.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The absolute URL to fetch.'
                }
            },
            required: ['url']
        }
    },
    {
        name: 'searchWeb',
        description: 'Performs a web search for a given query, returning titles, snippets, and URLs of search results.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search term or query.'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'grepSearch',
        description: 'Search for a regex pattern within files in a directory using ripgrep or fallback search.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The regular expression or string to search for.'
                },
                dirPath: {
                    type: 'string',
                    description: 'The directory path to search in, relative to workspace root. Use "." for the root.'
                },
                isRegex: {
                    type: 'boolean',
                    description: 'Whether the query should be treated as a regular expression. Defaults to false.'
                }
            },
            required: ['query', 'dirPath']
        }
    },
    {
        name: 'generateImage',
        description: 'Generates an image based on a text prompt and saves it to the workspace.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The text description of the image to generate.'
                },
                relativeFilePath: {
                    type: 'string',
                    description: 'The relative file path where the generated image will be saved (e.g. "assets/mockup.png").'
                }
            },
            required: ['prompt', 'relativeFilePath']
        }
    },
    {
        name: 'browserSubagent',
        description: 'Spawns an autonomous browser subagent to execute a web task. Returns the result and optionally saves a screenshot.',
        parameters: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: 'Detailed instructions for the browser subagent.'
                },
                url: {
                    type: 'string',
                    description: 'The starting URL for the task.'
                }
            },
            required: ['task', 'url']
        }
    },
    {
        name: 'browserOpen',
        description: 'Opens a web browser and navigates to the specified URL.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The absolute URL to navigate to (e.g. http://localhost:3000 or https://google.com).'
                },
                headless: {
                    type: 'boolean',
                    description: 'Whether to run the browser in headless mode. Set to false to see the browser window. (Default: false)'
                }
            },
            required: ['url']
        }
    },
    {
        name: 'browserClick',
        description: 'Clicks an element on the active web page using a CSS selector or visible text.',
        parameters: {
            type: 'object',
            properties: {
                selector: {
                    type: 'string',
                    description: 'The CSS selector of the element to click (e.g. "button#submit", "a.login", or ".btn"). If text is provided, this selector can be used to target specific elements containing the text.'
                },
                text: {
                    type: 'string',
                    description: 'Optional. The exact text or substring contained inside the element to click.'
                }
            },
            required: ['selector']
        }
    },
    {
        name: 'browserType',
        description: 'Types text into an input or textarea field matching a CSS selector.',
        parameters: {
            type: 'object',
            properties: {
                selector: {
                    type: 'string',
                    description: 'The CSS selector of the input field to type into.'
                },
                text: {
                    type: 'string',
                    description: 'The text to type into the input field.'
                }
            },
            required: ['selector', 'text']
        }
    },
    {
        name: 'browserGetContent',
        description: 'Retrieves the text content or HTML structure of the active web page.',
        parameters: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['text', 'html'],
                    description: 'Whether to retrieve the visible text of the page, or the raw HTML structure. (Default: "text")'
                }
            },
            required: []
        }
    },
    {
        name: 'browserScreenshot',
        description: 'Takes a screenshot of the active web page and saves it to a relative path in the workspace.',
        parameters: {
            type: 'object',
            properties: {
                relativeFilePath: {
                    type: 'string',
                    description: 'The file path relative to the workspace root to save the screenshot image (e.g., "screenshots/homepage.png").'
                }
            },
            required: ['relativeFilePath']
        }
    },
    {
        name: 'browserClose',
        description: 'Closes the current browser session and all tabs.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'saveKnowledgeItem',
        description: 'Saves important project knowledge or architectural decisions into the workspace knowledge base.',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for the knowledge item (e.g., "build_setup", "api_conventions").'
                },
                content: {
                    type: 'string',
                    description: 'The knowledge content to save. Should be detailed and structured.'
                }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'runTerminalCommand',
        description: 'Executes a command inside the visible active VS Code terminal panel (Wind Agent Terminal).',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The command line instruction to execute.'
                }
            },
            required: ['command']
        }
    },
    {
        name: 'gitStatus',
        description: 'Runs git status to check the modified and untracked files in the workspace.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'gitDiff',
        description: 'Runs git diff to view changes made to workspace files.',
        parameters: {
            type: 'object',
            properties: {
                staged: {
                    type: 'boolean',
                    description: 'Whether to view staged changes (git diff --cached).'
                }
            },
            required: []
        }
    },
    {
        name: 'gitAdd',
        description: 'Stages changes in files for commit (git add).',
        parameters: {
            type: 'object',
            properties: {
                filePattern: {
                    type: 'string',
                    description: 'The path or pattern of files to stage (e.g. "." or "src/file.ts").'
                }
            },
            required: ['filePattern']
        }
    },
    {
        name: 'gitCommit',
        description: 'Commits staged changes with a message (git commit -m).',
        parameters: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The commit message describing the changes.'
                }
            },
            required: ['message']
        }
    },
    {
        name: 'searchWorkspaceSymbols',
        description: 'Searches for symbols (classes, functions, methods, etc.) in the workspace using VS Code symbol APIs.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The symbol name or search term.'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'searchKnowledgeBase',
        description: 'Searches for key terms or query strings in the local project knowledge base files (.vscode/wind-knowledge/).',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query or keyword.'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'readKnowledgeItem',
        description: 'Reads the full content of a specific knowledge item file by its name (e.g. "api_conventions.md").',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'The filename of the knowledge item (e.g. "api_conventions.md").'
                }
            },
            required: ['title']
        }
    },
    {
        name: 'searchSemanticCode',
        description: 'Performs a semantic (vector-based) search over the workspace codebase to find conceptually matching files, classes, methods, or code blocks.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The natural language query or concept description to search for in the codebase (e.g. "authentication validation" or "how files are read").'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'askQuestion',
        description: 'Asks the user a multiple-choice question to clarify requirements or make design decisions. Blocks until user responds.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'The question explaining the clarification needed.'
                },
                options: {
                    type: 'array',
                    description: 'The list of choices/options for the user.',
                    items: {
                        type: 'string'
                    }
                },
                isMultiSelect: {
                    type: 'boolean',
                    description: 'Whether the user can select multiple options.'
                }
            },
            required: ['question', 'options']
        }
    }
];

const AGENT_EFFECT_CSS = `
#wind-agent-cursor {
    position: fixed;
    width: 24px;
    height: 24px;
    background: radial-gradient(circle, rgba(139, 92, 246, 0.9) 0%, rgba(59, 130, 246, 0.4) 100%);
    border: 2px solid #ffffff;
    border-radius: 50%;
    pointer-events: none;
    z-index: 999999999;
    transition: left 0.6s cubic-bezier(0.25, 1, 0.5, 1), top 0.6s cubic-bezier(0.25, 1, 0.5, 1), transform 0.2s ease, opacity 0.3s ease;
    box-shadow: 0 0 15px rgba(139, 92, 246, 0.8);
    opacity: 0;
    transform: translate(-50%, -50%) scale(0);
}
#wind-agent-cursor.active {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
}
.wind-agent-ripple {
    position: fixed;
    border: 4px solid #8b5cf6;
    border-radius: 50%;
    pointer-events: none;
    z-index: 999999998;
    transform: translate(-50%, -50%);
    animation: wind-ripple-animation 0.6s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
}
@keyframes wind-ripple-animation {
    0% {
        width: 0px;
        height: 0px;
        opacity: 1;
    }
    100% {
        width: 80px;
        height: 80px;
        opacity: 0;
        border-color: #3b82f6;
    }
}
.wind-agent-highlight {
    outline: 3px solid #8b5cf6 !important;
    outline-offset: 2px !important;
    transition: outline 0.3s ease;
}
@property --wind-border-angle {
    syntax: '<angle>';
    initial-value: 0deg;
    inherits: false;
}
#wind-agent-border {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    box-sizing: border-box;
    border: 5px solid;
    border-image: conic-gradient(from var(--wind-border-angle), #4285f4 0%, #9b72cb 25%, #d96570 50%, #f49e4c 75%, #4285f4 100%) 1;
    pointer-events: none;
    z-index: 999999997;
    animation: wind-border-rotate 4s linear infinite;
}
@keyframes wind-border-rotate {
    to {
        --wind-border-angle: 360deg;
    }
}
`;

const AGENT_EFFECT_JS = `
window.__windAgentCursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

window.__windAgentShowEffect = function(x, y, type) {
    let cursor = document.getElementById('wind-agent-cursor');
    if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'wind-agent-cursor';
        document.body.appendChild(cursor);
    }
    
    // Position cursor at previous position
    cursor.style.left = window.__windAgentCursorPos.x + 'px';
    cursor.style.top = window.__windAgentCursorPos.y + 'px';
    
    // Make visible
    cursor.classList.add('active');
    
    // Smoothly animate to target position
    return new Promise((resolve) => {
        setTimeout(() => {
            cursor.style.left = x + 'px';
            cursor.style.top = y + 'px';
            window.__windAgentCursorPos = { x, y };
            
            // After movement is completed, show click/type effect
            setTimeout(() => {
                // Ripple effect
                const ripple = document.createElement('div');
                ripple.className = 'wind-agent-ripple';
                ripple.style.left = x + 'px';
                ripple.style.top = y + 'px';
                if (type === 'type') {
                    ripple.style.borderColor = '#3b82f6';
                }
                document.body.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
                
                // Pulse the cursor
                cursor.style.transform = 'translate(-50%, -50%) scale(1.4)';
                setTimeout(() => {
                    cursor.style.transform = 'translate(-50%, -50%) scale(1.0)';
                    resolve();
                }, 200);
            }, 600);
        }, 50);
    });
};

window.__windAgentHighlightElement = function(element, duration = 1500) {
    if (!element) return;
    element.classList.add('wind-agent-highlight');
    setTimeout(() => {
        element.classList.remove('wind-agent-highlight');
    }, duration);
};
`;

class ConcurrencyLimiter {
    private active = 0;
    private queue: (() => void)[] = [];

    constructor(private limit: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>(resolve => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

export class ToolsManager {
    private static activeMcpManagers = new Set<McpManager>();
    public mcpManager: McpManager;
    private static activeCommands = new Map<string, {
        process: ChildProcess;
        outputBuffer: string;
        exitCode: number | null;
        error?: string;
    }>();
    private static browser: Browser | null = null;
    private static page: Page | null = null;
    private static backupLock = Promise.resolve();

    private screenshotCallback?: (base64: string) => void;
    private questionHandler?: (question: string, options: string[], isMultiSelect: boolean) => Promise<string[]>;
    private lastQuestionResponse?: string[];

    public registerScreenshotCallback(cb: (base64: string) => void) {
        this.screenshotCallback = cb;
    }

    public registerQuestionHandler(handler: (question: string, options: string[], isMultiSelect: boolean) => Promise<string[]>) {
        this.questionHandler = handler;
    }

    public setLastQuestionResponse(response: string[]) {
        this.lastQuestionResponse = response;
    }

    private async triggerScreenshotCapture() {
        if (this.screenshotCallback && ToolsManager.page && !ToolsManager.page.isClosed()) {
            try {
                const base64 = await ToolsManager.page.screenshot({
                    type: 'png',
                    encoding: 'base64',
                    fullPage: false
                });
                this.screenshotCallback(base64);
            } catch (e) {
                console.error('Failed to capture auto screenshot:', e);
            }
        }
    }

    public static async dispose() {
        const timeoutPromise = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        
        for (const mcp of ToolsManager.activeMcpManagers) {
            try {
                await mcp.dispose();
            } catch (e) {
                // Ignore
            }
        }
        ToolsManager.activeMcpManagers.clear();

        if (ToolsManager.browser) {
            try {
                // Wrap browser close in a 2-second timeout
                await Promise.race([
                    ToolsManager.browser.close(),
                    timeoutPromise(2000)
                ]);
            } catch (e) {
                console.error('Failed to close browser during dispose:', e);
            }
            ToolsManager.browser = null;
            ToolsManager.page = null;
        }

        const killPromises = Array.from(ToolsManager.activeCommands.values()).map(async (cmd) => {
            try {
                if (cmd.process.pid) {
                    if (process.platform === 'win32') {
                        await Promise.race([
                            execAsync(`taskkill /F /T /PID ${cmd.process.pid}`),
                            timeoutPromise(1500)
                        ]);
                    } else {
                        try {
                            process.kill(-cmd.process.pid, 'SIGKILL');
                        } catch {
                            cmd.process.kill('SIGKILL');
                        }
                    }
                } else {
                    cmd.process.kill();
                }
            } catch (e) {
                // Ignore
            }
        });

        try {
            await Promise.race([
                Promise.all(killPromises),
                timeoutPromise(2000)
            ]);
        } catch (e) {
            // Ignore
        }
        ToolsManager.activeCommands.clear();
    }

    public apiKey: string | string[] = '';
    public endpoint: string = '';
    public model: string = '';

    public setLLMConfig(apiKey: string | string[], endpoint: string, model: string) {
        this.apiKey = apiKey;
        this.endpoint = endpoint;
        this.model = model;
    }

    constructor(private workspaceRoot: string) {
        this.mcpManager = new McpManager(workspaceRoot);
        ToolsManager.activeMcpManagers.add(this.mcpManager);
    }

    public async initializeMcp(): Promise<void> {
        await this.mcpManager.initialize();
    }

    public getAvailableTools() {
        const mcpTools = this.mcpManager.getTools().map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as any
        }));
        return [...TOOLS, ...mcpTools];
    }

    public async getMcpServers() {
        return await this.mcpManager.getMcpServers();
    }

    public async addMcpServer(name: string, config: any) {
        await this.mcpManager.addMcpServer(name, config);
    }

    public async deleteMcpServer(name: string) {
        await this.mcpManager.deleteMcpServer(name);
    }

    private resolvePath(relativePath: string): string {
        const cleanRelative = relativePath.replace(/^[/\\]+/, '');
        const resolved = path.resolve(this.workspaceRoot, cleanRelative);
        const normalizedRoot = path.resolve(this.workspaceRoot);
        
        // Use lowercase paths for relative check to avoid case-mismatch issues (e.g. drive letters on Windows)
        const relative = path.relative(normalizedRoot.toLowerCase(), resolved.toLowerCase());
        
        // Security check: Ensure path does not escape workspace root
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Access Denied: Path escapes workspace folder bounds: ${relativePath}`);
        }
        return resolved;
    }

    async executeTool(name: string, args: any, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) {
            throw new Error('Cancelled by user');
        }
        if (this.mcpManager.hasTool(name)) {
            return await this.mcpManager.callTool(name, args);
        }
        switch (name) {
            case 'listFiles':
                return await this.listFiles(signal);
            case 'listDir': {
                const relativeDirPath = args.relativeDirPath || args.dirPath || args.path || args.directory || args.dir;
                return await this.listDir(relativeDirPath);
            }
            case 'readFile': {
                const fileArg = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                if (!fileArg) {
                    throw new Error('Missing argument: relativeFilePath');
                }
                return await this.readFile(fileArg, args.startLine, args.endLine);
            }
            case 'writeFile': {
                const writeFilePath = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                const writeContent = args.content !== undefined ? args.content : args.text;
                if (!writeFilePath || writeContent === undefined) {
                    throw new Error('Missing arguments: relativeFilePath or content');
                }
                return await this.writeFile(writeFilePath, writeContent);
            }
            case 'replaceFileContent': {
                const replaceFilePath = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                const targetContent = args.targetContent || args.target || args.oldContent || args.oldText;
                const replacementContent = args.replacementContent || args.replacement || args.newContent || args.newText;
                if (!replaceFilePath || targetContent === undefined || replacementContent === undefined) {
                    throw new Error('Missing arguments for replaceFileContent');
                }
                return await this.replaceFileContent(replaceFilePath, targetContent, replacementContent);
            }
            case 'multiReplaceFileContent': {
                const multiReplaceFilePath = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                const replacements = args.replacements || args.replaceList || args.changes;
                if (!multiReplaceFilePath || !Array.isArray(replacements)) {
                    throw new Error('Missing or invalid arguments for multiReplaceFileContent');
                }
                return await this.multiReplaceFileContent(multiReplaceFilePath, replacements);
            }
            case 'fetchUrl':
                if (!args.url) {
                    throw new Error('Missing argument: url');
                }
                return await this.fetchUrl(args.url, signal);
            case 'searchWeb': {
                const searchQuery = args.query || args.q || args.search || args.searchText;
                if (!searchQuery) {
                    throw new Error('Missing argument: query');
                }
                return await this.searchWeb(searchQuery, signal);
            }
            case 'grepSearch': {
                const grepQuery = args.query || args.q || args.search;
                const grepDirPath = args.dirPath || args.path || args.dir;
                if (!grepQuery || !grepDirPath) {
                    throw new Error('Missing arguments: query or dirPath');
                }
                return await this.grepSearch(grepQuery, grepDirPath, args.isRegex, signal);
            }
            case 'generateImage': {
                const imgPath = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                if (!args.prompt || !imgPath) {
                    throw new Error('Missing arguments: prompt or relativeFilePath');
                }
                return await this.generateImage(args.prompt, imgPath);
            }
            case 'browserSubagent':
                if (!args.task || !args.url) {
                    throw new Error('Missing arguments: task or url');
                }
                return await this.browserSubagent(args.task, args.url, signal);
            case 'runCommand': {
                const commandStr = args.command || args.cmd || args.run || args.exec;
                if (!commandStr) {
                    throw new Error('Missing argument: command');
                }
                return await this.runCommand(commandStr, args.runInBackground, signal);
            }
            case 'getCommandStatus': {
                const statusCommandId = args.commandId || args.id;
                if (!statusCommandId) {
                    throw new Error('Missing argument: commandId');
                }
                return await this.getCommandStatus(statusCommandId);
            }
            case 'sendCommandInput': {
                const inputCommandId = args.commandId || args.id;
                if (!inputCommandId) {
                    throw new Error('Missing argument: commandId');
                }
                return await this.sendCommandInput(inputCommandId, args.input, args.terminate);
            }
            case 'browserOpen':
                if (!args.url) {
                    throw new Error('Missing argument: url');
                }
                return await this.browserOpen(args.url, args.headless);
            case 'browserClick':
                if (!args.selector) {
                    throw new Error('Missing argument: selector');
                }
                return await this.browserClick(args.selector, args.text);
            case 'browserType':
                if (!args.selector || args.text === undefined) {
                    throw new Error('Missing arguments: selector or text');
                }
                return await this.browserType(args.selector, args.text);
            case 'browserGetContent':
                return await this.browserGetContent(args.type);
            case 'browserScreenshot': {
                const screenshotPath = args.relativeFilePath || args.filePath || args.path || args.file || args.filename;
                if (!screenshotPath) {
                    throw new Error('Missing argument: relativeFilePath');
                }
                return await this.browserScreenshot(screenshotPath);
            }
            case 'browserClose':
                return await this.browserClose();
            case 'saveKnowledgeItem': {
                const kiTitle = args.title || args.name || args.topic;
                const kiContent = args.content || args.body || args.text;
                if (!kiTitle || !kiContent) {
                    throw new Error('Missing arguments: title or content');
                }
                return await this.saveKnowledgeItem(kiTitle, kiContent);
            }
            case 'runTerminalCommand': {
                const cmdStr = args.command || args.cmd || args.run || args.exec;
                if (!cmdStr) {
                    throw new Error('Missing argument: command');
                }
                return await this.runTerminalCommand(cmdStr);
            }
            case 'gitStatus': {
                return await this.gitStatus();
            }
            case 'gitDiff': {
                return await this.gitDiff(args.staged);
            }
            case 'gitAdd': {
                const fp = args.filePattern || args.pattern || args.path || args.file;
                if (!fp) {
                    throw new Error('Missing argument: filePattern');
                }
                return await this.gitAdd(fp);
            }
            case 'gitCommit': {
                const msg = args.message || args.msg || args.text;
                if (!msg) {
                    throw new Error('Missing argument: message');
                }
                return await this.gitCommit(msg);
            }
            case 'searchWorkspaceSymbols': {
                const q = args.query || args.q || args.search;
                if (!q) {
                    throw new Error('Missing argument: query');
                }
                return await this.searchWorkspaceSymbols(q);
            }
            case 'searchKnowledgeBase': {
                const q = args.query || args.q || args.search;
                if (!q) {
                    throw new Error('Missing argument: query');
                }
                return await this.searchKnowledgeBase(q);
            }
            case 'readKnowledgeItem': {
                const title = args.title || args.name || args.file;
                if (!title) {
                    throw new Error('Missing argument: title');
                }
                return await this.readKnowledgeItem(title);
            }
            case 'searchSemanticCode': {
                const q = args.query || args.q || args.search;
                if (!q) {
                    throw new Error('Missing argument: query');
                }
                return await this.searchSemanticCode(q, signal);
            }
            case 'askQuestion': {
                if (this.lastQuestionResponse !== undefined) {
                    const res = this.lastQuestionResponse;
                    this.lastQuestionResponse = undefined;
                    return JSON.stringify(res);
                }
                if (this.questionHandler) {
                    const answers = await this.questionHandler(args.question, args.options, !!args.isMultiSelect);
                    return JSON.stringify(answers);
                }
                throw new Error('No question response cached and no question handler registered.');
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    private async saveKnowledgeItem(title: string, content: string): Promise<string> {
        try {
            const kiDir = path.join(this.workspaceRoot, '.vscode', 'wind-knowledge');
            await fs.mkdir(kiDir, { recursive: true });
            const safeTitle = title.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
            const filePath = path.join(kiDir, `${safeTitle}.md`);
            await fs.writeFile(filePath, content, 'utf8');
            return `Knowledge item "${title}" saved successfully to .vscode/wind-knowledge/${safeTitle}.md`;
        } catch (error: any) {
            return `Error saving knowledge item: ${error.message}`;
        }
    }

    private async searchKnowledgeBase(query: string): Promise<string> {
        try {
            const kiDir = path.join(this.workspaceRoot, '.vscode', 'wind-knowledge');
            const stat = await fs.stat(kiDir).catch(() => null);
            if (!stat || !stat.isDirectory()) {
                return 'No knowledge items found in the workspace (directory does not exist).';
            }

            const files = await fs.readdir(kiDir);
            const matches: string[] = [];

            for (const file of files) {
                if (file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.txt')) {
                    const filePath = path.join(kiDir, file);
                    const content = await fs.readFile(filePath, 'utf8');
                    if (content.toLowerCase().includes(query.toLowerCase()) || file.toLowerCase().includes(query.toLowerCase())) {
                        // Find matching lines
                        const lines = content.split('\n');
                        const snippets: string[] = [];
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                                snippets.push(`Line ${i + 1}: ${lines[i].trim()}`);
                                if (snippets.length >= 3) break; // limit snippets per file
                            }
                        }
                        matches.push(`--- Matching File: ${file} ---\n` + (snippets.length > 0 ? snippets.join('\n') : '(Matched in filename)'));
                    }
                }
            }

            if (matches.length === 0) {
                return `No knowledge items matched the query "${query}".`;
            }
            return matches.join('\n\n');
        } catch (error: any) {
            return `Error searching knowledge base: ${error.message}`;
        }
    }

    private async readKnowledgeItem(title: string): Promise<string> {
        try {
            const kiDir = path.join(this.workspaceRoot, '.vscode', 'wind-knowledge');
            // Support both "rules.md" and "rules"
            let filename = title;
            if (!filename.endsWith('.md') && !filename.endsWith('.json') && !filename.endsWith('.txt')) {
                filename += '.md';
            }
            
            // Clean paths to prevent directory traversal
            const cleanFilename = path.basename(filename);
            const targetPath = path.join(kiDir, cleanFilename);

            const stat = await fs.stat(targetPath).catch(() => null);
            if (!stat || !stat.isFile()) {
                // Try case-insensitive matching
                const files = await fs.readdir(kiDir).catch(() => []);
                const match = files.find(f => f.toLowerCase() === cleanFilename.toLowerCase());
                if (match) {
                    const finalPath = path.join(kiDir, match);
                    const content = await fs.readFile(finalPath, 'utf8');
                    return `--- Knowledge Item: ${match} ---\n${content}`;
                }
                return `Error: Knowledge item file "${cleanFilename}" not found in .vscode/wind-knowledge/`;
            }

            const content = await fs.readFile(targetPath, 'utf8');
            return `--- Knowledge Item: ${cleanFilename} ---\n${content}`;
        } catch (error: any) {
            return `Error reading knowledge item: ${error.message}`;
        }
    }

    private async listFiles(signal?: AbortSignal): Promise<string> {
        try {
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            const uris = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode/**,**/bin/**,**/obj/**}',
                501
            );
            if (uris.length === 0) {
                return 'The workspace is empty.';
            }
            
            const files = uris.map(uri => path.relative(this.workspaceRoot, uri.fsPath));
            if (files.length > 500) {
                const truncatedFiles = files.slice(0, 500);
                return truncatedFiles.join('\n') + '\n\n...[Warning: Too many files. List truncated to 500. Please use listDir to explore specific directories instead.]';
            }
            return files.join('\n');
        } catch (error: any) {
            return `Error listing files: ${error.message}`;
        }
    }

    private async readFile(relativeFilePath: string, startLine?: number, endLine?: number): Promise<string> {
        try {
            const targetPath = this.resolvePath(relativeFilePath);

            // Guard: skip known binary files
            const ext = path.extname(targetPath).toLowerCase();
            if (BINARY_EXTS.has(ext)) {
                return `Error: "${relativeFilePath}" is a binary file and cannot be read as text.`;
            }

            // Guard: skip files > 2MB to prevent OOM
            const stats = await fs.stat(targetPath);
            if (stats.size > 2 * 1024 * 1024) {
                return `Error: "${relativeFilePath}" is too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Use startLine/endLine to read a specific section.`;
            }

            let content = await fs.readFile(targetPath, 'utf8');
            if (content.startsWith('\uFEFF')) {
                content = content.substring(1);
            }
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split('\n');
                const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0;
                const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
                return lines.slice(start, end).join('\n');
            } else {
                // Fast path: count newlines without splitting the entire file
                let newlineCount = 0;
                let truncateOffset = -1;
                for (let i = 0; i < content.length; i++) {
                    if (content[i] === '\n') {
                        newlineCount++;
                        if (newlineCount === 1000) {
                            truncateOffset = i + 1;
                            break;
                        }
                    }
                }
                if (truncateOffset > 0) {
                    return content.substring(0, truncateOffset) + '\n...[File truncated to 1000 lines to save context. Use startLine/endLine to read the rest.]';
                }
                return content;
            }
        } catch (error: any) {
            return `Error reading file "${relativeFilePath}": ${error.message}`;
        }
    }

    private async writeFile(relativeFilePath: string, content: string): Promise<string> {
        try {
            await this.backupFile(relativeFilePath);
            const targetPath = this.resolvePath(relativeFilePath);
            // Ensure parent directory exists
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            
            const fileUri = vscode.Uri.file(targetPath);
            const fileExists = await fs.stat(targetPath).then(() => true).catch(() => false);
            if (!fileExists) {
                await fs.writeFile(targetPath, '', 'utf8');
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
                return `File "${relativeFilePath}" written successfully.`;
            } else {
                await fs.writeFile(targetPath, content, 'utf8');
                return `File "${relativeFilePath}" written successfully (fallback).`;
            }
        } catch (error: any) {
            return `Error writing file "${relativeFilePath}": ${error.message}`;
        }
    }

    private async listDir(relativeDirPath?: string): Promise<string> {
        try {
            const resolvedPath = this.resolvePath(relativeDirPath || '.');
            const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
            
            const results = entries.map(entry => {
                const type = entry.isDirectory() ? 'dir' : 'file';
                return `[${type}] ${entry.name}`;
            });
            
            if (results.length === 0) {
                return `Directory "${relativeDirPath || '.'}" is empty.`;
            }
            return results.join('\n');
        } catch (error: any) {
            return `Error listing directory "${relativeDirPath || '.'}": ${error.message}`;
        }
    }

    private async searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }>> {
        try {
            const response = await axios.post('https://lite.duckduckgo.com/lite/', `q=${encodeURIComponent(query)}`, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 10000,
                signal: signal
            });
            const html = response.data;
            const results: Array<{ title: string; url: string; snippet: string }> = [];
            const blocks = html.split('<td class="result-snippet">');
            
            for (let i = 1; i < blocks.length; i++) {
                const prevBlock = blocks[i - 1];
                const currentBlock = blocks[i];
                
                const linkMatch = prevBlock.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
                const snippetText = currentBlock.split('</td>')[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                
                if (linkMatch) {
                    let url = linkMatch[1];
                    let title = linkMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    
                    if (url.includes('uddg=')) {
                        const uddgMatch = url.match(/uddg=([^&]+)/);
                        if (uddgMatch) {
                            url = decodeURIComponent(uddgMatch[1]);
                        }
                    }
                    
                    results.push({
                        title,
                        url,
                        snippet: snippetText
                    });
                }
                if (results.length >= 8) {
                    break;
                }
            }
            return results;
        } catch (e) {
            return [];
        }
    }

    private async searchWeb(query: string, signal?: AbortSignal): Promise<string> {
        let results: Array<{ title: string; url: string; snippet: string }> = [];
        let errorMsg = '';

        // Try Yahoo Search first
        try {
            const response = await axios.get('https://search.yahoo.com/search', {
                params: { p: query },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 8000,
                signal: signal
            });
            const html = response.data;
            const blocks = html.split('class="compTitle');
            for (let i = 1; i < blocks.length; i++) {
                const block = blocks[i].split('</li>')[0];
                const urlMatch = block.match(/href="([^"]+)"/);
                const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
                const snippetMatch = block.match(/<div class="compText[^>]*>([\s\S]*?)<\/div>/);
                
                if (urlMatch && titleMatch) {
                    let rawUrl = urlMatch[1];
                    let url = rawUrl;
                    if (url.includes('/RU=')) {
                        const parts = url.split('/RU=');
                        if (parts.length > 1) {
                            url = decodeURIComponent(parts[1].split('/RK=')[0]);
                        }
                    }
                    
                    const cleanText = (text: string) => {
                        return text
                            .replace(/<[^>]+>/g, '')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .replace(/&rsquo;/g, "'")
                            .replace(/&ldquo;/g, '"')
                            .replace(/&rdquo;/g, '"')
                            .replace(/\s+/g, ' ')
                            .trim();
                    };
                    
                    results.push({
                        title: cleanText(titleMatch[1]),
                        url: url,
                        snippet: snippetMatch ? cleanText(snippetMatch[1]) : ''
                    });
                }
                
                if (results.length >= 8) {
                    break;
                }
            }
        } catch (error: any) {
            errorMsg = `Yahoo Search error: ${error.message}. `;
        }

        // Try DuckDuckGo Lite fallback if Yahoo returned too few results or failed
        if (results.length < 3) {
            try {
                const ddgResults = await this.searchDuckDuckGo(query, signal);
                // Merge: add DuckDuckGo results that aren't already present
                const existingUrls = new Set(results.map(r => r.url));
                for (const r of ddgResults) {
                    if (!existingUrls.has(r.url)) {
                        results.push(r);
                    }
                    if (results.length >= 8) break;
                }
            } catch (ddgError: any) {
                errorMsg += `DuckDuckGo Search error: ${ddgError.message}.`;
            }
        }

        if (results.length === 0) {
            return `No search results found. ${errorMsg}`.trim();
        }
        
        return results.map((r, idx) => `${idx + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n');
    }

    private async runCommand(command: string, runInBackground?: boolean, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) {
            throw new Error('Cancelled by user');
        }
        if (runInBackground) {
            // Guard: limit concurrent background commands to prevent resource exhaustion
            if (ToolsManager.activeCommands.size >= 5) {
                return 'Error: Maximum number of background commands (5) reached. Please terminate existing commands using sendCommandInput with terminate:true before starting new ones.';
            }
            try {
                const commandId = crypto.randomBytes(4).toString('hex');
                const shell = process.platform === 'win32' ? 'powershell.exe' : true;
                const child = spawn(command, {
                    cwd: this.workspaceRoot,
                    shell: shell,
                    detached: process.platform !== 'win32'
                });

                const activeCmd = {
                    process: child,
                    outputBuffer: '',
                    exitCode: null as number | null,
                    error: undefined as string | undefined
                };

                ToolsManager.activeCommands.set(commandId, activeCmd);

                const stdoutDecoder = new StringDecoder('utf8');
                const stderrDecoder = new StringDecoder('utf8');

                child.stdout?.on('data', (data) => {
                    activeCmd.outputBuffer += stdoutDecoder.write(data);
                    if (activeCmd.outputBuffer.length > 50000) {
                        activeCmd.outputBuffer = activeCmd.outputBuffer.slice(-50000);
                    }
                });

                child.stderr?.on('data', (data) => {
                    activeCmd.outputBuffer += stderrDecoder.write(data);
                    if (activeCmd.outputBuffer.length > 50000) {
                        activeCmd.outputBuffer = activeCmd.outputBuffer.slice(-50000);
                    }
                });

                child.on('close', (code) => {
                    activeCmd.outputBuffer += stdoutDecoder.end() + stderrDecoder.end();
                    if (activeCmd.outputBuffer.length > 50000) {
                        activeCmd.outputBuffer = activeCmd.outputBuffer.slice(-50000);
                    }
                    activeCmd.exitCode = code;
                    // Auto-cleanup completed commands after 60 seconds to prevent leaks
                    setTimeout(() => {
                        if (ToolsManager.activeCommands.has(commandId)) {
                            ToolsManager.activeCommands.delete(commandId);
                        }
                    }, 60000);
                });

                child.on('error', (err) => {
                    activeCmd.error = err.message;
                    // Auto-cleanup errored commands after 60 seconds to prevent leaks
                    setTimeout(() => {
                        if (ToolsManager.activeCommands.has(commandId)) {
                            ToolsManager.activeCommands.delete(commandId);
                        }
                    }, 60000);
                });

                await sleep(500, signal);

                if (activeCmd.error) {
                    ToolsManager.activeCommands.delete(commandId);
                    return `Failed to start command: ${activeCmd.error}`;
                }

                if (activeCmd.exitCode !== null) {
                    const output = activeCmd.outputBuffer;
                    ToolsManager.activeCommands.delete(commandId);
                    return `Command finished immediately with exit code ${activeCmd.exitCode}.\nOutput:\n${output}`;
                }

                return `Command started in the background. Command ID: ${commandId}\nYou can check its progress using getCommandStatus or send input using sendCommandInput.`;
            } catch (error: any) {
                return `Failed to spawn command in background: ${error.message}`;
            }
        } else {
            try {
                const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
                const { stdout, stderr } = await execAsync(command, {
                    cwd: this.workspaceRoot,
                    shell: shell,
                    signal,
                    maxBuffer: 5 * 1024 * 1024, // 5MB max output buffer
                    timeout: 120000 // 2 minute timeout for foreground commands
                });
                let output = '';
                if (stdout) {
                    output += `stdout:\n${stdout}\n`;
                }
                if (stderr) {
                    output += `stderr:\n${stderr}\n`;
                }
                return output || 'Command ran successfully with no output.';
            } catch (error: any) {
                if (error.name === 'AbortError' || signal?.aborted) {
                    throw new Error('Cancelled by user');
                }
                return `Command failed with exit code ${error.code || 'unknown'}.\nError:\n${error.message}`;
            }
        }
    }

    private async getCommandStatus(commandId: string): Promise<string> {
        const activeCmd = ToolsManager.activeCommands.get(commandId);
        if (!activeCmd) {
            return `Error: Command ID "${commandId}" not found or has already been disposed.`;
        }

        const isRunning = activeCmd.exitCode === null && !activeCmd.error;
        const status = isRunning ? 'running' : (activeCmd.error ? 'failed' : 'done');
        
        const output = activeCmd.outputBuffer;
        activeCmd.outputBuffer = ''; 

        let response = `Command ID: ${commandId}\nStatus: ${status}\n`;
        if (activeCmd.exitCode !== null) {
            response += `Exit Code: ${activeCmd.exitCode}\n`;
        }
        if (activeCmd.error) {
            response += `Error: ${activeCmd.error}\n`;
        }
        response += `Output Log:\n${output || '(No new output)'}`;

        if (!isRunning) {
            ToolsManager.activeCommands.delete(commandId);
        }

        return response;
    }

    private async sendCommandInput(commandId: string, input?: string, terminate?: boolean): Promise<string> {
        const activeCmd = ToolsManager.activeCommands.get(commandId);
        if (!activeCmd) {
            return `Error: Command ID "${commandId}" not found or has already been disposed.`;
        }

        if (terminate) {
            try {
                if (process.platform === 'win32' && activeCmd.process.pid) {
                    try {
                        await execAsync(`taskkill /F /T /PID ${activeCmd.process.pid}`);
                    } catch (err) {
                        activeCmd.process.kill('SIGKILL');
                    }
                } else {
                    if (activeCmd.process.pid) {
                        try {
                            process.kill(-activeCmd.process.pid, 'SIGINT');
                            await new Promise(resolve => setTimeout(resolve, 500));
                            if (activeCmd.exitCode === null) {
                                process.kill(-activeCmd.process.pid, 'SIGKILL');
                            }
                        } catch (err) {
                            activeCmd.process.kill('SIGINT');
                            await new Promise(resolve => setTimeout(resolve, 500));
                            if (activeCmd.exitCode === null) {
                                activeCmd.process.kill('SIGKILL');
                            }
                        }
                    } else {
                        activeCmd.process.kill();
                    }
                }
                
                ToolsManager.activeCommands.delete(commandId);
                return `Command "${commandId}" terminated successfully.`;
            } catch (error: any) {
                return `Failed to terminate command "${commandId}": ${error.message}`;
            }
        }

        if (input !== undefined) {
            if (activeCmd.process.stdin && activeCmd.process.stdin.writable) {
                activeCmd.process.stdin.write(input);
                return `Successfully sent input to command "${commandId}".`;
            } else {
                return `Error: Command "${commandId}" stdin is not writable.`;
            }
        }

        return `No action performed. Please specify 'input' or 'terminate: true'.`;
    }

    private normalizeToDocumentLineEndings(target: string, docText: string): string {
        const hasCRLF = docText.includes('\r\n');
        if (hasCRLF) {
            return target.replace(/\r?\n/g, '\r\n');
        } else {
            return target.replace(/\r\n/g, '\n');
        }
    }

    private async replaceFileContent(relativeFilePath: string, targetContent: string, replacementContent: string): Promise<string> {
        try {
            await this.backupFile(relativeFilePath);
            const targetPath = this.resolvePath(relativeFilePath);
            const fileUri = vscode.Uri.file(targetPath);
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const content = doc.getText();
            
            const normalizedTarget = this.normalizeToDocumentLineEndings(targetContent, content);
            const normalizedReplacement = this.normalizeToDocumentLineEndings(replacementContent, content);
            
            let occurrences = 0;
            let firstOccurrenceIdx = -1;
            while (true) {
                const idx = content.indexOf(normalizedTarget, firstOccurrenceIdx === -1 ? 0 : firstOccurrenceIdx + 1);
                if (idx === -1) break;
                if (occurrences === 0) firstOccurrenceIdx = idx;
                occurrences++;
                if (occurrences > 1) break; // No need to count beyond 2
            }
            if (occurrences === 0) {
                // Check if already replaced (e.g., via streaming edits)
                if (content.includes(normalizedReplacement)) {
                    await doc.save();
                    return `File "${relativeFilePath}" updated successfully (already applied).`;
                }
                return `Error: targetContent not found in "${relativeFilePath}". Please ensure the targetContent matches exactly (including whitespaces and newlines).`;
            }
            if (occurrences > 1) {
                return `Error: targetContent found multiple times (${occurrences} occurrences) in "${relativeFilePath}". Please provide a larger block of text to uniquely identify the section to replace.`;
            }
            
            const startOffset = firstOccurrenceIdx;
            const edit = new vscode.WorkspaceEdit();
            const editRange = new vscode.Range(
                doc.positionAt(startOffset),
                doc.positionAt(startOffset + normalizedTarget.length)
            );
            edit.replace(fileUri, editRange, normalizedReplacement);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
                return `File "${relativeFilePath}" updated successfully.`;
            } else {
                const newContent = content.replace(normalizedTarget, normalizedReplacement);
                await fs.writeFile(targetPath, newContent, 'utf8');
                return `File "${relativeFilePath}" updated successfully (fallback).`;
            }
        } catch (error: any) {
            return `Error replacing content in file "${relativeFilePath}": ${error.message}`;
        }
    }

    private async multiReplaceFileContent(relativeFilePath: string, replacements: Array<{ targetContent: string; replacementContent: string }>): Promise<string> {
        try {
            await this.backupFile(relativeFilePath);
            const targetPath = this.resolvePath(relativeFilePath);
            const fileUri = vscode.Uri.file(targetPath);
            const doc = await vscode.workspace.openTextDocument(fileUri);
            let content = doc.getText();
            
            for (let i = 0; i < replacements.length; i++) {
                const { targetContent, replacementContent } = replacements[i];
                const normalizedTarget = this.normalizeToDocumentLineEndings(targetContent, content);
                const normalizedReplacement = this.normalizeToDocumentLineEndings(replacementContent, content);
                
                // Count occurrences using indexOf loop (avoids O(n*m) split allocation)
                let occurrences = 0;
                let searchFrom = 0;
                while (true) {
                    const idx = content.indexOf(normalizedTarget, searchFrom);
                    if (idx === -1) break;
                    occurrences++;
                    if (occurrences > 1) break; // No need to count beyond 2
                    searchFrom = idx + 1;
                }
                if (occurrences === 0) {
                    if (content.includes(normalizedReplacement)) {
                        continue;
                    }
                    return `Error in replacement chunk #${i + 1}: targetContent not found. Please ensure it matches exactly.`;
                }
                if (occurrences > 1) {
                    return `Error in replacement chunk #${i + 1}: targetContent found multiple times (${occurrences} occurrences). Please provide a larger, unique block of text.`;
                }
                const idx = content.indexOf(normalizedTarget);
                content = content.substring(0, idx) + normalizedReplacement + content.substring(idx + normalizedTarget.length);
            }
            
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            edit.replace(fileUri, fullRange, content);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
                return `File "${relativeFilePath}" updated successfully with ${replacements.length} replacements.`;
            } else {
                await fs.writeFile(targetPath, content, 'utf8');
                return `File "${relativeFilePath}" updated successfully with ${replacements.length} replacements (fallback).`;
            }
        } catch (error: any) {
            return `Error in multi-replace for file "${relativeFilePath}": ${error.message}`;
        }
    }

    private htmlToMarkdown(html: string): string {
        let text = html;
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
        text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
        text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
        text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
        text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
        text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
        text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
        text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
        text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
        text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
        text = text.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
        text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
        text = text.replace(/<[^>]+>/g, '\n');
        text = text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n\s*\n/g, '\n\n')
            .trim();
        return text;
    }

    private async fetchUrl(urlStr: string, signal?: AbortSignal): Promise<string> {
        try {
            new URL(urlStr);
            const response = await axios.get(urlStr, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; WindAgent/1.0)'
                },
                maxContentLength: 5 * 1024 * 1024, // 5MB limit
                maxBodyLength: 5 * 1024 * 1024,
                signal: signal
            });
            
            let data = response.data;
            if (typeof data === 'object') {
                data = JSON.stringify(data, null, 2);
            } else if (typeof data === 'string') {
                if (data.includes('<html') || data.includes('<body')) {
                    let clean = this.htmlToMarkdown(data);
                    if (clean.length > 8000) {
                        clean = clean.substring(0, 8000) + '\n\n[Content truncated due to length...]';
                    }
                    return `Fetched HTML Content (Parsed to Markdown):\n${clean}`;
                }
            }
            
            const stringResult = String(data);
            if (stringResult.length > 10000) {
                return stringResult.substring(0, 10000) + '\n\n[Content truncated due to length...]';
            }
            return stringResult;
        } catch (error: any) {
            return `Error fetching URL "${urlStr}": ${error.message}`;
        }
    }

    public async backupFile(relativeFilePath: string): Promise<void> {
        const workspaceHash = crypto.createHash('md5').update(this.workspaceRoot).digest('hex');
        const backupDir = path.join(os.tmpdir(), 'wind-backups', workspaceHash);
        const backupPath = path.join(backupDir, relativeFilePath);
        
        const currentLock = ToolsManager.backupLock;
        let resolveLock: () => void = () => {};  // Default no-op to prevent crash if Promise throws
        ToolsManager.backupLock = new Promise<void>((resolve) => {
            resolveLock = resolve;
        });

        try {
            await currentLock;
            
            // Check if backup already exists (under lock, race-free)
            try {
                await fs.access(backupPath);
                return; // Backup already exists
            } catch {}

            await fs.mkdir(path.dirname(backupPath), { recursive: true });
            const targetPath = this.resolvePath(relativeFilePath);
            
            // Read/update metadata.json
            const metadataPath = path.join(backupDir, 'metadata.json');
            let metadata: { newFiles: string[] } = { newFiles: [] };
            try {
                const metaStr = await fs.readFile(metadataPath, 'utf8');
                const parsed = JSON.parse(metaStr);
                if (parsed && typeof parsed === 'object' && Array.isArray(parsed.newFiles)) {
                    metadata = parsed;
                }
            } catch {}

            try {
                await fs.copyFile(targetPath, backupPath);
            } catch {
                // File does not exist yet (new file)
                await fs.writeFile(backupPath, '', 'utf8');
                if (metadata && metadata.newFiles && !metadata.newFiles.includes(relativeFilePath)) {
                    metadata.newFiles.push(relativeFilePath);
                }
            }

            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        } catch (err) {
            console.error('Error creating file backup:', err);
        } finally {
            resolveLock!();
        }
    }

    private async detectLocalBrowser(preferredBrowser: string): Promise<string | undefined> {
        const platform = os.platform();
        let paths: string[] = [];

        if (preferredBrowser === 'chrome') {
            if (platform === 'win32') {
                paths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
                ];
            } else if (platform === 'darwin') {
                paths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
            } else {
                paths = ['/usr/bin/google-chrome'];
            }
        } else if (preferredBrowser === 'edge') {
            if (platform === 'win32') {
                paths = [
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
                ];
            } else if (platform === 'darwin') {
                paths = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
            } else {
                paths = ['/usr/bin/microsoft-edge'];
            }
        } else if (preferredBrowser === 'firefox') {
            if (platform === 'win32') {
                paths = [
                    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
                    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
                ];
            } else if (platform === 'darwin') {
                paths = ['/Applications/Firefox.app/Contents/MacOS/firefox'];
            } else {
                paths = ['/usr/bin/firefox'];
            }
        } else {
            // 'auto'
            if (platform === 'win32') {
                paths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
                ];
            } else if (platform === 'darwin') {
                paths = [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                    '/Applications/Firefox.app/Contents/MacOS/firefox'
                ];
            } else {
                paths = [
                    '/usr/bin/google-chrome',
                    '/usr/bin/microsoft-edge',
                    '/usr/bin/chromium',
                    '/usr/bin/chromium-browser',
                    '/usr/bin/firefox'
                ];
            }
        }

        for (const p of paths) {
            if (!p) {
                continue;
            }
            try {
                await fs.access(p);
                return p;
            } catch {
                // Not found, continue
            }
        }
        return undefined;
    }

    private async runAgentVisualEffect(selector: string, type: 'click' | 'type', text?: string): Promise<boolean> {
        if (!ToolsManager.page) return false;
        try {
            await ToolsManager.page.waitForSelector(selector, { timeout: 10000 });
            
            // Find element and get its coordinates
            const coordinates = await ToolsManager.page.evaluate((sel, txt) => {
                let el: Element | null = null;
                if (txt) {
                    const elements = Array.from(document.querySelectorAll(sel));
                    for (const element of elements) {
                        if ((element.textContent || '').toLowerCase().includes(txt.toLowerCase())) {
                            el = element;
                            break;
                        }
                    }
                } else {
                    el = document.querySelector(sel);
                }

                if (!el) return null;

                // Scroll into view
                el.scrollIntoView({ block: 'center', inline: 'center' });
                const rect = el.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                };
            }, selector, text);

            if (!coordinates) return false;

            // Trigger the custom cursor movement and ripple animations
            await ToolsManager.page.evaluate(async (coords, actType) => {
                if (typeof (window as any).__windAgentShowEffect === 'function') {
                    await (window as any).__windAgentShowEffect(coords.x, coords.y, actType);
                }
            }, coordinates, type);

            // Highlight the element
            await ToolsManager.page.evaluate((sel, txt) => {
                let el: Element | null = null;
                if (txt) {
                    const elements = Array.from(document.querySelectorAll(sel));
                    for (const element of elements) {
                        if ((element.textContent || '').toLowerCase().includes(txt.toLowerCase())) {
                            el = element;
                            break;
                        }
                    }
                } else {
                    el = document.querySelector(sel);
                }
                if (el && typeof (window as any).__windAgentHighlightElement === 'function') {
                    (window as any).__windAgentHighlightElement(el, 1500);
                }
            }, selector, text);

            // Wait a brief moment for visual clarity
            await new Promise(resolve => setTimeout(resolve, 300));
            return true;
        } catch (e) {
            console.error('Failed to run agent visual effect:', e);
            return false;
        }
    }

    private async browserOpen(url: string, headless?: boolean): Promise<string> {
        try {
            const isHeadless = headless === undefined ? false : headless;
            const config = vscode.workspace.getConfiguration('windAgent');
            const preferredBrowser = config.get<string>('browser') || 'auto';
            const executablePath = await this.detectLocalBrowser(preferredBrowser);

            if (preferredBrowser !== 'auto' && !executablePath) {
                return `Error opening browser: Could not find executable for preferred browser "${preferredBrowser}". Please make sure it is installed or change the setting to "auto".`;
            }

            if (!ToolsManager.browser) {
                const launchOptions: any = {
                    headless: isHeadless,
                    defaultViewport: null,
                    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
                    ignoreDefaultArgs: ['--enable-automation']
                };
                if (executablePath) {
                    launchOptions.executablePath = executablePath;
                }

                ToolsManager.browser = await puppeteer.launch(launchOptions);
                const pages = await ToolsManager.browser.pages();
                ToolsManager.page = pages.length > 0 ? pages[0] : await ToolsManager.browser.newPage();
            } else {
                try {
                    await ToolsManager.browser.version();
                } catch {
                    const launchOptions: any = {
                        headless: isHeadless,
                        defaultViewport: null,
                        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
                        ignoreDefaultArgs: ['--enable-automation']
                    };
                    if (executablePath) {
                        launchOptions.executablePath = executablePath;
                    }

                    ToolsManager.browser = await puppeteer.launch(launchOptions);
                    const pages = await ToolsManager.browser.pages();
                    ToolsManager.page = pages.length > 0 ? pages[0] : await ToolsManager.browser.newPage();
                }
            }

            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                ToolsManager.page = await ToolsManager.browser.newPage();
            }

            // Setup injection for any future navigations
            await ToolsManager.page.evaluateOnNewDocument((css, js) => {
                const inject = () => {
                    if (document.getElementById('wind-agent-style')) return;
                    
                    const style = document.createElement('style');
                    style.id = 'wind-agent-style';
                    style.textContent = css;
                    (document.head || document.documentElement).appendChild(style);

                    const script = document.createElement('script');
                    script.id = 'wind-agent-script';
                    script.textContent = js;
                    (document.head || document.documentElement).appendChild(script);

                    const border = document.createElement('div');
                    border.id = 'wind-agent-border';
                    (document.body || document.documentElement).appendChild(border);
                };

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', inject);
                } else {
                    inject();
                }
            }, AGENT_EFFECT_CSS, AGENT_EFFECT_JS);

            await ToolsManager.page.goto(url, { waitUntil: 'load', timeout: 30000 });

            // Inject immediately into the current page context
            await ToolsManager.page.evaluate((css, js) => {
                if (document.getElementById('wind-agent-style')) return;
                
                const style = document.createElement('style');
                style.id = 'wind-agent-style';
                style.textContent = css;
                (document.head || document.documentElement).appendChild(style);

                const script = document.createElement('script');
                script.id = 'wind-agent-script';
                script.textContent = js;
                (document.head || document.documentElement).appendChild(script);

                const border = document.createElement('div');
                border.id = 'wind-agent-border';
                (document.body || document.documentElement).appendChild(border);
            }, AGENT_EFFECT_CSS, AGENT_EFFECT_JS);

            await this.triggerScreenshotCapture();
            return `Successfully opened browser (${executablePath ? 'using ' + preferredBrowser + ' (' + path.basename(executablePath) + ')' : 'using bundled Chromium'}) and navigated to ${url}`;
        } catch (error: any) {
            return `Error opening browser: ${error.message}`;
        }
    }

    private async browserClick(selector: string, text?: string): Promise<string> {
        try {
            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                return `Error: No active browser page found. Please call browserOpen first.`;
            }

            await this.runAgentVisualEffect(selector, 'click', text);

            if (text) {
                const elements = await ToolsManager.page.$$(selector);
                let clicked = false;
                for (const el of elements) {
                    const elText = await ToolsManager.page.evaluate((element: any) => element.textContent || '', el);
                    if (elText.toLowerCase().includes(text.toLowerCase())) {
                        await el.click();
                        clicked = true;
                        break;
                    }
                }
                if (!clicked) {
                    return `Error: Element matching "${selector}" containing text "${text}" was not found.`;
                }
                await this.triggerScreenshotCapture();
                return `Successfully clicked element matching selector "${selector}" with text "${text}"`;
            } else {
                await ToolsManager.page.waitForSelector(selector, { timeout: 10000 });
                await ToolsManager.page.click(selector);
                await this.triggerScreenshotCapture();
                return `Successfully clicked element matching selector "${selector}"`;
            }
        } catch (error: any) {
            return `Error clicking element: ${error.message}`;
        }
    }

    private async browserType(selector: string, text: string): Promise<string> {
        try {
            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                return `Error: No active browser page found. Please call browserOpen first.`;
            }

            await this.runAgentVisualEffect(selector, 'type');

            await ToolsManager.page.waitForSelector(selector, { timeout: 10000 });
            await ToolsManager.page.focus(selector);
            
            await ToolsManager.page.keyboard.down('Control');
            await ToolsManager.page.keyboard.press('A');
            await ToolsManager.page.keyboard.up('Control');
            await ToolsManager.page.keyboard.press('Backspace');

            await ToolsManager.page.type(selector, text, { delay: 50 });
            await this.triggerScreenshotCapture();
            return `Successfully typed "${text}" into element "${selector}"`;
        } catch (error: any) {
            return `Error typing into element: ${error.message}`;
        }
    }

    private async browserGetContent(type?: 'text' | 'html'): Promise<string> {
        try {
            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                return `Error: No active browser page found. Please call browserOpen first.`;
            }

            const contentType = type || 'text';
            if (contentType === 'html') {
                const html = await ToolsManager.page.content();
                return html;
            } else {
                const text = await ToolsManager.page.evaluate(() => document.body.innerText || '');
                return text;
            }
        } catch (error: any) {
            return `Error getting page content: ${error.message}`;
        }
    }

    private async browserScreenshot(relativeFilePath: string): Promise<string> {
        try {
            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                return `Error: No active browser page found. Please call browserOpen first.`;
            }

            const targetPath = this.resolvePath(relativeFilePath);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            
            await ToolsManager.page.screenshot({
                path: targetPath,
                fullPage: true
            });
            return `Successfully saved page screenshot to "${relativeFilePath}"`;
        } catch (error: any) {
            return `Error taking screenshot: ${error.message}`;
        }
    }

    private async browserClose(): Promise<string> {
        try {
            if (ToolsManager.browser) {
                await ToolsManager.browser.close();
                ToolsManager.browser = null;
                ToolsManager.page = null;
                return `Browser session closed successfully.`;
            }
            return `No active browser session to close.`;
        } catch (error: any) {
            ToolsManager.browser = null;
            ToolsManager.page = null;
            return `Error closing browser: ${error.message}`;
        }
    }

    private async gitGrepSearch(query: string, targetPath: string, isRegex?: boolean, signal?: AbortSignal): Promise<Array<{ file: string; line: number; text: string }> | null> {
        try {
            const relativeDir = path.relative(this.workspaceRoot, targetPath) || '.';
            const gitArgs = ['grep', '-n', '-I', '--no-color', '--untracked'];
            if (!isRegex) {
                gitArgs.push('-F');
            }
            gitArgs.push('-e', query, '--', relativeDir);

            return await new Promise<Array<{ file: string; line: number; text: string }> | null>((resolve) => {
                const child = spawn('git', gitArgs, { cwd: this.workspaceRoot });
                let stdout = '';
                let stderr = '';
                
                let abortHandler: (() => void) | undefined;
                if (signal) {
                    abortHandler = () => {
                        child.kill();
                    };
                    signal.addEventListener('abort', abortHandler);
                }

                const cleanup = () => {
                    if (signal && abortHandler) {
                        signal.removeEventListener('abort', abortHandler);
                    }
                };

                child.stdout?.on('data', (data) => { stdout += data.toString(); });
                child.stderr?.on('data', (data) => { stderr += data.toString(); });
                
                child.on('close', (code) => {
                    cleanup();
                    if (code === 0) {
                        const lines = stdout.split(/\r?\n/);
                        const matches: Array<{ file: string; line: number; text: string }> = [];
                        for (const line of lines) {
                            if (!line) continue;
                            const parts = line.split(':');
                            if (parts.length >= 3) {
                                const relFile = parts[0];
                                const lineNum = parseInt(parts[1], 10);
                                const text = parts.slice(2).join(':');
                                const absFile = path.resolve(this.workspaceRoot, relFile);
                                matches.push({
                                    file: absFile,
                                    line: lineNum,
                                    text: text.trim().substring(0, 200)
                                });
                            }
                            if (matches.length >= 100) {
                                break;
                            }
                        }
                        resolve(matches);
                    } else if (code === 1) {
                        resolve([]);
                    } else {
                        resolve(null);
                    }
                });
                
                child.on('error', () => {
                    cleanup();
                    resolve(null);
                });
            });
        } catch (e) {
            return null;
        }
    }

    private async localGrepSearch(query: string, targetPath: string, isRegex?: boolean, signal?: AbortSignal): Promise<Array<{ file: string; line: number; text: string }>> {
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const MAX_MATCHES = 100;
        const regex = isRegex ? new RegExp(query, 'i') : null;
        const visited = new Set<string>();
        const fileLimiter = new ConcurrencyLimiter(30);
        const skipDirs = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.nuxt', 'build', 'target', '.venv', 'venv', 'env', 'bin', 'obj']);

        // Iterative BFS queue of directories to process
        const queue: string[] = [targetPath];

        while (queue.length > 0) {
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            if (matches.length >= MAX_MATCHES) {
                break;
            }

            const currentDir = queue.shift()!;
            let realDir: string;
            try {
                realDir = await fs.realpath(currentDir);
            } catch (e) {
                continue;
            }

            const normalizedRoot = path.resolve(this.workspaceRoot);
            const relative = path.relative(normalizedRoot.toLowerCase(), realDir.toLowerCase());
            // Security boundary check
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                continue;
            }

            if (visited.has(realDir)) {
                continue;
            }
            visited.add(realDir);

            let entries: any[];
            try {
                entries = await fs.readdir(currentDir, { withFileTypes: true });
            } catch (e) {
                continue;
            }

            const fileTasks: Promise<void>[] = [];

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    if (!skipDirs.has(entry.name)) {
                        queue.push(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (BINARY_EXTS.has(ext)) {
                        continue;
                    }

                    fileTasks.push(fileLimiter.run(async () => {
                        if (signal?.aborted || matches.length >= MAX_MATCHES) return;
                        try {
                            const stats = await fs.stat(fullPath);
                            if (stats.size > 1024 * 1024) { // Skip files larger than 1MB
                                return;
                            }

                            const content = await fs.readFile(fullPath, 'utf8');
                            const hasMatch = regex ? regex.test(content) : content.includes(query);
                            if (!hasMatch) {
                                return;
                            }

                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (matches.length >= MAX_MATCHES) break;
                                const lineText = lines[i];
                                const isMatched = regex ? regex.test(lineText) : lineText.includes(query);
                                if (isMatched) {
                                    matches.push({
                                        file: fullPath,
                                        line: i + 1,
                                        text: lineText.trim().substring(0, 200)
                                    });
                                }
                            }
                        } catch (e) {
                            // ignore unreadable/binary files
                        }
                    }));
                }
            }

            if (fileTasks.length > 0) {
                await Promise.all(fileTasks);
            }
        }

        return matches;
    }

    private async grepSearch(query: string, relativeDirPath: string, isRegex?: boolean, signal?: AbortSignal): Promise<string> {
        try {
            const targetPath = this.resolvePath(relativeDirPath || '.');
            let matches = await this.gitGrepSearch(query, targetPath, isRegex, signal);
            if (matches === null) {
                matches = await this.localGrepSearch(query, targetPath, isRegex, signal);
            }
            if (matches.length === 0) return "No results found.";
            
            // Group matches by file for better readability
            const grouped = new Map<string, Array<{ line: number; text: string }>>();
            for (const m of matches) {
                const relPath = path.relative(this.workspaceRoot, m.file);
                if (!grouped.has(relPath)) {
                    grouped.set(relPath, []);
                }
                grouped.get(relPath)!.push({ line: m.line, text: m.text });
            }
            
            let result = `Found ${matches.length} match(es) in ${grouped.size} file(s):\n`;
            for (const [filePath, fileMatches] of grouped) {
                result += `\n${filePath}:\n`;
                for (const m of fileMatches) {
                    result += `  L${m.line}: ${m.text}\n`;
                }
            }
            if (matches.length >= 100) {
                result += '\n...[Results truncated to 100 matches. Narrow your query for more specific results.]';
            }
            return result;
        } catch (error: any) {
            return `grepSearch failed: ${error.message}`;
        }
    }

    private async generateImage(prompt: string, relativeFilePath: string): Promise<string> {
        try {
            const targetPath = this.resolvePath(relativeFilePath);
            // Ensure directory exists
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
            let response;
            try {
                response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
            } catch (pollinationsError: any) {
                // Fallback to high quality Picsum placeholder
                const fallbackUrl = `https://picsum.photos/1024/768`;
                response = await axios.get(fallbackUrl, { responseType: 'arraybuffer', timeout: 15000 });
            }
            
            await fs.writeFile(targetPath, Buffer.from(response.data));
            return `Image successfully generated for prompt "${prompt}" and saved to "${relativeFilePath}"`;
        } catch (error: any) {
            return `generateImage failed: ${error.message}`;
        }
    }

    private async browserSubagent(task: string, url: string, signal?: AbortSignal): Promise<string> {
        let log = `[browserSubagent] Starting subagent task: "${task}" at URL: ${url}\n`;
        
        try {
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                log += `Browser not open or tab was closed. Launching browser and navigating to ${url}...\n`;
                const openRes = await this.browserOpen(url);
                log += `${openRes}\n`;
            } else {
                log += `Navigating to ${url}...\n`;
                await ToolsManager.page.goto(url, { waitUntil: 'load', timeout: 30000 });
                await this.triggerScreenshotCapture();
            }
            
            const maxSteps = 6;
            let currentUrl = url;
            
            for (let step = 1; step <= maxSteps; step++) {
                if (signal?.aborted) {
                    throw new Error('Cancelled by user');
                }
                if (!ToolsManager.page || ToolsManager.page.isClosed()) {
                    throw new Error('Browser page was closed unexpectedly.');
                }
                
                const pageTextRaw = await ToolsManager.page.evaluate(() => document.body.innerText || '');
                const pageText = pageTextRaw.substring(0, 3000);
                
                currentUrl = ToolsManager.page.url();
                
                 const subagentSystemPrompt = `You are a Browser Subagent tasked with executing a sub-step of a programming agent.
Your overall goal is to accomplish this task: "${task}".
You are currently on the page: ${currentUrl}.
 
Available Actions:
1. Click: {"action": "click", "selector": "CSS selector", "text": "optional text to find within selector elements"}
2. Type: {"action": "type", "selector": "CSS selector", "text": "text to type"}
3. Scroll: {"action": "scroll", "direction": "up" or "down"}
4. Wait: {"action": "wait", "ms": milliseconds}
5. Success: {"action": "success", "message": "describe what you accomplished"}
6. Fail: {"action": "fail", "reason": "describe why you could not proceed"}
7. Do not repeat the exact same action on the same page state. If an action does not change the page or state, try another element/selector or declare failure using the "fail" action.
 
You MUST output your next action as a valid JSON object matching the action schema above, wrapped in a markdown code block:
\`\`\`json
{
  "action": "actionName",
  ...
}
\`\`\`
Do NOT choose more than one action at a time. Explain your reasoning briefly before the JSON block if you want.`;
 
                log += `\n--- Subagent Step ${step}/${maxSteps} ---\n`;
                
                const endpointUrl = `${this.endpoint.replace(/\/+$/, '')}/chat/completions`;
                // Use proper key rotation
                const keys = Array.isArray(this.apiKey) ? this.apiKey : (this.apiKey ? [this.apiKey] : []);
                const currentKeyIdx = step % Math.max(keys.length, 1);
                const currentKey = keys.length > 0 ? keys[currentKeyIdx] : '';
                const headers: any = { 'Content-Type': 'application/json' };
                if (currentKey) {
                    headers['Authorization'] = `Bearer ${currentKey}`;
                }
                
                const body = {
                    model: this.model,
                    messages: [
                        { role: 'system', content: subagentSystemPrompt },
                        { role: 'user', content: `Current URL: ${currentUrl}\n\nPage text content (first 3000 chars):\n${pageText}\n\nPlease choose your next action.` }
                    ],
                    temperature: 0.1
                };
                
                const res = await axios.post(endpointUrl, body, { headers, timeout: 20000, signal });
                const content = res.data?.choices?.[0]?.message?.content || '';
                
                const jsonMatch = content.match(/```json\n([\s\S]*?)```/) || content.match(/\{[\s\S]*?"action"\s*:\s*"[\s\S]*?\}/);
                if (!jsonMatch) {
                    log += `Error: LLM output could not be parsed as action JSON. Output: ${content}\n`;
                    continue;
                }
                
                let actionObj: any;
                try {
                    actionObj = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                } catch (e: any) {
                    log += `Error parsing action JSON: ${e.message}. Raw: ${jsonMatch[1] || jsonMatch[0]}\n`;
                    continue;
                }
                
                log += `Decided Action: ${JSON.stringify(actionObj)}\n`;
                
                if (actionObj.action === 'success') {
                    log += `Subagent succeeded: ${actionObj.message}\n`;
                    return log;
                } else if (actionObj.action === 'fail') {
                    log += `Subagent failed: ${actionObj.reason}\n`;
                    return log;
                } else if (actionObj.action === 'click') {
                    const clickRes = await this.browserClick(actionObj.selector, actionObj.text);
                    log += `Action Result: ${clickRes}\n`;
                } else if (actionObj.action === 'type') {
                    const typeRes = await this.browserType(actionObj.selector, actionObj.text);
                    log += `Action Result: ${typeRes}\n`;
                } else if (actionObj.action === 'scroll') {
                    const dir = actionObj.direction === 'up' ? -400 : 400;
                    await ToolsManager.page.evaluate((d) => window.scrollBy(0, d), dir);
                    await this.triggerScreenshotCapture();
                    log += `Action Result: Scrolled ${actionObj.direction}\n`;
                } else if (actionObj.action === 'wait') {
                    const waitMs = actionObj.ms || 1000;
                    await sleep(waitMs, signal);
                    log += `Action Result: Waited ${waitMs}ms\n`;
                } else {
                    log += `Action Result: Unknown action "${actionObj.action}"\n`;
                }
                
                await sleep(1000, signal);

                // Check for cancellation after each action to enable faster abort
                if (signal?.aborted) {
                    throw new Error('Cancelled by user');
                }
            }
            
            log += `\nSubagent finished: Reached maximum step limit of ${maxSteps} without resolving success/fail.\n`;
            return log;
        } catch (error: any) {
            log += `\nSubagent encountered error: ${error.message}\n`;
            return log;
        }
    }

    private async runTerminalCommand(command: string): Promise<string> {
        try {
            let terminal = vscode.window.terminals.find(t => t.name === 'Wind Agent Terminal');
            if (!terminal) {
                terminal = vscode.window.createTerminal('Wind Agent Terminal');
            }
            terminal.show(true);
            terminal.sendText(command);
            return `Successfully sent command "${command}" to Wind Agent Terminal panel.`;
        } catch (error: any) {
            return `Failed to run command in VS Code Terminal: ${error.message}`;
        }
    }

    private async gitStatus(): Promise<string> {
        try {
            const { stdout, stderr } = await execAsync('git status', { cwd: this.workspaceRoot, maxBuffer: 5 * 1024 * 1024, timeout: 15000 });
            return stdout || stderr || 'git status returned no output.';
        } catch (error: any) {
            return `git status failed: ${error.message}`;
        }
    }

    private async gitDiff(staged?: boolean): Promise<string> {
        try {
            const cmd = staged ? 'git diff --cached' : 'git diff';
            const { stdout, stderr } = await execAsync(cmd, { cwd: this.workspaceRoot, maxBuffer: 5 * 1024 * 1024, timeout: 15000 });
            return stdout || stderr || 'No changes detected.';
        } catch (error: any) {
            return `git diff failed: ${error.message}`;
        }
    }

    private async gitAdd(filePattern: string): Promise<string> {
        try {
            // Use spawn with args array to prevent shell injection
            return await new Promise<string>((resolve) => {
                const child = spawn('git', ['add', filePattern], { cwd: this.workspaceRoot });
                let output = '';
                
                const timeoutTimer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve(`git add timed out after 15 seconds.`);
                }, 15000);

                child.stdout?.on('data', (data) => { output += data.toString(); });
                child.stderr?.on('data', (data) => { output += data.toString(); });
                child.on('close', (code) => {
                    clearTimeout(timeoutTimer);
                    if (code === 0) {
                        resolve(`Successfully staged changes for "${filePattern}".`);
                    } else {
                        resolve(`git add failed with code ${code}: ${output}`);
                    }
                });
                child.on('error', (err) => {
                    clearTimeout(timeoutTimer);
                    resolve(`git add failed: ${err.message}`);
                });
            });
        } catch (error: any) {
            return `git add failed: ${error.message}`;
        }
    }

    private async gitCommit(message: string): Promise<string> {
        try {
            // Use spawn with args array to prevent shell injection
            return await new Promise<string>((resolve) => {
                const child = spawn('git', ['commit', '-m', message], { cwd: this.workspaceRoot });
                let output = '';

                const timeoutTimer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve(`git commit timed out after 15 seconds.`);
                }, 15000);

                child.stdout?.on('data', (data) => { output += data.toString(); });
                child.stderr?.on('data', (data) => { output += data.toString(); });
                child.on('close', (code) => {
                    clearTimeout(timeoutTimer);
                    if (code === 0) {
                        resolve(`Successfully committed staged changes with message: "${message}"`);
                    } else {
                        resolve(`git commit failed with code ${code}: ${output}`);
                    }
                });
                child.on('error', (err) => {
                    clearTimeout(timeoutTimer);
                    resolve(`git commit failed: ${err.message}`);
                });
            });
        } catch (error: any) {
            return `git commit failed: ${error.message}`;
        }
    }

    private async searchWorkspaceSymbols(query: string): Promise<string> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                query
            );
            if (!symbols || symbols.length === 0) {
                return `No symbols found for query "${query}".`;
            }
            const formatted = symbols.map(s => {
                const type = vscode.SymbolKind[s.kind] || 'Unknown';
                const file = vscode.workspace.asRelativePath(s.location.uri);
                const line = s.location.range.start.line + 1;
                return `[${type}] ${s.name} (File: ${file}, Line: ${line})`;
            });
            if (formatted.length > 50) {
                return formatted.slice(0, 50).join('\n') + `\n\n...[Warning: Too many symbols. Showing first 50 of ${formatted.length}]`;
            }
            return formatted.join('\n');
        } catch (error: any) {
            return `Workspace symbols search failed: ${error.message}`;
        }
    }

    private async getEmbedding(text: string, signal?: AbortSignal): Promise<number[]> {
        const keys = Array.isArray(this.apiKey) ? this.apiKey : (this.apiKey ? [this.apiKey] : []);
        if (keys.length === 0) {
            throw new Error('API Key is not configured. Please configure your apiKey in windAgent extension settings.');
        }
        
        const isGemini = this.endpoint.includes('googleapis.com') || this.endpoint.includes('generativelanguage');
        let lastError: any = null;

        for (let attempt = 0; attempt < keys.length; attempt++) {
            const currentKey = keys[attempt];
            try {
                if (isGemini) {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${currentKey}`;
                    const response = await axios.post(url, {
                        content: {
                            parts: [{ text: text }]
                        }
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000,
                        signal
                    });
                    if (response.data?.embedding?.values) {
                        return response.data.embedding.values;
                    }
                    throw new Error('Invalid embedding response from Gemini API');
                } else {
                    const url = `${this.endpoint.replace(/\/+$/, '')}/embeddings`;
                    const response = await axios.post(url, {
                        input: text,
                        model: 'text-embedding-3-small'
                    }, {
                        headers: {
                            'Authorization': `Bearer ${currentKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000,
                        signal
                    });
                    if (response.data?.data?.[0]?.embedding) {
                        return response.data.data[0].embedding;
                    }
                    throw new Error('Invalid embedding response from OpenAI compatible API');
                }
            } catch (err: any) {
                lastError = err;
            }
        }
        throw lastError || new Error('All API Keys failed for embedding generation.');
    }

    private async searchSemanticCode(query: string, signal?: AbortSignal): Promise<string> {
        try {
            const kiDir = path.join(this.workspaceRoot, '.vscode');
            const dbPath = path.join(kiDir, 'wind-embeddings.json');
            
            // 1. Load existing database or initialize a new one
            let db: {
                files: Record<string, {
                    mtime: number;
                    chunks: Array<{ text: string; embedding: number[] }>;
                }>
            } = { files: {} };
            
            try {
                const exists = await fs.access(dbPath).then(() => true).catch(() => false);
                if (exists) {
                    const data = await fs.readFile(dbPath, 'utf8');
                    db = JSON.parse(data);
                }
            } catch (e) {
                console.error('Failed to read wind-embeddings.json:', e);
            }
            
            if (!db.files) {
                db.files = {};
            }

            // 2. Find all files in the workspace
            const uris = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode/**,**/bin/**,**/obj/**,**/build/**,**/.next/**,**/target/**,**/.venv/**,**/venv/**,**/env/**,**/.idea/**,**/.cache/**,**/.nuxt/**}'
            );
            
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            
            // Filter indexable files (limit to 150 early to save CPU/memory)
            const indexableFiles: vscode.Uri[] = [];
            const CONCURRENCY_LIMIT = 10;
            for (let i = 0; i < uris.length && indexableFiles.length < 150; i += CONCURRENCY_LIMIT) {
                if (signal?.aborted) {
                    throw new Error('Cancelled by user');
                }
                const chunk = uris.slice(i, i + CONCURRENCY_LIMIT);
                await Promise.all(chunk.map(async (uri) => {
                    const ext = path.extname(uri.fsPath).toLowerCase();
                    if (BINARY_EXTS.has(ext)) return;
                    try {
                        const stats = await fs.stat(uri.fsPath);
                        if (stats.isFile() && stats.size <= 100 * 1024) {
                            if (indexableFiles.length < 150) {
                                indexableFiles.push(uri);
                            }
                        }
                    } catch (e) {}
                }));
            }
            const filesToProcess = indexableFiles;
            
            let updated = false;
            let newlyIndexedCount = 0;
            const embeddingLimiter = new ConcurrencyLimiter(5);
            const fileTasks = filesToProcess.map(async (uri) => {
                if (signal?.aborted) return;
                const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                try {
                    const stats = await fs.stat(uri.fsPath);
                    const mtime = stats.mtimeMs;
                    
                    const cached = db.files[relPath];
                    if (cached && cached.mtime === mtime) {
                        return; // Already indexed and not modified
                    }
                    if (signal?.aborted) return;
                    
                    // Read and chunk file
                    const content = await fs.readFile(uri.fsPath, 'utf8');
                    const chunks = chunkText(content, 1500, 200).slice(0, 10); // Limit to 10 chunks per file
                    const chunkEmbeddings: Array<{ text: string; embedding: number[] }> = [];
                    
                    await Promise.all(chunks.map(async (chunk) => {
                        if (signal?.aborted) return;
                        try {
                            const embedding = await embeddingLimiter.run(() => this.getEmbedding(chunk, signal));
                            chunkEmbeddings.push({
                                text: chunk,
                                embedding: embedding
                            });
                            newlyIndexedCount++;
                        } catch (err: any) {
                            console.error(`Failed to get embedding for chunk in ${relPath}:`, err.message);
                        }
                    }));
                    
                    db.files[relPath] = {
                        mtime: mtime,
                        chunks: chunkEmbeddings
                    };
                    updated = true;
                } catch (e) {
                    console.error(`Failed to index file ${relPath}:`, e);
                }
            });

            await Promise.all(fileTasks);
            if (signal?.aborted) {
                throw new Error('Cancelled by user');
            }
            
            // 3. Save database if updated
            if (updated) {
                try {
                    await fs.mkdir(kiDir, { recursive: true });
                    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
                } catch (e) {
                    console.error('Failed to write wind-embeddings.json:', e);
                }
            }
            
            // 4. Compute embedding for the search query
            const queryEmbedding = await this.getEmbedding(query, signal);
            
            // 5. Compute cosine similarities
            const results: Array<{
                filePath: string;
                text: string;
                similarity: number;
            }> = [];
            
            for (const [relPath, fileData] of Object.entries(db.files)) {
                for (const chunk of fileData.chunks) {
                    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
                    results.push({
                        filePath: relPath,
                        text: chunk.text,
                        similarity: sim
                    });
                }
            }
            
            // 6. Sort results and take top 5
            results.sort((a, b) => b.similarity - a.similarity);
            const topResults = results.slice(0, 5);
            
            if (topResults.length === 0) {
                return `No matching semantic results found for: "${query}"`;
            }
            
            let response = `🔍 **Semantic Search Results for: "${query}"**\n`;
            if (newlyIndexedCount > 0) {
                response += `*(Indexed/Updated ${newlyIndexedCount} code chunks in this run)*\n`;
            }
            response += `\n`;
            
            topResults.forEach((res, index) => {
                response += `### [${index + 1}] File: [${res.filePath}](file:///${path.join(this.workspaceRoot, res.filePath).replace(/\\/g, '/')}) (Score: ${res.similarity.toFixed(4)})\n`;
                response += `\`\`\`\n${res.text}\n\`\`\`\n\n`;
            });
            
            return response;
        } catch (error: any) {
            return `Error performing semantic search: ${error.message}`;
        }
    }
}

function chunkText(text: string, chunkSize: number = 1500, overlap: number = 200): string[] {
    const chunks: string[] = [];
    let start = 0;
    const step = Math.max(1, chunkSize - overlap);
    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);
        chunks.push(text.substring(start, end));
        if (end === text.length) break;
        start += step;
    }
    return chunks;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
