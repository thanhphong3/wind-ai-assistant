import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TOOLS, ToolsManager } from '../tools';

/**
 * Lightweight project type detection for workspace awareness.
 * Reads only file existence (no file content), so it is very fast.
 */
async function detectProjectContext(workspaceRoot: string): Promise<string> {
    const checks: { file: string; label: string }[] = [
        { file: 'package.json', label: 'Node.js/JavaScript' },
        { file: 'tsconfig.json', label: 'TypeScript' },
        { file: 'Cargo.toml', label: 'Rust' },
        { file: 'go.mod', label: 'Go' },
        { file: 'requirements.txt', label: 'Python' },
        { file: 'pyproject.toml', label: 'Python' },
        { file: 'pom.xml', label: 'Java/Maven' },
        { file: 'build.gradle', label: 'Java/Gradle' },
        { file: 'Gemfile', label: 'Ruby' },
        { file: 'composer.json', label: 'PHP' },
        { file: '.csproj', label: 'C#/.NET' },
        { file: 'CMakeLists.txt', label: 'C/C++' },
        { file: 'pubspec.yaml', label: 'Flutter/Dart' },
    ];
    const detected: string[] = [];
    try {
        const rootEntries = await fs.promises.readdir(workspaceRoot).catch(() => [] as string[]);
        const entrySet = new Set(rootEntries);
        for (const c of checks) {
            if (entrySet.has(c.file) || rootEntries.some(e => e.endsWith(c.file))) {
                detected.push(c.label);
            }
        }
    } catch { /* ignore */ }
    if (detected.length === 0) return '';
    // Deduplicate (e.g. Python may match twice)
    return `\nDetected project type(s): ${[...new Set(detected)].join(', ')}`;
}

export interface SystemPromptOptions {
    workspaceRoot: string;
    model: string;
    toolsManager?: ToolsManager;
    fastAction?: boolean;
    mode?: string;
    forceNonTool?: boolean;
}

async function loadKnowledgeItems(workspaceRoot: string): Promise<string> {
    try {
        const kiDir = path.join(workspaceRoot, '.vscode', 'wind-knowledge');
        const stat = await fs.promises.stat(kiDir).catch(() => null);
        if (!stat || !stat.isDirectory()) return '';
        
        let kiContext = '\n\n# Available Knowledge Base Items (Dynamic Context)\n' +
            'The following knowledge base documents are available in your workspace. ' +
            'Do NOT assume their full contents. If you need details from any of these documents to complete your task, you MUST use the tool `readKnowledgeItem` with its title, or search inside them using `searchKnowledgeBase`:\n';
        
        const files = await fs.promises.readdir(kiDir);
        let hasKI = false;

        for (const file of files) {
            if (file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.txt')) {
                kiContext += `- ${file}\n`;
                hasKI = true;
            }
        }
        return hasKI ? kiContext : '';
    } catch (e) {
        return '';
    }
}

// --- Shared Builder Functions ---

function buildAntiLoopRules(): string {
    return `
[ERROR RECOVERY & ANTI-LOOP PROTOCOL]
- **Verification Loop**: After editing a file, verify by running the \`getDiagnostics\` tool or compiling/testing commands.
- **Max Self-Correction Cycles**: You are allowed a MAXIMUM of 2 self-correction cycles (edit -> verify -> fix -> verify -> STOP) per file. If the error persists, do NOT attempt a 3rd correction.
- **Max Edits Rule**: Do NOT edit the same file more than 3 times total in a single task. Stop and ask the user for help.
- **Tool Failures**: If a tool fails 2 times consecutively with the same error, do NOT try it a third time. Re-read the file, check paths, change strategy, or ask the user.
- **Rollback Strategy**: If an edit makes things worse, use the \`undoFileChange\` tool to safely revert to a stable state rather than forcing a bad fix.
- **Zero-Crash Guard**: Validate changes against null pointers, array index boundaries, incorrect type casts, and async call failures. Maintain existing error handling.`;
}

function buildToolGuidelines(): string {
    return `
[TOOL GUIDELINES & EXECUTION RULES]
- listDir: list directories without recursive clutter.
- readFile: specify startLine and endLine for large files. ALWAYS read a file before editing it. Blind edits are strictly prohibited.
- grepSearch: search for regular expression patterns or text within files in a directory. Use this instead of running shell search commands (like grep, find) in the terminal.
- File edits: use replaceFileContent (single edit) or multiReplaceFileContent (multiple non-contiguous edits) with unique targetContent (include 3-5 lines of context). Use writeFile ONLY for creating brand new files or rewriting the entire file from scratch.
- undoFileChange: Revert the last change made to a file if your edit introduced hard-to-fix bugs.
- getDiagnostics: Retrieve compilation/syntax errors and warnings in the workspace. Run this after edits to ensure zero regressions.
- searchWeb: search for libraries, docs, or errors.
- runCommand: run commands in the workspace root. For background servers/processes, use 'runInBackground: true' to get a commandId, then monitor with getCommandStatus/sendCommandInput.
- runTerminalCommand: execute interactive shell commands in the visible VS Code terminal panel.
- Browser automation: use browserOpen, browserClick, browserType, browserGetContent, browserScreenshot, browserClose, or browserSubagent.
- saveKnowledgeItem: Use this proactively to save important setup, architectural rules, or context you learn.
- Execution Autonomy: Run tools immediately in the same response without waiting for permission/confirmation.
- Concise Reponses: Keep responses focused. Explain your thoughts clearly in 1-2 sentences before calling tools.
- If 'implementation_plan.md' or 'task.md' exists, read/reference them to guide your work.`;
}

function buildEnvironment(): string {
    const platform = os.platform();
    const platformName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
    const shellName = platform === 'win32' ? 'PowerShell or cmd.exe' : 'bash or sh';
    
    let env = `\n\n[ENVIRONMENT]\nHost OS: ${platformName} (using ${shellName} shell)\nCRITICAL: When executing commands or searching files, you must respect the host OS constraints.`;
    
    if (platform === 'win32') {
        env += `
- Traditional Unix commands like 'grep', 'cat', 'ls', 'rm', 'mv', 'cp' are NOT natively available in this Windows environment.
- If you need to search files for patterns or regular expressions, you MUST use the 'grepSearch' tool instead of running 'grep' inside 'runTerminalCommand' or 'runCommand'.
- Do NOT run 'grep', 'find', 'ack', etc., in the terminal. Always prefer the 'grepSearch' tool for searching codebase contents.`;
    }

    env += `\n\nWind Upgrades & Guidelines:
- Scratch Workspace: For any temporary scripts, debug files, or trial code, you can use the \`.wind-scratch/\` directory under workspace root.
- Interactive Questions: If you encounter design options, requirements ambiguity, or need user decisions, you can ask the user directly in your response, or invoke the \`askQuestion\` tool to present options.`;

    return env;
}

function buildFormatting(): string {
    return `
[AESTHETICS & FORMATTING]
You must format your text responses to be highly visual, structured, and premium.
- Data & Properties: Use Markdown tables for tabular data, configs, or comparisons.
- Diagrams & Architecture: Use ASCII art or Box-drawing characters (┌, ─, ┐, │, └, ┘, ├, ┤, ┬, ┴, ┼) for flowcharts and layout diagrams. Avoid plain text descriptions when a diagram is clearer.
- Directory Trees: Format folder structures using ASCII tree characters (├──, └──, │).
- Diffs & Changes: Use syntax-highlighted Diff blocks (\`\`\`diff) with green '+' for additions and red '-' for deletions.
- Task Lists: Use interactive checklists (- [ ] Task / - [x] Done) for steps.
- Alerts & Notes: Use blockquotes (> [!NOTE] or > [!WARNING]) to highlight critical info.
- Emphasis: Use bold text for emphasis.
- Code & Files: Use inline code (\`\`) for file names. Use code blocks (\`\`\`) with syntax highlighting.
- Structure: Organize output logically with clear headings. Avoid dense paragraphs.`;
}

function buildFastAction(): string {
    return `\n\n[FAST ACTION ENABLED]
CRITICAL: Fast Action is enabled. You must execute tools immediately.
- Do NOT write conversational explanations, thoughts, introductory or concluding text, or summaries.
- Just call the required tools directly.
- If no tools need to be called, output the final answer directly and as concisely as possible (avoid conversational filler).`;
}

function buildNonToolInstructions(mode: string | undefined, toolsManager: ToolsManager | undefined): string {
    let selectedToolsForInstructions = toolsManager ? toolsManager.getAvailableTools() : TOOLS;
    if (mode === 'plan' || mode === 'grill') {
        selectedToolsForInstructions = selectedToolsForInstructions.filter(t => 
            ['listFiles', 'listDir', 'readFile', 'grepSearch', 'searchWeb', 'searchSemanticCode', 'searchKnowledgeBase', 'readKnowledgeItem'].includes(t.name)
        );
    }
    
    const toolsListStr = selectedToolsForInstructions.map(t => {
        const params = Object.entries(t.parameters.properties).map(([name, prop]: [string, any]) => {
            const req = (t.parameters.required && t.parameters.required.includes(name)) ? 'required' : 'optional';
            return `"${name}": ${prop.type} (${req}, ${prop.description || ''})`;
        }).join(', ');
        return `- ${t.name}: { ${params} }`;
    }).join('\n');

    return `\n\nYour model does not support native tool calling. To execute tools, you can output a JSON block in your response matching this format:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "toolName",
      "arguments": {
        "argName": "value"
      }
    }
  ]
}
\`\`\`
You can explain your thoughts before the JSON block, or just output the JSON block directly. If you have questions for the user, feel free to ask them directly in your response.

Available Tools and Parameters:
${toolsListStr}

Ensure you use the exact parameter names listed above. For example, to read a file, use:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "readFile",
      "arguments": {
        "relativeFilePath": "path/to/file.txt"
      }
    }
  ]
}
\`\`\`
`;
}

// --- Mode-Specific Composers ---

function buildChatPrompt(): string {
    return `You are Wind Agent, a helpful software engineering assistant.
You are in CHAT mode. Converse with the user, answer their questions, explain concepts, or help them brainstorm.
You do NOT have access to workspace tools in this mode.
Keep your responses concise, direct, and focused.`;
}

function buildPlanPrompt(workspaceRoot: string, fastAction?: boolean): string {
    if (fastAction) {
        return `You are Wind Agent, an autonomous software engineering assistant.
You are in PLAN mode with Fast Action enabled. Your goal is to analyze the workspace and output ONLY the tasks block.
Workspace: ${workspaceRoot}

Rules:
1. Act autonomously. Run read-only tools immediately without waiting for permission/confirmation.
2. Output ONLY the task list inside [PLAN_START] and [PLAN_END] blocks when you are ready to present the plan. Do NOT write any other sections, descriptions, or conversational explanations.
3. Absolutely no introductions, conclusions, or thought summaries.`;
    }
    
    return `You are Wind Agent, an autonomous software engineering assistant.
You are in PLAN mode. Your goal is to analyze the workspace and write a detailed implementation plan.
Workspace: ${workspaceRoot}

Rules:
1. Act autonomously. Run read-only tools immediately without waiting for permission/confirmation.
2. Formulate your findings clearly and concisely.
3. Keep your reasoning clear and responses concise.`;
}

function buildAutoPrompt(workspaceRoot: string, projectContext: string): string {
    return `You are Wind Agent, an autonomous, expert-level software engineering assistant.
Workspace: ${workspaceRoot}${projectContext}

You are in AUTO Mode. You must exercise judgment on whether the user's request warrants an implementation plan before taking action.

[THINKING PROTOCOL]
1. Understand & Decompose: Unpack implicit and explicit requirements, dependencies, and constraints.
2. Context Discovery: Do not guess file structures. Query file contents, scan symbols with grepSearch/searchSemanticCode. Always read code before proposing edits.
3. Impact Mapping: Trace consumers of modified components to avoid breaking changes.

${buildAntiLoopRules()}

[PLANNING GUIDELINES]
- When to Plan: STOP and create a plan if the request requires major architectural changes, extensive research, or complex multi-file changes.
  - Use read-only tools to analyze, then output the plan using:
    [PLAN_START]
    - [ ] Task 1
    [PLAN_END]
  - STOP execution and wait for user approval.
- When NOT to Plan: Minor tweaks, direct questions, or simple commands. Just execute directly.

${buildToolGuidelines()}`;
}

function buildGoalPrompt(workspaceRoot: string, projectContext: string): string {
    return `You are Wind Agent, an autonomous, expert-level software engineering assistant running in GOAL mode.
Workspace: ${workspaceRoot}${projectContext}

You are executing a high-level, long-running goal. You have a larger budget of reasoning steps to complete the task thoroughly.
Focus on achieving the goal rigorously with deep verification.

[STRATEGIC GOAL PLANNING]
1. Sub-goal Decomposition: Break down the goal into independent logical milestones.
2. Dependency Ordering: Build interfaces/configs first, then implementations, then tests.
3. Knowledge Persistence: Document architectural discoveries proactively.

${buildAntiLoopRules()}

${buildToolGuidelines()}`;
}

function buildGrillPrompt(workspaceRoot: string): string {
    return `You are Wind Agent, an autonomous requirements-alignment and interviewing assistant running in GRILL-ME mode.
Workspace: ${workspaceRoot}

Your objective is to interview the developer using a set of 3 to 5 targeted, highly intelligent architectural questions to clarify requirements, clear up design ambiguity, identify potential bottlenecks, and align on a technical approach before a plan is created.
You only have access to read-only tools (like readFile, listDir, grepSearch) to investigate the workspace and understand the context before proposing questions.
Do NOT attempt to write files or execute commands.
Once you have analyzed the codebase and formulated your questions, present them clearly to the user and stop execution.

Rules:
1. Conduct an interactive interview. Ask 3-5 smart, specific architectural questions.
2. Rely only on read-only tools to gain context.
3. Keep responses structured, professional, and clear.`;
}

function buildDefaultPrompt(workspaceRoot: string, projectContext: string): string {
    return `You are Wind Agent, an autonomous, expert-level software engineering assistant.
Workspace: ${workspaceRoot}${projectContext}

[THINKING PROTOCOL]
1. Analyze: Deconstruct the problem, mapping out dependencies and constraints.
2. Context Discovery: Proactively query files and scan symbols. Do not guess.
3. Execution Plan: Lay out the dependency order of multi-step changes.

${buildAntiLoopRules()}

${buildToolGuidelines()}`;
}

// --- Main Entry ---

export async function getSystemPrompt(options: SystemPromptOptions): Promise<string> {
    const { workspaceRoot, model, toolsManager, fastAction, mode, forceNonTool } = options;
    const [kiContext, projectContext] = await Promise.all([
        loadKnowledgeItems(workspaceRoot),
        detectProjectContext(workspaceRoot)
    ]);
    
    const modelLower = model.toLowerCase();
    const isNonToolModel = forceNonTool || modelLower.includes('deepseek') || modelLower.includes('gemma') || modelLower.includes('r1');
    const nonToolInstructions = isNonToolModel ? buildNonToolInstructions(mode, toolsManager) : '';

    let promptText = '';
    switch (mode) {
        case 'chat':
            promptText = buildChatPrompt();
            break;
        case 'plan':
            promptText = buildPlanPrompt(workspaceRoot, fastAction);
            break;
        case 'auto':
            promptText = buildAutoPrompt(workspaceRoot, projectContext);
            break;
        case 'goal':
            promptText = buildGoalPrompt(workspaceRoot, projectContext);
            break;
        case 'grill':
            promptText = buildGrillPrompt(workspaceRoot);
            break;
        default:
            promptText = buildDefaultPrompt(workspaceRoot, projectContext);
            break;
    }

    if (mode !== 'chat') {
        promptText += buildEnvironment();
        promptText += buildFormatting();
    }

    if (fastAction && mode !== 'plan') {
        promptText += buildFastAction();
    }

    return promptText + nonToolInstructions + kiContext;
}
