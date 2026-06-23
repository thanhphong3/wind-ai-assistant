# Wind AI - Autonomous AI Coding Assistant

Wind AI is a next-generation, autonomous AI coding assistant integrated directly into Visual Studio Code. Designed to act as an agentic pair-programmer, Wind AI can discuss design patterns, write complex features, execute workspace commands, edit files with high precision, and even run local browser-based testing autonomously.

---

## Key Features

- 🤖 **Autonomous Coding Agent**: Wind AI doesn't just suggest code snippets; it can plan and execute coding tasks, modify workspace files, and run commands.
- 💬 **Interactive Sidebar Chat**: A sleek, user-friendly chat interface built into the activity bar for seamless communication and brainstorming.
- 🖥️ **Command Execution & Control**: Secure, policy-guided terminal command execution, supporting foreground builds or long-running background tasks.
- 🌐 **Web Automation Subagent**: Leverages your locally installed web browser (Chrome, Edge, Firefox) to navigate, click, type, and capture screenshots for frontend verification and web scraping.
- 🔍 **Advanced Workspace Search**: Deep semantic code search, regex file scanning (grep), and symbol search to help the AI understand large codebases.
- ⚙️ **Flexible Configuration**: Full settings UI allowing you to choose your LLM provider, endpoint, API keys, auto-execution preferences, and default web browser.

---

## Getting Started

### 1. Installation
Install the extension in Visual Studio Code from the Marketplace (or import the packaged `.vsix` file).

### 2. Configure Settings
Configure your LLM model and API credentials:
1. Press `Ctrl+,` (or `Cmd+,` on macOS) to open VS Code settings.
2. Search for **Wind Settings**.
3. Set your **API Key**, **API Endpoint** (defaults to the Gemini endpoint), and preferred **Model** (e.g. `gemini-3.5-flash`).

### 3. Open the Chat Sidebar
Click on the **Wind AI** icon in the Activity Bar to launch the chat view. Enter a prompt, and watch the AI agent analyze, plan, and execute coding tasks for you!

---

## Detailed Settings Configuration

Wind AI supports several configuration properties under the `gravityAgent` namespace:

| Setting | Default Value | Description |
| :--- | :--- | :--- |
| `gravityAgent.apiKey` | `""` | The API Key for your LLM provider. |
| `gravityAgent.apiEndpoint` | `https://generativelanguage.googleapis.com/v1beta/openai` | The API endpoint URL (supports OpenAI-compatible schemas). |
| `gravityAgent.model` | `gemini-3.5-flash` | The model to use for agent interactions. |
| `gravityAgent.autoExecution` | `Ask for Approval` | Options: `Ask for Approval` or `Always Proceed`. Controls whether the agent must ask before running terminal commands or modifying files. |
| `gravityAgent.autoExecutePlan`| `false` | Automatically start executing the plan after generating it. |
| `gravityAgent.browser` | `auto` | Preferred browser for running web automation and testing (`auto`, `chrome`, `edge`, `firefox`). |
| `gravityAgent.enableInlineCompletion` | `true` | Enable/disable inline code completions (ghost text) as you type. |

---

## Requirements & Dependencies

- **Web Browser**: For web automation tasks (`browserSubagent`, `browserOpen`), Wind AI integrates with your locally installed Google Chrome, Microsoft Edge, or Mozilla Firefox browser.
- **Node.js**: Requires Node.js runtime environment (VS Code standard).

---

## Security & Guardrails

- **Workspace Anchoring**: The agent is restricted to reading and writing files strictly within the bounds of your active workspace directory to prevent accidental access to external system directories.
- **Auto Execution Policy**: By default, the agent is configured in `Ask for Approval` mode. Every file edit, command execution, or browser subagent invocation must be approved by the developer.

---

## License

This extension is licensed under the [MIT License](LICENSE).
