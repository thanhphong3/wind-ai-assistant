import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

export interface McpTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

export class McpClient {
    private process?: ChildProcess;
    private reader?: readline.Interface;
    private nextId = 1;
    private pendingRequests = new Map<number | string, {
        resolve: (res: any) => void;
        reject: (err: any) => void;
        method: string;
    }>();
    public tools: McpTool[] = [];
    public name: string;

    constructor(name: string, private config: McpServerConfig, private workspaceRoot: string) {
        this.name = name;
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const env = { ...process.env, ...(this.config.env || {}) };
                this.process = spawn(this.config.command, this.config.args || [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                    cwd: this.workspaceRoot,
                    shell: process.platform === 'win32'
                });

                this.process.on('error', (err) => {
                    console.error(`[MCP Client] ${this.name} spawn error:`, err);
                    reject(err);
                });

                this.process.stderr?.on('data', (data) => {
                    console.warn(`[MCP Client stderr - ${this.name}] ${data.toString().trim()}`);
                });

                this.process.on('exit', (code, signal) => {
                    console.log(`[MCP Client] ${this.name} exited with code ${code}, signal ${signal}`);
                    this.cleanup(new Error(`MCP server ${this.name} exited`));
                });

                this.reader = readline.createInterface({
                    input: this.process.stdout!,
                    terminal: false
                });

                this.reader.on('line', (line) => {
                    this.handleIncomingLine(line);
                });

                // Perform handshake
                this.initializeHandshake().then(resolve).catch(reject);

            } catch (e) {
                reject(e);
            }
        });
    }

    private cleanup(error: Error) {
        for (const [, { reject }] of this.pendingRequests.entries()) {
            reject(error);
        }
        this.pendingRequests.clear();
        this.process = undefined;
        this.reader = undefined;
    }

    private handleIncomingLine(line: string) {
        try {
            const message = JSON.parse(line.trim());
            if (message.jsonrpc !== '2.0') return;

            // Handle Response
            if (message.id !== undefined) {
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    this.pendingRequests.delete(message.id);
                    if (message.error) {
                        pending.reject(new Error(message.error.message || `JSON-RPC error in ${pending.method}`));
                    } else {
                        pending.resolve(message.result);
                    }
                }
            } else {
                // Notifications or requests from server
                console.log(`[MCP Client notification - ${this.name}]`, message);
            }
        } catch (e) {
            console.error(`[MCP Client] Failed to parse JSON line from server ${this.name}:`, line, e);
        }
    }

    private sendRequest(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin || this.process.killed) {
                return reject(new Error(`MCP server ${this.name} is not connected`));
            }
            const id = this.nextId++;
            const message = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };
            this.pendingRequests.set(id, { resolve, reject, method });
            this.process.stdin.write(JSON.stringify(message) + '\n');
        });
    }

    private sendNotification(method: string, params: any = {}): void {
        if (!this.process || !this.process.stdin || this.process.killed) return;
        const message = {
            jsonrpc: '2.0',
            method,
            params
        };
        this.process.stdin.write(JSON.stringify(message) + '\n');
    }

    private async initializeHandshake(): Promise<void> {
        await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'wind-agent',
                version: '1.0.0'
            }
        });
        
        this.sendNotification('notifications/initialized');
        await this.refreshTools();
    }

    async refreshTools(): Promise<void> {
        const result = await this.sendRequest('tools/list');
        const rawTools = result.tools || [];
        this.tools = rawTools.map((t: any) => ({
            name: t.name,
            description: t.description || '',
            parameters: t.inputSchema || { type: 'object', properties: {}, required: [] }
        }));
    }

    async callTool(name: string, args: any): Promise<any> {
        return await this.sendRequest('tools/call', {
            name,
            arguments: args
        });
    }

    async disconnect() {
        if (this.process) {
            this.process.removeAllListeners('exit');
            this.process.kill();
            this.cleanup(new Error('Disconnected'));
        }
    }
}

export class McpManager {
    private clients: Map<string, McpClient> = new Map();
    private toolToClientMap: Map<string, string> = new Map(); // toolName -> clientName
    private workspaceRoot: string;
    private initPromise: Promise<void> | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    async initialize(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = (async () => {
            const configs = await this.loadConfigs();
            for (const [name, config] of Object.entries(configs)) {
                try {
                    console.log(`[MCP Manager] Connecting to server: ${name}...`);
                    const client = new McpClient(name, config, this.workspaceRoot);
                    await client.connect();
                    this.clients.set(name, client);
                    
                    for (const tool of client.tools) {
                        this.toolToClientMap.set(tool.name, name);
                    }
                    console.log(`[MCP Manager] Connected to server: ${name}. Registered ${client.tools.length} tools.`);
                } catch (e: any) {
                    console.error(`[MCP Manager] Failed to connect to server "${name}":`, e.message);
                }
            }
        })();

        return this.initPromise;
    }

    private async loadConfigs(): Promise<Record<string, McpServerConfig>> {
        const configs: Record<string, McpServerConfig> = {};

        // 1. Load global config
        try {
            const globalPath = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp_config.json');
            const data = await fs.readFile(globalPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                Object.assign(configs, parsed.mcpServers);
            }
        } catch (e) {
            // Ignore if doesn't exist
        }

        // 2. Load workspace config (.vscode/mcp_config.json)
        try {
            const wsPath = path.join(this.workspaceRoot, '.vscode', 'mcp_config.json');
            const data = await fs.readFile(wsPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                Object.assign(configs, parsed.mcpServers);
            }
        } catch (e) {
            // Ignore
        }

        // 3. Load workspace root config (mcp_config.json)
        try {
            const wsRootPath = path.join(this.workspaceRoot, 'mcp_config.json');
            const data = await fs.readFile(wsRootPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                Object.assign(configs, parsed.mcpServers);
            }
        } catch (e) {
            // Ignore
        }

        return configs;
    }

    getTools(): McpTool[] {
        const allTools: McpTool[] = [];
        for (const client of this.clients.values()) {
            allTools.push(...client.tools);
        }
        return allTools;
    }

    hasTool(name: string): boolean {
        return this.toolToClientMap.has(name);
    }

    async callTool(name: string, args: any): Promise<string> {
        const clientName = this.toolToClientMap.get(name);
        if (!clientName) {
            throw new Error(`MCP client for tool ${name} not found`);
        }
        const client = this.clients.get(clientName);
        if (!client) {
            throw new Error(`MCP client ${clientName} is not active`);
        }

        const result = await client.callTool(name, args);
        if (result && Array.isArray(result.content)) {
            return result.content
                .map((c: any) => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'image') return `[Image content received, path/url: ${c.data}]`;
                    return JSON.stringify(c);
                })
                .join('\n');
        }
        return JSON.stringify(result);
    }

    async dispose(): Promise<void> {
        for (const client of this.clients.values()) {
            try {
                await client.disconnect();
            } catch (e) {
                // Ignore
            }
        }
        this.clients.clear();
        this.toolToClientMap.clear();
        this.initPromise = null;
    }

    public async getMcpServers(): Promise<Record<string, McpServerConfig>> {
        return this.loadConfigs();
    }

    public async addMcpServer(name: string, config: McpServerConfig): Promise<void> {
        const wsPath = path.join(this.workspaceRoot, '.vscode', 'mcp_config.json');
        let currentConfigs: Record<string, McpServerConfig> = {};
        try {
            await fs.mkdir(path.dirname(wsPath), { recursive: true });
            const data = await fs.readFile(wsPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                currentConfigs = parsed.mcpServers;
            }
        } catch (e) {
            // Ignore if file doesn't exist
        }
        currentConfigs[name] = config;
        
        const output = { mcpServers: currentConfigs };
        await fs.writeFile(wsPath, JSON.stringify(output, null, 2), 'utf8');
        
        await this.dispose();
        await this.initialize();
    }

    public async deleteMcpServer(name: string): Promise<void> {
        const wsPath = path.join(this.workspaceRoot, '.vscode', 'mcp_config.json');
        let currentConfigs: Record<string, McpServerConfig> = {};
        let modified = false;
        try {
            const data = await fs.readFile(wsPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                currentConfigs = parsed.mcpServers;
            }
        } catch (e) {
            // Ignore
        }
        
        if (currentConfigs[name]) {
            delete currentConfigs[name];
            modified = true;
            const output = { mcpServers: currentConfigs };
            await fs.writeFile(wsPath, JSON.stringify(output, null, 2), 'utf8');
        }

        const rootPath = path.join(this.workspaceRoot, 'mcp_config.json');
        let rootConfigs: Record<string, McpServerConfig> = {};
        try {
            const data = await fs.readFile(rootPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                rootConfigs = parsed.mcpServers;
            }
        } catch (e) {
            // Ignore
        }
        if (rootConfigs[name]) {
            delete rootConfigs[name];
            modified = true;
            const output = { mcpServers: rootConfigs };
            await fs.writeFile(rootPath, JSON.stringify(output, null, 2), 'utf8');
        }

        const globalPath = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp_config.json');
        let globalConfigs: Record<string, McpServerConfig> = {};
        try {
            const data = await fs.readFile(globalPath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.mcpServers) {
                globalConfigs = parsed.mcpServers;
            }
        } catch (e) {
            // Ignore
        }
        if (globalConfigs[name]) {
            delete globalConfigs[name];
            modified = true;
            const output = { mcpServers: globalConfigs };
            await fs.writeFile(globalPath, JSON.stringify(output, null, 2), 'utf8');
        }

        if (modified) {
            await this.dispose();
            await this.initialize();
        }
    }
}
