import axios from 'axios';
import { StringDecoder } from 'string_decoder';
import { TOOLS, ToolsManager } from './tools';
import { getSystemPrompt } from './agent/systemPrompt';

export interface AgentCallbacks {
    onLog: (text: string) => void;
    onStreamChunk?: (text: string) => void;
    onStreamThought?: (text: string) => void;
    onToolCall: (toolId: string, name: string, args: any, requiresApproval: boolean) => Promise<boolean>;
    onToolResult: (toolId: string, name: string, success: boolean, resultMessage: string) => void;
    onToolStream?: (toolId: string, name: string, args: any) => void;
    onMessageTextUpdated?: (text: string) => void;
    onKeySuccess?: (keyIndex: number) => void;
    onModelSwitch?: (model: string, keyIndex: number) => void;
    onBrowserScreenshot?: (base64: string) => void;
    onAskQuestion?: (toolId: string, question: string, options: string[], isMultiSelect: boolean) => Promise<string[]>;
}

export class Agent {
    private messages: any[] = [];
    public toolsManager: ToolsManager;
    private abortController?: AbortController;
    public isCancelled = false;
    public fastAction = false;

    private _apiKey: string | string[] = '';
    private keys: string[] = [];
    private currentKeyIndex = 0;

    // Smart model switching: list of models for the current provider
    private models: string[] = [];

    get apiKey(): string | string[] {
        return this._apiKey;
    }

    set apiKey(value: string | string[]) {
        this._apiKey = value;
        if (Array.isArray(value)) {
            this.keys = value;
        } else {
            this.keys = value ? [value] : [];
        }
        if (this.currentKeyIndex >= this.keys.length) {
            this.currentKeyIndex = 0;
        }
        if (this.toolsManager) {
            this.toolsManager.setLLMConfig(this.keys, this.endpoint, this.model);
        }
    }

    /**
     * Set the list of fallback models for the current provider.
     * The first model in the list should be the currently selected model.
     */
    setModels(modelList: string[]) {
        if (!Array.isArray(modelList)) {
            this.models = [];
            return;
        }
        this.models = modelList.filter(m => m && typeof m === 'string' && m.trim() !== '');
    }

    setKeyIndex(index: number) {
        if (index >= 0 && index < this.keys.length) {
            this.currentKeyIndex = index;
            if (this.toolsManager) {
                this.toolsManager.setLLMConfig(this.keys, this.endpoint, this.model);
            }
        }
    }

    getCurrentKeyIndex(): number {
        return this.currentKeyIndex;
    }

    getCurrentApiKey(): string {
        if (this.keys.length === 0) {
            return '';
        }
        return this.keys[this.currentKeyIndex];
    }

    cancel() {
        this.isCancelled = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
    }

    // System prompt generation moved to systemPrompt.ts

    constructor(
        apiKey: string | string[],
        public endpoint: string,
        public model: string,
        public workspaceRoot: string,
        private callbacks: AgentCallbacks,
        initialKeyIndex: number = 0
    ) {
        this.apiKey = apiKey;
        this.currentKeyIndex = (initialKeyIndex >= 0 && initialKeyIndex < this.keys.length) ? initialKeyIndex : 0;
        this.toolsManager = new ToolsManager(workspaceRoot);
        this.toolsManager.setLLMConfig(this.keys, this.endpoint, this.model);
        
        // Register callbacks
        if (this.callbacks.onBrowserScreenshot) {
            this.toolsManager.registerScreenshotCallback(this.callbacks.onBrowserScreenshot);
        }
        
        // Initialize system prompt
        this.messages.push({
            role: 'system',
            content: ''
        });
    }

    public async run(userQuery: string, mode: 'chat' | 'plan' | 'agent' | 'auto' | 'goal' | 'grill' = 'agent', images?: string[]) {
        this.isCancelled = false;
        // Always create a fresh AbortController to avoid leaking cancelled state from previous runs
        this.abortController = new AbortController();
        if (this.toolsManager) {
            this.toolsManager.setLLMConfig(this.keys, this.endpoint, this.model);
            // MCP is only needed in modes that can execute custom tools (agent, auto, goal)
            if (mode !== 'chat' && mode !== 'plan' && mode !== 'grill') {
                await this.toolsManager.initializeMcp();
            }
        }
        const isGoogle = this.endpoint.includes('googleapis.com');
        const isOpenAI = this.endpoint.includes('api.openai.com');
        const hasKey = Array.isArray(this.apiKey) ? this.apiKey.length > 0 : !!this.apiKey;
        if (!hasKey && (isGoogle || isOpenAI)) {
            throw new Error('API Key is missing. Please set it in VS Code Settings (Wind Agent) or in your ai_config.json file.');
        }

        // Ensure system prompt is updated based on the current mode
        const systemPrompt = await getSystemPrompt({
            workspaceRoot: this.workspaceRoot,
            model: this.model,
            toolsManager: this.toolsManager,
            fastAction: this.fastAction,
            mode
        });
        if (this.messages.length === 0) {
            this.messages.push({ role: 'system', content: systemPrompt });
        } else if (this.messages[0] && this.messages[0].role === 'system') {
            this.messages[0].content = systemPrompt;
        } else {
            this.messages.unshift({ role: 'system', content: systemPrompt });
        }

        let queryText: string;
        if (mode === 'plan') {
            if (this.fastAction) {
                queryText = `Please analyze the workspace and write a list of tasks for the implementation plan. You can only read files and list directories. Do NOT modify any files or execute commands.
You MUST output ONLY a structured plan of tasks using the exact tag block, and absolutely no other text, explanation, introductory remarks, or other markdown sections:
[PLAN_START]
- [ ] Task 1 description
- [ ] Task 2 description
[PLAN_END]
Keep task descriptions short, active, and specific. Do not include any other content or explanations.

User request:
${userQuery}`;
            } else {
                queryText = `Please analyze the workspace and write a detailed implementation plan. You can only read files and list directories. Do NOT modify any files or execute commands.
The implementation plan MUST follow this exact structure:

# [Goal Description]
Provide a brief description of the problem, any background context, and what the change accomplishes.

## User Review Required
Document anything that requires user review or feedback, for example, breaking changes or significant design decisions. Use GitHub alerts (e.g. > [!IMPORTANT] or > [!WARNING]) to highlight critical items.

## Open Questions
Any clarifying or design questions for the user that will impact the implementation plan.

## Proposed Changes
Group files by component and order logically. Separate components with horizontal rules.
### [Component Name]
Summary of what will change in this component, separated by files. Use [NEW], [MODIFY], and [DELETE] to demarcate file actions. Use absolute file URLs in the markdown links.
For example:
#### [MODIFY] [file basename](file:///${this.workspaceRoot.replace(/\\/g, '/')}/relativePath/to/modifiedfile)
#### [NEW] [file basename](file:///${this.workspaceRoot.replace(/\\/g, '/')}/relativePath/to/newfile)
#### [DELETE] [file basename](file:///${this.workspaceRoot.replace(/\\/g, '/')}/deletedfile)

## Verification Plan
Summary of how you will verify that your changes have the desired effects.
### Automated Tests
- Exact commands you'll run (e.g. build, compile, tests).
### Manual Verification
- Manual verification steps.

IMPORTANT: At the very end of your response, you MUST output a structured plan of tasks using the exact tag block:
[PLAN_START]
- [ ] Task 1 description
- [ ] Task 2 description
[PLAN_END]
Keep task descriptions short, active, and specific.

User request:
${userQuery}`;
            }
        } else if (mode === 'chat') {
            queryText = userQuery;
        } else {
            queryText = userQuery;
        }

        // Add user query to history
        if (images && images.length > 0) {
            const contentParts: any[] = [{ type: 'text', text: queryText }];
            for (const img of images) {
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: img }
                });
            }
            this.messages.push({
                role: 'user',
                content: contentParts
            });
        } else {
            this.messages.push({
                role: 'user',
                content: queryText
            });
        }

        let loopCount = 0;
        const maxLoops = mode === 'goal' ? 100 : 50; // Safeguard against infinite tool loops
        const toolCallHistory: string[] = [];

        const modelLower = this.model.toLowerCase();
        const isNonToolModel = modelLower.includes('deepseek') || modelLower.includes('gemma') || modelLower.includes('r1');
        let forceNonTool = isNonToolModel;

        while (loopCount < maxLoops) {
            if (this.isCancelled) {
                throw new Error('Cancelled by user');
            }
            loopCount++;

            let allowedTools = this.toolsManager ? this.toolsManager.getAvailableTools() : TOOLS;
            if (mode === 'chat') {
                allowedTools = [];
            } else if (mode === 'plan' || mode === 'grill') {
                // Plan and grill modes only allow read-only tools
                allowedTools = allowedTools.filter(t => 
                    t.name === 'listFiles' ||
                    t.name === 'listDir' ||
                    t.name === 'readFile' ||
                    t.name === 'grepSearch' ||
                    t.name === 'searchWeb' ||
                    t.name === 'searchSemanticCode' ||
                    t.name === 'searchKnowledgeBase' ||
                    t.name === 'readKnowledgeItem'
                );
            }

            const formattedTools = (forceNonTool || mode === 'chat') ? [] : allowedTools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));

            // Call LLM using streaming approach
            let assistantMessage;
            try {
                assistantMessage = await this.callLLMStream(formattedTools, forceNonTool, allowedTools);
            } catch (err: any) {
                if (!forceNonTool && formattedTools.length > 0 && isToolUnsupportedError(err.message)) {
                    this.callbacks.onLog('[System] Tool calling not supported by the model/endpoint. Retrying with text-based tool fallback...');
                    forceNonTool = true;
                    const newPrompt = await getSystemPrompt({
                        workspaceRoot: this.workspaceRoot,
                        model: this.model,
                        toolsManager: this.toolsManager,
                        fastAction: this.fastAction,
                        mode,
                        forceNonTool: true
                    });
                    if (this.messages[0] && this.messages[0].role === 'system') {
                        this.messages[0].content = newPrompt;
                    }
                    loopCount--; // don't count this failed attempt as a loop
                    continue;
                } else {
                    throw err;
                }
            }

            // Safety net: if the model was expected to support tools but returned empty response (null),
            // it likely doesn't support tool calling on the current endpoint/server setup. Retry without tools.
            if (formattedTools.length > 0 && 
                (!assistantMessage.content || assistantMessage.content.trim() === '') && 
                (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)) {
                
                this.callbacks.onLog('[System] Selected model may not support tool calling. Retrying with text-based tool fallback...');
                forceNonTool = true;
                const newPrompt = await getSystemPrompt({
                    workspaceRoot: this.workspaceRoot,
                    model: this.model,
                    toolsManager: this.toolsManager,
                    fastAction: this.fastAction,
                    mode,
                    forceNonTool: true
                });
                if (this.messages[0] && this.messages[0].role === 'system') {
                    this.messages[0].content = newPrompt;
                }
                assistantMessage = await this.callLLMStream([], forceNonTool, allowedTools);
            }

            // Check for text-based tool calls if no native tool calls were returned
            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                if (assistantMessage.content) {
                    const validToolNames = new Set<string>(allowedTools.map((t: any) => t.name));
                    const extracted = extractToolCallsFromText(assistantMessage.content, validToolNames);
                    if (extracted.length > 0) {
                        assistantMessage.tool_calls = extracted;
                        // Clean the JSON block from assistantMessage.content now that the tool calls are extracted
                        assistantMessage.content = cleanToolCallsFromText(assistantMessage.content, validToolNames);
                        if (this.callbacks.onMessageTextUpdated) {
                            this.callbacks.onMessageTextUpdated(assistantMessage.content);
                        }
                    }
                }
            }
            
            // Store assistant's response in history
            this.messages.push(assistantMessage);

            const toolCalls = assistantMessage.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
                // No more tools requested, we are done
                if (assistantMessage.content) {
                    return assistantMessage.content
                }
                return  'Task completed.';
            }

            // Print intermediate text content if present (already streamed to UI, but good to log)
            if (assistantMessage.content) {
                this.callbacks.onLog(`[Thought] ${assistantMessage.content}`);
            }

            // Execute each tool requested by the model
            // Separate read-only tools (parallelizable) from mutating tools (sequential)
            const READ_ONLY_TOOLS = new Set([
                'listFiles', 'listDir', 'readFile', 'grepSearch', 'searchWeb',
                'fetchUrl', 'getCommandStatus', 'browserGetContent', 'browserScreenshot',
                'gitStatus', 'gitDiff', 'searchWorkspaceSymbols', 'searchKnowledgeBase',
                'readKnowledgeItem', 'searchSemanticCode'
            ]);

            // Helper to process a single tool call
            const processToolCall = async (toolCall: any) => {
                const toolId = toolCall.id;
                const toolName = toolCall.function.name;
                
                let toolArgs: any = {};
                let toolArgsParseFailed = false;
                const rawArgs = toolCall.function.arguments || '{}';
                try {
                    try {
                        toolArgs = JSON.parse(rawArgs);
                    } catch (e) {
                        toolArgs = parsePartialJSON(rawArgs);
                        if (Object.keys(toolArgs).length === 0 && rawArgs.trim() !== '{}' && rawArgs.trim() !== '' && rawArgs.trim() !== '""') {
                            throw e;
                        }
                    }
                } catch (e: any) {
                    toolArgsParseFailed = true;
                    this.callbacks.onLog(`[System] Warning: Failed to parse tool arguments for ${toolName}: ${e.message}`);
                }

                const toolSignature = `${toolName}:${rawArgs.trim()}`;
                
                // Check for consecutive identical calls (for any tool)
                const len = toolCallHistory.length;
                if (len >= 2 && toolCallHistory[len - 1] === toolSignature && toolCallHistory[len - 2] === toolSignature) {
                    const warnMsg = `⚠️ Warning: Infinite loop prevented. Tool "${toolName}" was called consecutively 3 times with identical arguments.`;
                    this.callbacks.onLog(warnMsg);
                    return { earlyExit: true, message: warnMsg };
                }

                // Check for overall identical calls of tools
                const MODIFYING_TOOLS = new Set(['writeFile', 'replaceFileContent', 'multiReplaceFileContent']);
                const limit = MODIFYING_TOOLS.has(toolName) ? 2 : 3;
                const occurrences = toolCallHistory.filter(sig => sig === toolSignature).length;
                if (occurrences >= limit) {
                    const warnMsg = `⚠️ Warning: Infinite loop prevented. The tool "${toolName}" was called with the exact same arguments ${limit + 1} times.`;
                    this.callbacks.onLog(warnMsg);
                    return { earlyExit: true, message: warnMsg };
                }
                toolCallHistory.push(toolSignature);

                // Decide if tool execution requires explicit user approval
                const requiresApproval = toolName === 'runCommand' || toolName === 'runTerminalCommand' || toolName === 'sendCommandInput' || toolName === 'writeFile' || toolName === 'replaceFileContent' || toolName === 'multiReplaceFileContent';

                // Report the tool request to the UI and wait for approval if needed
                const isApproved = await this.callbacks.onToolCall(
                    toolId,
                    toolName,
                    toolArgs,
                    requiresApproval
                );

                if (this.isCancelled) {
                    throw new Error('Cancelled by user');
                }

                let toolResult: string;
                let success: boolean;

                if (toolArgsParseFailed) {
                    toolResult = `Error: Failed to parse tool arguments. Raw arguments: ${(toolCall.function.arguments || '').substring(0, 500)}`;
                    success = false;
                } else if (isApproved) {
                    try {
                        toolResult = await this.toolsManager.executeTool(toolName, toolArgs, this.abortController?.signal);
                        success = true;
                    } catch (error: any) {
                        toolResult = `Error executing tool: ${error.message}`;
                        success = false;
                    }
                } else {
                    toolResult = `Tool execution was rejected by the user.`;
                    success = false;
                }

                if (this.isCancelled) {
                    throw new Error('Cancelled by user');
                }

                // Send tool execution outcome back to UI
                this.callbacks.onToolResult(
                    toolId,
                    toolName,
                    success,
                    success ? 'Success' : (isApproved ? 'Failed' : 'Rejected')
                );

                // Truncate long tool results to save tokens
                if (toolResult.length > 10000) {
                    toolResult = toolResult.substring(0, 10000) + '\n\n...[Tool output truncated to 10000 characters to save context]';
                }

                // Add tool result to conversation history
                this.messages.push({
                    role: 'tool',
                    tool_call_id: toolId,
                    name: toolName,
                    content: toolResult
                });

                return { earlyExit: false };
            };

            // Split into read-only and mutating tools
            const readOnlyToolCalls = toolCalls.filter((tc: any) => READ_ONLY_TOOLS.has(tc.function.name));
            const mutatingToolCalls = toolCalls.filter((tc: any) => !READ_ONLY_TOOLS.has(tc.function.name));

            // Execute read-only tools in parallel for speed
            if (readOnlyToolCalls.length > 1) {
                const results = await Promise.all(readOnlyToolCalls.map((tc: any) => processToolCall(tc)));
                for (const result of results) {
                    if (result.earlyExit) {
                        return result.message;
                    }
                }
            } else if (readOnlyToolCalls.length === 1) {
                const result = await processToolCall(readOnlyToolCalls[0]);
                if (result.earlyExit) {
                    return result.message;
                }
            }

            // Execute mutating tools sequentially
            for (const toolCall of mutatingToolCalls) {
                const result = await processToolCall(toolCall);
                if (result.earlyExit) {
                    return result.message;
                }
            }
        }

        return '⚠️ Warning: Agent reached maximum loop count (' + maxLoops + ') and was stopped.\nReached maximum reasoning steps limit.';
    }

    private async callLLMStream(tools: any[], forceNonTool: boolean, allowedTools: any[]): Promise<any> {
        // Sanitize messages: ensure all assistant tool call arguments are valid JSON to prevent 400 Bad Request errors
        for (const msg of this.messages) {
            if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    if (tc.function && typeof tc.function.arguments === 'string') {
                        try {
                            JSON.parse(tc.function.arguments);
                        } catch (e) {
                            try {
                                const parsed = parsePartialJSON(tc.function.arguments);
                                tc.function.arguments = JSON.stringify(parsed);
                            } catch (err) {
                                tc.function.arguments = '{}';
                            }
                        }
                    }
                }
            }
        }

        let lastError: any = null;
        const keysCount = this.keys.length || 1;
        const startKeyIndex = this.currentKeyIndex;

        // Build the effective model list for fallback:
        // Start from the currently selected model, then cycle through the rest.
        // If no models list was set (legacy), use only this.model.
        const effectiveModels: string[] = [];
        if (this.models.length > 0) {
            // Ensure the currently selected model is tried first
            const startModelIdx = Math.max(0, this.models.indexOf(this.model));
            for (let i = 0; i < this.models.length; i++) {
                effectiveModels.push(this.models[(startModelIdx + i) % this.models.length]);
            }
        } else {
            effectiveModels.push(this.model);
        }
        const modelsCount = effectiveModels.length;

        // Total attempts = keys × models
        // Strategy: for each model, try all keys before moving to the next model
        const totalAttempts = keysCount * modelsCount;

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const modelAttempt = Math.floor(attempt / keysCount);
            const keyAttempt = attempt % keysCount;

            const currentKeyIdx = (startKeyIndex + keyAttempt) % keysCount;
            const currentModel = effectiveModels[modelAttempt];

            this.currentKeyIndex = currentKeyIdx;
            // Temporarily set the model for this attempt
            this.model = currentModel;
            const currentKey = this.getCurrentApiKey();

            const url = this.endpoint.replace(/\/+$/, '');
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };

            if (currentKey) {
                headers['Authorization'] = `Bearer ${currentKey}`;
            }

            // Character-based context window pruning (safeguard against token window overflow)
            const MAX_RETAINED_CHARS = 240000; // ~60,000 tokens
            const totalChars = this.messages.reduce((sum, msg) => {
                let contentStr = '';
                if (typeof msg.content === 'string') {
                    contentStr = msg.content;
                } else if (Array.isArray(msg.content)) {
                    contentStr = JSON.stringify(msg.content);
                }
                return sum + contentStr.length;
            }, 0);

            if (totalChars > MAX_RETAINED_CHARS && this.messages.length > 3) {
                const systemPrompt = this.messages[0];
                let trimStart = 1;
                let currentSize = totalChars - (typeof systemPrompt.content === 'string' ? systemPrompt.content.length : JSON.stringify(systemPrompt.content || '').length);
                
                // Find a trim point from the beginning such that the remaining suffix is below the character limit
                // while ensuring we don't slice in the middle of a tool response group.
                while (trimStart < this.messages.length - 2) {
                    const msgLength = typeof this.messages[trimStart].content === 'string' 
                        ? this.messages[trimStart].content.length 
                        : JSON.stringify(this.messages[trimStart].content || '').length;
                    
                    if (currentSize - msgLength <= MAX_RETAINED_CHARS) {
                        break;
                    }
                    currentSize -= msgLength;
                    trimStart++;
                }

                // Ensure we don't slice in the middle of a tool response group
                while (trimStart > 1 && this.messages[trimStart]?.role === 'tool') {
                    trimStart--;
                }

                if (trimStart > 1) {
                    if (this.messages[trimStart]?.role === 'user') {
                        this.messages = [systemPrompt, ...this.messages.slice(trimStart)];
                    } else {
                        const placeholderUser = {
                            role: 'user',
                            content: 'Continuing task execution...'
                        };
                        this.messages = [systemPrompt, placeholderUser, ...this.messages.slice(trimStart)];
                    }
                }
            }

            // Sanitize messages to avoid API schema errors (e.g. sequence formatting and tool call IDs matching)
            this.messages = sanitizeMessages(this.messages);

            const body: any = {
                model: this.model,
                messages: this.messages,
                stream: true
            };

            const modelLower = this.model.toLowerCase();

            if (tools && tools.length > 0) {
                body.tools = tools;
                body.tool_choice = 'auto';
            }

            const isGoogle = url.includes('googleapis.com');
            if (isGoogle) {
                if (modelLower.includes('gemini') && (modelLower.includes('2.5') || modelLower.includes('3.5') || modelLower.includes('3.'))) {
                    body.reasoning_effort = "medium";
                }
            } else {
                if ((modelLower.includes('o1') || modelLower.includes('o3')) && !modelLower.includes('gemini')) {
                    body.reasoning_effort = "medium";
                } else if (
                    modelLower.includes('r1') ||
                    modelLower.includes('reason') ||
                    modelLower.includes('think') ||
                    modelLower.includes('qwen') ||
                    modelLower.includes('gemma') ||
                    this.model.includes(':')
                ) {
                    body.think = true;
                    body.options = { ...body.options, think: true };
                }
            }

            let fullContent = '';
            let fullReasoningContent = '';
            let msgThoughtSignature: any = undefined;
            const activeToolCalls: any = {}; // map of index -> tool_call object

            // Smart stream buffer: holds chunks that may be tool call JSON (triggered by '{').
            // Flushed to UI only after confirming they are NOT tool calls.
            let streamHoldBuffer = '';
            let streamHoldActive = false;

            try {
                // Always ensure a fresh AbortController for each LLM call
                if (!this.abortController || this.abortController.signal.aborted) {
                    this.abortController = new AbortController();
                }
                const res = await axios.post(`${url}/chat/completions`, body, { 
                    headers,
                    responseType: 'stream',
                    timeout: 30000,
                    signal: this.abortController.signal
                });

                const decoder = new StringDecoder('utf8');
                let streamBuffer = '';
                const MAX_STREAM_BUFFER = 500000; // 500KB safety limit

                // Throttle parsePartialJSON to avoid O(n²) re-parsing on every chunk
                const lastToolStreamTimes = new Map<string | number, number>();
                const TOOL_STREAM_THROTTLE_MS = 300;

                // Helper to process a single SSE line
                const processSSELine = (line: string) => {
                    if (line === 'data: [DONE]') return;
                    if (!line.startsWith('data: ')) return;
                    try {
                        const rawData = line.slice(6).trim();
                        if (!rawData) return;
                        const data = JSON.parse(rawData);
                        if (data && data.choices && data.choices.length > 0) {
                            const delta = data.choices[0].delta;
                            
                            // Capture any message-level/delta-level thought signature
                            if (delta.thought_signature) {
                                msgThoughtSignature = delta.thought_signature;
                            } else if (delta.google?.thought_signature) {
                                msgThoughtSignature = delta.google.thought_signature;
                            } else if (delta.extra_content?.thought_signature) {
                                msgThoughtSignature = delta.extra_content.thought_signature;
                            } else if (delta.extra_content?.google?.thought_signature) {
                                msgThoughtSignature = delta.extra_content.google.thought_signature;
                            }

                            if (delta.reasoning_content) {
                                fullReasoningContent += delta.reasoning_content;
                                if (this.callbacks.onStreamThought) {
                                    this.callbacks.onStreamThought(delta.reasoning_content);
                                }
                            } else if (delta.thinking) {
                                fullReasoningContent += delta.thinking;
                                if (this.callbacks.onStreamThought) {
                                    this.callbacks.onStreamThought(delta.thinking);
                                }
                            } else if (delta.reasoning) {
                                fullReasoningContent += delta.reasoning;
                                if (this.callbacks.onStreamThought) {
                                    this.callbacks.onStreamThought(delta.reasoning);
                                }
                            }
                            if (delta.content) {
                                fullContent += delta.content;
                                if (this.callbacks.onStreamChunk) {
                                    // Smart buffering: if we see '{', start buffering to prevent
                                    // tool call JSON from being rendered directly in the chat UI.
                                    if (!streamHoldActive && delta.content.includes('{')) {
                                        // Check if we are inside a markdown code block.
                                        // If we are, this is code text, not a tool call.
                                        const matches = fullContent.match(/```/g);
                                        const inCodeBlock = matches ? matches.length % 2 !== 0 : false;
                                        if (!inCodeBlock) {
                                            streamHoldActive = true;
                                        }
                                    }
                                    if (streamHoldActive) {
                                        streamHoldBuffer += delta.content;
                                        
                                        // Check if we should flush early (e.g. if buffer contains a markdown code block,
                                        // is too long without tool call keywords, or has successfully parsed as a non-tool JSON).
                                        let shouldFlush = false;
                                        if (streamHoldBuffer.includes('```')) {
                                            shouldFlush = true;
                                        } else if (streamHoldBuffer.length > 800) {
                                            const VALID_TOOL_NAMES = new Set(allowedTools.map((t: any) => t.name));
                                            const hasValidToolName = Array.from(VALID_TOOL_NAMES).some(name => streamHoldBuffer.includes(name));
                                            if (!hasValidToolName) {
                                                shouldFlush = true;
                                            }
                                        } else {
                                            const startIdx = streamHoldBuffer.indexOf('{');
                                            if (startIdx !== -1) {
                                                try {
                                                    const { obj, endIdx } = parseResilientJSON(streamHoldBuffer, startIdx);
                                                    if (obj && typeof obj === 'object') {
                                                        const VALID_TOOL_NAMES = new Set(allowedTools.map((t: any) => t.name));
                                                        let isToolCall = false;
                                                        
                                                        if (Array.isArray(obj.tool_calls)) {
                                                            isToolCall = obj.tool_calls.some((tc: any) => tc && typeof tc.name === 'string' && VALID_TOOL_NAMES.has(tc.name));
                                                        } else if (obj.tool_call && typeof obj.tool_call === 'object' && typeof obj.tool_call.name === 'string' && VALID_TOOL_NAMES.has(obj.tool_call.name)) {
                                                            isToolCall = true;
                                                        } else if (typeof obj.name === 'string' && VALID_TOOL_NAMES.has(obj.name)) {
                                                            isToolCall = true;
                                                        }
                                                        
                                                        const isComplete = endIdx >= streamHoldBuffer.length - 2;
                                                        if (isComplete && !isToolCall) {
                                                            shouldFlush = true;
                                                        }
                                                    }
                                                } catch (e) {
                                                    if (streamHoldBuffer.length > 200) {
                                                        const hasKeywords = allowedTools.some((t: any) => streamHoldBuffer.includes(t.name)) ||
                                                                            streamHoldBuffer.includes('name') ||
                                                                            streamHoldBuffer.includes('tool_calls') ||
                                                                            streamHoldBuffer.includes('tool_call');
                                                        if (!hasKeywords) {
                                                            shouldFlush = true;
                                                        }
                                                    }
                                                }
                                            } else {
                                                shouldFlush = true;
                                            }
                                        }
                                        
                                        if (shouldFlush) {
                                            this.callbacks.onStreamChunk(streamHoldBuffer);
                                            streamHoldBuffer = '';
                                            streamHoldActive = false;
                                        }
                                    } else {
                                        this.callbacks.onStreamChunk(delta.content);
                                    }
                                }
                                // Support streaming text JSON for models without tools
                                if (forceNonTool) {
                                    const validToolNames = new Set<string>(allowedTools.map((t: any) => t.name));
                                    const extracted = extractToolCallsFromText(fullContent, validToolNames);
                                    if (extracted.length > 0) {
                                        const now = Date.now();
                                        for (const tc of extracted) {
                                            const toolId = tc.id;
                                            const toolName = tc.function.name;
                                            const rawArgs = tc.function.arguments;
                                            
                                            // Throttle stream callback per tool ID to avoid overloading
                                            const lastTime = lastToolStreamTimes.get(toolId) || 0;
                                            if (this.callbacks.onToolStream && (now - lastTime >= TOOL_STREAM_THROTTLE_MS)) {
                                                lastToolStreamTimes.set(toolId, now);
                                                try {
                                                    const partialArgs = parsePartialJSON(rawArgs);
                                                    this.callbacks.onToolStream(toolId, toolName, partialArgs);
                                                } catch (_e) {
                                                    // Ignore parsing errors for incomplete JSON
                                                }
                                            }
                                        }
                                    }
                                }
                                if (detectRepetitiveLoop(fullContent)) {
                                    return true;
                                }
                            }
                            if (delta.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index;
                                    if (!activeToolCalls[idx]) {
                                        activeToolCalls[idx] = {
                                            id: tc.id,
                                            type: 'function',
                                            function: { name: tc.function?.name || '', arguments: '' }
                                        };
                                    }
                                    if (tc.function?.arguments) {
                                        activeToolCalls[idx].function.arguments += tc.function.arguments;
                                        // Throttle tool stream callbacks to prevent O(n²) partial JSON parsing
                                        const now = Date.now();
                                        const lastTime = lastToolStreamTimes.get(idx) || 0;
                                        if (this.callbacks.onToolStream && (now - lastTime >= TOOL_STREAM_THROTTLE_MS)) {
                                            lastToolStreamTimes.set(idx, now);
                                            try {
                                                const partialArgs = parsePartialJSON(activeToolCalls[idx].function.arguments);
                                                this.callbacks.onToolStream(
                                                    activeToolCalls[idx].id,
                                                    activeToolCalls[idx].function.name,
                                                    partialArgs
                                                );
                                            } catch (_e) {
                                                // Ignore parsing errors for incomplete JSON
                                            }
                                        }
                                    }

                                    // Capture thought_signature in any shape or nested form
                                    if (tc.thought_signature) {
                                        activeToolCalls[idx].thought_signature = tc.thought_signature;
                                    }
                                    if (tc.function?.thought_signature) {
                                        activeToolCalls[idx].thought_signature = tc.function.thought_signature;
                                        activeToolCalls[idx].function.thought_signature = tc.function.thought_signature;
                                    }
                                    if (tc.provider_specific_fields?.thought_signature) {
                                        activeToolCalls[idx].thought_signature = tc.provider_specific_fields.thought_signature;
                                        activeToolCalls[idx].provider_specific_fields = tc.provider_specific_fields;
                                    }
                                    if (tc.extra_content?.thought_signature) {
                                        activeToolCalls[idx].thought_signature = tc.extra_content.thought_signature;
                                    }
                                    if (tc.extra_content?.google?.thought_signature) {
                                        activeToolCalls[idx].thought_signature = tc.extra_content.google.thought_signature;
                                    }

                                    // General preservation of any other properties on tc
                                    for (const key of Object.keys(tc)) {
                                        if (key !== 'index' && key !== 'id' && key !== 'type' && key !== 'function') {
                                            if ((tc as any)[key] !== undefined) {
                                                (activeToolCalls[idx] as any)[key] = (tc as any)[key];
                                            }
                                        }
                                    }
                                    if (tc.function) {
                                        for (const key of Object.keys(tc.function)) {
                                            if (key !== 'name' && key !== 'arguments') {
                                                if ((tc.function as any)[key] !== undefined) {
                                                    if (!activeToolCalls[idx].function) {
                                                        activeToolCalls[idx].function = {} as any;
                                                    }
                                                    (activeToolCalls[idx].function as any)[key] = (tc.function as any)[key];
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (_e) {
                        // Ignore JSON parse errors for incomplete chunks
                    }
                    return false;
                };

                const assistantMessage = await new Promise<any>((resolve, reject) => {
                    let done = false;
                    let streamTimeout: NodeJS.Timeout | undefined;

                    const resetStreamTimeout = () => {
                        if (streamTimeout) clearTimeout(streamTimeout);
                        streamTimeout = setTimeout(() => {
                            fail(new Error('LLM stream response timed out (no data received for 20 seconds).'));
                        }, 20000);
                    };

                    const finish = (msg: any) => {
                        if (done) return;
                        done = true;
                        if (streamTimeout) clearTimeout(streamTimeout);
                        try { res.data.destroy(); } catch { /* ignore */ }
                        resolve(msg);
                    };
                    const fail = (err: any) => {
                        if (done) return;
                        done = true;
                        if (streamTimeout) clearTimeout(streamTimeout);
                        try { res.data.destroy(); } catch { /* ignore */ }
                        reject(err);
                    };

                    // Guard: if already cancelled before stream listeners are set up, abort immediately
                    if (this.isCancelled) {
                        fail(new Error('Cancelled by user'));
                        return;
                    }

                    resetStreamTimeout();

                    res.data.on('data', (chunk: Buffer) => {
                        if (done) return;
                        if (this.isCancelled) {
                            fail(new Error('Cancelled by user'));
                            return;
                        }
                        resetStreamTimeout();
                        try {
                            streamBuffer += decoder.write(chunk);

                            // Safety: reject if stream response is unreasonably large
                            if (streamBuffer.length > MAX_STREAM_BUFFER) {
                                fail(new Error('Stream response exceeded maximum buffer size (500KB). The response may be too large.'));
                                return;
                            }

                            // Batch-process all complete lines using pointer to avoid O(n) substring copies
                            let eolIdx;
                            let bufferOffset = 0;
                            while ((eolIdx = streamBuffer.indexOf('\n', bufferOffset)) !== -1) {
                                const line = streamBuffer.substring(bufferOffset, eolIdx).trim();
                                bufferOffset = eolIdx + 1;
                                const shouldFinish = processSSELine(line);
                                if (shouldFinish) {
                                    this.callbacks.onLog('⚠️ Warning: Stream repetition loop detected. Stopping stream...');
                                    
                                    // Trim the repeated suffix from fullContent to keep the text clean!
                                    let cleanContent = fullContent;
                                    const len = fullContent.length;
                                    const maxL = Math.floor(len / 3);
                                    for (let L = 15; L <= maxL; L++) {
                                        const chunk1 = fullContent.substring(len - L);
                                        const chunk2 = fullContent.substring(len - 2 * L, len - L);
                                        const chunk3 = fullContent.substring(len - 3 * L, len - 2 * L);
                                        if (chunk1 === chunk2 && chunk2 === chunk3) {
                                            cleanContent = fullContent.substring(0, len - 2 * L);
                                            break;
                                        }
                                    }
                                    
                                    const finalToolCalls = Object.values(activeToolCalls) as any[];
                                    const assistantMsg: any = {
                                        role: 'assistant',
                                        content: cleanContent
                                    };
                                    if (fullReasoningContent) {
                                        assistantMsg.reasoning_content = fullReasoningContent;
                                    }
                                    if (msgThoughtSignature) {
                                        assistantMsg.thought_signature = msgThoughtSignature;
                                        if (finalToolCalls.length > 0) {
                                            if (!finalToolCalls[0].thought_signature) {
                                                finalToolCalls[0].thought_signature = msgThoughtSignature;
                                            }
                                            if (finalToolCalls[0].function && !finalToolCalls[0].function.thought_signature) {
                                                finalToolCalls[0].function.thought_signature = msgThoughtSignature;
                                            }
                                        }
                                    }
                                    if (finalToolCalls.length > 0) {
                                        assistantMsg.tool_calls = finalToolCalls;
                                    }
                                    // Flush smart hold buffer (strip tool call JSON) before finishing
                                    if (streamHoldActive && streamHoldBuffer && this.callbacks.onStreamChunk) {
                                        const cleanedHold = cleanToolCallsFromText(streamHoldBuffer, new Set(allowedTools.map((t: any) => t.name))).trim();
                                        if (cleanedHold) {
                                            this.callbacks.onStreamChunk(cleanedHold);
                                        }
                                    }
                                    if (this.callbacks.onToolStream && forceNonTool) {
                                        const validToolNames = new Set<string>(allowedTools.map((t: any) => t.name));
                                        const extracted = extractToolCallsFromText(fullContent, validToolNames);
                                        for (const tc of extracted) {
                                            try {
                                                const partialArgs = parsePartialJSON(tc.function.arguments);
                                                this.callbacks.onToolStream(tc.id, tc.function.name, partialArgs);
                                            } catch { /* ignore */ }
                                        }
                                    }
                                    finish(assistantMsg);
                                    return;
                                }
                            }
                            if (bufferOffset > 0) {
                                streamBuffer = streamBuffer.substring(bufferOffset);
                            }
                        } catch (err) {
                            fail(err);
                        }
                    });

                    res.data.on('end', () => {
                        if (done) return;
                        try {
                            streamBuffer += decoder.end();
                            // Process ALL remaining lines in the buffer
                            const remainingLines = streamBuffer.split('\n');
                            for (const rawLine of remainingLines) {
                                const line = rawLine.trim();
                                if (line) {
                                    processSSELine(line);
                                }
                            }
                        } catch (_e) {
                            // Best-effort: don't fail the whole response for trailing parse errors
                        }

                        // Fire one final onToolStream for any pending partial args
                        if (this.callbacks.onToolStream) {
                            for (const idx of Object.keys(activeToolCalls)) {
                                try {
                                    const tc = activeToolCalls[idx];
                                    const partialArgs = parsePartialJSON(tc.function.arguments);
                                    this.callbacks.onToolStream(tc.id, tc.function.name, partialArgs);
                                } catch { /* ignore */ }
                            }
                            if (forceNonTool) {
                                const validToolNames = new Set<string>(allowedTools.map((t: any) => t.name));
                                const extracted = extractToolCallsFromText(fullContent, validToolNames);
                                for (const tc of extracted) {
                                    try {
                                        const partialArgs = parsePartialJSON(tc.function.arguments);
                                        this.callbacks.onToolStream(tc.id, tc.function.name, partialArgs);
                                    } catch { /* ignore */ }
                                }
                            }
                        }

                        // Flush the smart hold buffer: strip tool call JSON before emitting to UI
                        if (streamHoldActive && streamHoldBuffer && this.callbacks.onStreamChunk) {
                            const cleaned = cleanToolCallsFromText(streamHoldBuffer, new Set(allowedTools.map((t: any) => t.name))).trim();
                            if (cleaned) {
                                this.callbacks.onStreamChunk(cleaned);
                            }
                        }


                        const finalToolCalls = Object.values(activeToolCalls) as any[];
                        const assistantMsg: any = {
                            role: 'assistant',
                            content: fullContent
                        };
                        if (fullReasoningContent) {
                            assistantMsg.reasoning_content = fullReasoningContent;
                        }
                        if (msgThoughtSignature) {
                            assistantMsg.thought_signature = msgThoughtSignature;
                            if (finalToolCalls.length > 0) {
                                if (!finalToolCalls[0].thought_signature) {
                                    finalToolCalls[0].thought_signature = msgThoughtSignature;
                                }
                                if (finalToolCalls[0].function && !finalToolCalls[0].function.thought_signature) {
                                    finalToolCalls[0].function.thought_signature = msgThoughtSignature;
                                }
                            }
                        }
                        if (finalToolCalls.length > 0) {
                            assistantMsg.tool_calls = finalToolCalls;
                        }
                        finish(assistantMsg);
                    });

                    res.data.on('error', (err: any) => {
                        // Check for cancellation inside the error handler
                        if (this.isCancelled || err.name === 'AbortError' || err.code === 'ERR_CANCELED') {
                            fail(new Error('Cancelled by user'));
                        } else {
                            fail(err);
                        }
                    });
                });

                // If successful, trigger onKeySuccess and return message
                if (this.callbacks.onKeySuccess) {
                    this.callbacks.onKeySuccess(currentKeyIdx);
                }
                return assistantMessage;

            } catch (error: any) {
                if (this.isCancelled || axios.isCancel(error) || error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
                    throw new Error('Cancelled by user', { cause: error });
                }
                let errorDetails = error.message;
                if (error.response && error.response.data) {
                    try {
                        let streamData = '';
                        if (typeof error.response.data.on === 'function') {
                            streamData = await new Promise((resolve) => {
                                const chunks: any[] = [];
                                const onData = (chunk: any) => chunks.push(chunk);
                                const onEnd = () => {
                                    clearTimeout(timeout);
                                    cleanup();
                                    resolve(Buffer.concat(chunks).toString('utf8'));
                                };
                                const onError = () => {
                                    clearTimeout(timeout);
                                    cleanup();
                                    resolve('');
                                };
                                const cleanup = () => {
                                    try {
                                        error.response.data.off('data', onData);
                                        error.response.data.off('end', onEnd);
                                        error.response.data.off('error', onError);
                                    } catch { /* ignore */ }
                                };
                                const timeout = setTimeout(() => {
                                    cleanup();
                                    try { error.response.data.destroy(); } catch { /* ignore */ }
                                    resolve(Buffer.concat(chunks).toString('utf8') + ' [Read timeout]');
                                }, 3000);
                                
                                error.response.data.on('data', onData);
                                error.response.data.on('end', onEnd);
                                error.response.data.on('error', onError);
                            });
                        } else if (typeof error.response.data === 'string') {
                            streamData = error.response.data;
                        } else if (typeof error.response.data === 'object') {
                            streamData = JSON.stringify(error.response.data);
                        }
                        if (streamData) {
                            errorDetails = `Stream Error: ${error.message} - ${streamData}`;
                        } else {
                            errorDetails = `Stream Error: ${error.message}`;
                        }
                    } catch (e) {
                        errorDetails = `Stream Error: ${error.message}`;
                    }
                }
                
                lastError = new Error(`LLM API Call failed: ${errorDetails}`);

                if (isToolUnsupportedError(errorDetails)) {
                    throw lastError;
                }

                // Log smart switching info
                const nextAttempt = attempt + 1;
                if (nextAttempt < totalAttempts) {
                    const nextModelAttempt = Math.floor(nextAttempt / keysCount);
                    const nextKeyAttempt = nextAttempt % keysCount;
                    const nextModel = effectiveModels[nextModelAttempt];
                    const nextKeyIdx = (startKeyIndex + nextKeyAttempt) % keysCount;

                    if (nextKeyAttempt === 0) {
                        // Switching to next model (and resetting key index back to startKeyIndex)
                        this.callbacks.onLog(`[System] Model "${currentModel}" encountered errors with all API keys. Switching to next model "${nextModel}" and retrying all keys starting from key[${nextKeyIdx}]...`);
                    } else {
                        // Switching to next API key within same model
                        this.callbacks.onLog(`[System] Model "${currentModel}" with key[${currentKeyIdx}] encountered an error: ${errorDetails}. Switching to next API key[${nextKeyIdx}]...`);
                    }

                    if (this.callbacks.onModelSwitch) {
                        this.callbacks.onModelSwitch(nextModel, nextKeyIdx);
                    }
                } else {
                    // Log the final attempt's error details so it's not lost
                    this.callbacks.onLog(`[System] Model "${currentModel}" with key[${currentKeyIdx}] encountered a final error: ${errorDetails}. All keys and models have been tried.`);
                }
            }
        }

        throw lastError || new Error('All models and API keys were tried, but all failed.');
    }

    clearHistory() {
        if (this.messages.length > 0) {
            this.messages = [this.messages[0]]; // Retain only system prompt
        }
    }

    getHistory(): any[] {
        return this.messages;
    }

    setHistory(history: any[]) {
        this.messages = history;
    }
}

function parsePartialJSON(jsonStr: string): Record<string, any> {
    try {
        const cleaned = jsonStr.trim();
        if (!cleaned) return {};
        let target = cleaned;
        if (!target.startsWith('{')) {
            target = '{' + target;
        }
        const { obj } = parseResilientJSON(target, 0);
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) {
        return {};
    }
}

// Unused sticky regexes removed to optimize memory

function parseResilientJSON(text: string, startIdx: number = 0): { obj: any; endIdx: number } {
    let i = startIdx;
    let depth = 0;
    
    function skipWhitespace() {
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
    }
    
    function parseValue(inArray: boolean = false): any {
        if (depth > 100) {
            throw new Error('Depth limit exceeded in parseResilientJSON');
        }
        depth++;
        try {
            skipWhitespace();
            if (i >= text.length) return undefined;
            
            const char = text[i];
            if (char === '{') {
                return parseObject();
            } else if (char === '[') {
                return parseArray();
            } else if (char === '"') {
                return parseString(inArray);
            } else if (char === 't' && text.startsWith('true', i)) {
                i += 4;
                return true;
            } else if (char === 'f' && text.startsWith('false', i)) {
                i += 5;
                return false;
            } else if (char === 'n' && text.startsWith('null', i)) {
                i += 4;
                return null;
            } else if (/[0-9.-]/.test(char)) {
                return parseNumber();
            }
            
            if (char === undefined) return undefined;
            throw new Error(`Unexpected character '${char}' at index ${i}`);
        } finally {
            depth--;
        }
    }
    
    function parseObject(): Record<string, any> {
        const obj: Record<string, any> = {};
        i++; // skip '{'
        
        while (i < text.length) {
            skipWhitespace();
            if (i >= text.length || text[i] === undefined) {
                return obj;
            }
            if (text[i] === '}') {
                i++; // skip '}'
                return obj;
            }
            
            if (text[i] !== '"') {
                if (text[i] === undefined || obj.tool_call || obj.tool_calls) {
                    return obj;
                }
                throw new Error(`Expected '"' at index ${i} but got '${text[i]}'`);
            }
            
            const key = parseString(false);
            skipWhitespace();
            
            if (i >= text.length || text[i] === undefined) {
                return obj;
            }
            if (text[i] !== ':') {
                if (obj.tool_call || obj.tool_calls) return obj;
                throw new Error(`Expected ':' at index ${i} but got '${text[i]}' (key was '${key}')`);
            }
            i++; // skip ':'
            
            const val = parseValue(false);
            obj[key] = val;
            
            skipWhitespace();
            if (i >= text.length || text[i] === undefined) {
                return obj;
            }
            if (text[i] === ',') {
                i++; // skip ','
            } else if (text[i] !== '}') {
                if (obj.tool_call || obj.tool_calls) {
                    return obj;
                }
                throw new Error(`Expected ',' or '}' at index ${i} but got '${text[i]}'`);
            }
        }
        return obj;
    }
    
    function parseArray(): any[] {
        const arr: any[] = [];
        i++; // skip '['
        
        while (i < text.length) {
            skipWhitespace();
            if (i >= text.length || text[i] === undefined) {
                return arr;
            }
            if (text[i] === ']') {
                i++; // skip ']'
                return arr;
            }
            
            const val = parseValue(true);
            arr.push(val);
            
            skipWhitespace();
            if (i >= text.length || text[i] === undefined) {
                return arr;
            }
            if (text[i] === ',') {
                i++; // skip ','
            } else if (text[i] !== ']') {
                throw new Error(`Expected ',' or ']' at index ${i} but got '${text[i]}'`);
            }
        }
        return arr;
    }
    
    function parseString(_inArray: boolean = false): string {
        i++; // skip opening '"'
        
        const contentStart = i;
        
        while (i < text.length) {
            if (text[i] === '"') {
                let backslashCount = 0;
                let k = i - 1;
                while (k >= contentStart && text[k] === '\\') {
                    backslashCount++;
                    k--;
                }
                if (backslashCount % 2 === 0) {
                    const strVal = text.substring(contentStart, i);
                    i++; // skip closing '"'
                    return decodeEscapedString(strVal);
                }
            }
            
            if (text[i] === '\\') {
                i += 2;
            } else {
                i++;
            }
        }
        
        const strVal = text.substring(contentStart);
        i = text.length;
        return decodeEscapedString(strVal);
    }
    
    function decodeEscapedString(s: string): string {
        return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, p1) => {
            if (p1.startsWith('u')) {
                return String.fromCharCode(parseInt(p1.slice(1), 16));
            }
            if (p1 === 'n') return '\n';
            if (p1 === 't') return '\t';
            if (p1 === 'r') return '\r';
            if (p1 === 'b') return '\b';
            if (p1 === 'f') return '\f';
            return p1;
        });
    }
    
    function parseNumber(): number {
        let numStr = '';
        while (i < text.length && /[0-9.eE+-]/.test(text[i])) {
            numStr += text[i];
            i++;
        }
        return Number(numStr);
    }
    
    const result = parseValue();
    return { obj: result, endIdx: i };
}

function isToolUnsupportedError(errorStr: string): boolean {
    const lower = errorStr.toLowerCase();
    return lower.includes('tools') || 
           lower.includes('tool_choice') || 
           lower.includes('functions') || 
           lower.includes('unsupported parameter') ||
           lower.includes('unrecognized parameter') ||
           lower.includes('extra fields') ||
           lower.includes('invalid') ||
           lower.includes('400') ||
           lower.includes('bad request');
}

function extractToolCallsFromText(text: string, validToolNames?: Set<string>): any[] {
    const toolCalls: any[] = [];
    const VALID_TOOL_NAMES = validToolNames || new Set(TOOLS.map(t => t.name));
    
    let idx = 0;
    while (true) {
        const startIdx = text.indexOf('{', idx);
        if (startIdx === -1) {
            break;
        }
        
        try {
            const { obj, endIdx } = parseResilientJSON(text, startIdx);
            if (obj && typeof obj === 'object') {
                let added = false;
                
                // Case 1: {"tool_calls": [...]}
                if (Array.isArray(obj.tool_calls)) {
                    let itemIdx = 0;
                    for (const tc of obj.tool_calls) {
                        if (tc && typeof tc.name === 'string' && VALID_TOOL_NAMES.has(tc.name)) {
                            const toolId = tc.id || `text_call_${startIdx}_${itemIdx}`;
                            toolCalls.push({
                                id: toolId,
                                type: 'function',
                                function: {
                                    name: tc.name,
                                    arguments: typeof tc.arguments === 'string'
                                        ? tc.arguments
                                        : JSON.stringify(tc.arguments || {})
                                }
                            });
                            added = true;
                        }
                        itemIdx++;
                    }
                }
                // Case 2: {"tool_call": {...}}
                else if (obj.tool_call && typeof obj.tool_call === 'object' && typeof obj.tool_call.name === 'string' && VALID_TOOL_NAMES.has(obj.tool_call.name)) {
                    const tc = obj.tool_call;
                    const toolId = tc.id || `text_call_${startIdx}_0`;
                    toolCalls.push({
                        id: toolId,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: typeof tc.arguments === 'string'
                                ? tc.arguments
                                : JSON.stringify(tc.arguments || {})
                        }
                    });
                    added = true;
                }
                // Case 3: Direct {"name": "...", "arguments": {...}}
                else if (typeof obj.name === 'string' && VALID_TOOL_NAMES.has(obj.name)) {
                    const toolId = obj.id || `text_call_${startIdx}_0`;
                    toolCalls.push({
                        id: toolId,
                        type: 'function',
                        function: {
                            name: obj.name,
                            arguments: typeof obj.arguments === 'string'
                                ? obj.arguments
                                : JSON.stringify(obj.arguments || {})
                        }
                    });
                    added = true;
                }
                
                if (added) {
                    idx = endIdx;
                    continue;
                }
            }
        } catch (e) {
            // Ignore and move past the '{'
        }
        idx = startIdx + 1;
    }
    return toolCalls;
}

function cleanToolCallsFromText(text: string, validToolNames?: Set<string>): string {
    let cleanContent = text;
    const VALID_TOOL_NAMES = validToolNames || new Set(TOOLS.map(t => t.name));
    const rangesToRemove: { start: number; end: number }[] = [];

    let idx = 0;
    while (true) {
        const startIdx = cleanContent.indexOf('{', idx);
        if (startIdx === -1) {
            break;
        }

        try {
            const { obj, endIdx } = parseResilientJSON(cleanContent, startIdx);
            if (obj && typeof obj === 'object') {
                let matched = false;
                
                if (Array.isArray(obj.tool_calls)) {
                    matched = obj.tool_calls.some((tc: any) => tc && typeof tc.name === 'string' && VALID_TOOL_NAMES.has(tc.name));
                } else if (obj.tool_call && typeof obj.tool_call === 'object' && typeof obj.tool_call.name === 'string' && VALID_TOOL_NAMES.has(obj.tool_call.name)) {
                    matched = true;
                } else if (typeof obj.name === 'string' && VALID_TOOL_NAMES.has(obj.name)) {
                    matched = true;
                }

                if (matched) {
                    rangesToRemove.push({ start: startIdx, end: endIdx });
                    idx = endIdx;
                    continue;
                }
            }
        } catch (e) {
            // Ignore
        }
        idx = startIdx + 1;
    }

    for (let i = rangesToRemove.length - 1; i >= 0; i--) {
        const range = rangesToRemove[i];
        cleanContent = cleanContent.substring(0, range.start) + cleanContent.substring(range.end);
    }

    cleanContent = cleanContent.replace(/```json\s*```/g, '');
    cleanContent = cleanContent.replace(/```\s*```/g, '');
    
    return cleanContent.trim();
}

function sanitizeMessages(messages: any[]): any[] {
    if (messages.length === 0) return [];

    // Clone messages to avoid mutating the original history by reference
    const cloned = messages.map(msg => {
        const copy = { ...msg };
        if (copy.tool_calls && Array.isArray(copy.tool_calls)) {
            copy.tool_calls = copy.tool_calls.map((tc: any) => ({
                ...tc,
                function: tc.function ? { ...tc.function } : undefined
            }));
        }
        return copy;
    });

    const sanitized: any[] = [];
    
    // 1. Ensure the first message is system prompt
    let systemPrompt: any = null;
    for (let i = 0; i < cloned.length; i++) {
        if (cloned[i].role === 'system') {
            if (!systemPrompt) {
                systemPrompt = cloned[i];
                break;
            }
        }
    }

    if (!systemPrompt) {
        systemPrompt = { role: 'system', content: 'You are a helpful coding assistant.' };
    }
    sanitized.push(systemPrompt);

    // Find the index of the first non-system message
    let firstNonSystemIdx = -1;
    for (let i = 0; i < cloned.length; i++) {
        if (cloned[i].role !== 'system') {
            firstNonSystemIdx = i;
            break;
        }
    }

    if (firstNonSystemIdx === -1) {
        return sanitized;
    }

    // 2. We need a user message to start the conversation after the system prompt.
    // If the first non-system message is not a user message (e.g. it is assistant/tool due to pruning),
    // insert a placeholder user message first.
    const firstMsg = cloned[firstNonSystemIdx];
    if (firstMsg.role !== 'user') {
        sanitized.push({ role: 'user', content: 'Continuing task execution...' });
    }

    // 3. Process remaining messages
    for (let i = firstNonSystemIdx; i < cloned.length; i++) {
        const msg = cloned[i];
        if (msg.role === 'system') {
            continue; // Skip extra system messages
        }
        if (msg.role === 'user') {
            sanitized.push(msg);
        } else if (msg.role === 'assistant') {
            sanitized.push(msg);
        } else if (msg.role === 'tool') {
            // Find preceding assistant message in sanitized list
            let lastAssistantIdx = -1;
            for (let j = sanitized.length - 1; j >= 0; j--) {
                if (sanitized[j].role === 'assistant') {
                    lastAssistantIdx = j;
                    break;
                }
            }

            if (lastAssistantIdx !== -1) {
                const lastAssistant = sanitized[lastAssistantIdx];
                // Ensure the assistant has tool_calls
                if (!Array.isArray(lastAssistant.tool_calls)) {
                    lastAssistant.tool_calls = [];
                }
                // Ensure the tool_call_id exists in the assistant's tool_calls
                const hasCallId = lastAssistant.tool_calls.some((tc: any) => tc.id === msg.tool_call_id);
                if (!hasCallId) {
                    // Find an existing tool call in the same assistant message that contains a thought_signature
                    const existingTcWithSig = lastAssistant.tool_calls.find((x: any) => x.thought_signature || x.function?.thought_signature);
                    
                    // Add a mock tool call to match this tool response
                    const mockTc: any = {
                        id: msg.tool_call_id,
                        type: 'function',
                        function: {
                            name: msg.name || 'unknown_tool',
                            arguments: '{}'
                        }
                    };
                    
                    if (existingTcWithSig) {
                        if (existingTcWithSig.thought_signature) {
                            mockTc.thought_signature = existingTcWithSig.thought_signature;
                        }
                        if (existingTcWithSig.function?.thought_signature) {
                            mockTc.function.thought_signature = existingTcWithSig.function.thought_signature;
                        }
                    } else if (lastAssistant.thought_signature) {
                        // Borrow thought_signature from the assistant message itself if available
                        mockTc.thought_signature = lastAssistant.thought_signature;
                    }
                    
                    lastAssistant.tool_calls.push(mockTc);
                }
                sanitized.push(msg);
            } else {
                // Orphaned tool message with no preceding assistant message. Skip it to avoid 400 error.
            }
        }
    }

    // 4. Ensure all assistant messages with tool_calls have matching tool responses immediately following them
    const finalMessages: any[] = [];
    for (let i = 0; i < sanitized.length; i++) {
        const msg = sanitized[i];
        finalMessages.push(msg);

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            // Find all tool messages that follow this assistant message
            const toolCallIds = msg.tool_calls.map((tc: any) => tc.id);
            const toolResponses = new Map<string, any>();

            // Look ahead for tool messages matching these IDs (bounded to prevent runaway)
            let j = i + 1;
            const maxLookahead = Math.min(i + 1 + toolCallIds.length * 2, sanitized.length);
            while (j < maxLookahead) {
                const nextMsg = sanitized[j];
                if (nextMsg.role === 'tool' && toolCallIds.includes(nextMsg.tool_call_id)) {
                    toolResponses.set(nextMsg.tool_call_id, nextMsg);
                    j++;
                } else if (nextMsg.role === 'tool') {
                    // Some other tool message? Let's skip/consume it
                    j++;
                } else {
                    // Hit a user or assistant message, stop looking ahead
                    break;
                }
            }

            // Append matching tool responses in the order of tool_calls
            for (const callId of toolCallIds) {
                const resp = toolResponses.get(callId);
                if (resp) {
                    finalMessages.push(resp);
                } else {
                    // Missing tool response! Insert placeholder to avoid 400 Bad Request
                    const toolCall = msg.tool_calls.find((tc: any) => tc.id === callId);
                    finalMessages.push({
                        role: 'tool',
                        tool_call_id: callId,
                        name: toolCall?.function?.name || 'unknown_tool',
                        content: 'Error: Tool execution was cancelled or failed to return a result.'
                    });
                }
            }

            // Skip the tool messages we've already consumed in our lookahead
            i = j - 1;
        }
    }

    return finalMessages;
}

function detectRepetitiveLoop(text: string): boolean {
    const len = text.length;
    if (len < 45) return false;
    const maxL = Math.floor(len / 3);
    for (let L = 15; L <= maxL; L++) {
        const chunk1 = text.substring(len - L);
        const chunk2 = text.substring(len - 2 * L, len - L);
        const chunk3 = text.substring(len - 3 * L, len - 2 * L);
        if (chunk1 === chunk2 && chunk2 === chunk3) {
            return true;
        }
    }
    return false;
}
