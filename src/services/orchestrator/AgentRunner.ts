import { ChromeAIService } from '../ai/ChromeAIService';
import { Agent } from '../../store/db';
import { IMcpClient } from '../mcp/interfaces';
import { extractJson } from '../../utils/jsonUtils';

export class AgentRunner {
    private ai: ChromeAIService;

    constructor() {
        this.ai = ChromeAIService.getInstance();
    }

    private async constructSystemPrompt(agent: Agent, tools: any[]): Promise<string> {
        let prompt = agent.systemPrompt + "\n";

        if (tools.length > 0) {
            prompt += "\n=== TOOLS AND CAPABILITIES ===\n";
            prompt += "You ARE capable of interacting with the real world (browser, DOM, network, etc.) through the tools listed below.\n";
            prompt += "NEVER claim you are 'just a language model' or 'cannot interact with the internet' if a relevant tool is available.\n";
            prompt += "When a user asks you to perform an action (e.g., 'go to a website', 'click a button'), you MUST use the corresponding tool.\n";

            prompt += "\n=== AVAILABLE TOOLS ===\n";
            prompt += JSON.stringify(tools, null, 2);

            prompt += "\n\n=== HOW TO USE TOOLS ===\n";
            prompt += "To use a tool, respond with ONLY a JSON object in this exact format:\n";
            prompt += `{"tool": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}\n`;
            prompt += "\nDo NOT include any markdown formatting, preambles, or explanations in the same message as a tool call.\n";
            prompt += "The `arguments` object MUST satisfy the tool's `inputSchema`.\n";
            prompt += "After using a tool, you'll receive the result and can then provide your final answer or another tool call.\n";
        }

        return prompt;
    }

    private extractToolCall(response: string): { tool: string; args: any } | null {
        // Normal model output is often conversational; avoid spamming warnings here.
        const potentialJson = extractJson(response, { logFailure: false });
        if (!potentialJson || typeof potentialJson !== 'object') return null;

        // Primary expected shape:
        // { tool: string, arguments?: object }
        const tool =
            typeof potentialJson.tool === 'string'
                ? potentialJson.tool
                : typeof potentialJson.toolName === 'string'
                    ? potentialJson.toolName
                    : typeof potentialJson.name === 'string'
                        ? potentialJson.name
                        : null;

        if (!tool) return null;

        const args =
            potentialJson.arguments ??
            potentialJson.args ??
            potentialJson.params ??
            {}; // allow no-args tool calls like {"tool":"get_time"}

        return { tool, args };
    }

    private shouldForceGetTime(toolName: string | undefined, task: string): boolean {
        if (toolName !== 'get_time') return false;
        const t = task.toLowerCase();
        return t.includes('time') || t.includes('current time') || t.includes('what time') || t.includes('date');
    }

    private shouldForceNavigate(toolName: string | undefined, task: string): { url: string } | null {
        if (toolName !== 'navigate') return null;
        const t = task.toLowerCase();

        // Simple extraction for common patterns
        if (t.includes('go to ') || t.includes('open ') || t.includes('navigate to ')) {
            // Try to find something that looks like a URL
            const match = task.match(/https?:\/\/[^\s]+/) || task.match(/[a-zA-Z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?/);
            if (match) {
                let url = match[0];
                if (!url.startsWith('http')) url = 'https://' + url;
                return { url };
            }
        }
        return null;
    }

    private shouldForceEcho(toolName: string | undefined): boolean {
        // Demo reliability: if an agent is explicitly wired to `echo`, always allow forcing it.
        return toolName === 'echo';
    }

    public async run(agent: Agent, task: string, mcpClients: Map<string, IMcpClient>): Promise<string> {
        // 1. Gather tools
        let tools: any[] = [];
        if (agent.assignedTool) {
            const client = mcpClients.get(agent.assignedTool.serverId);
            if (client) {
                try {
                    const serverTools = await client.listTools();
                    const t = serverTools.find(t => t.name === agent.assignedTool!.toolName);
                    if (t) tools.push(t);
                } catch (e) {
                    console.error("Failed to fetch tools", e);
                }
            }
        }

        // 2. Create Session
        const systemPrompt = await this.constructSystemPrompt(agent, tools);
        const session = await this.ai.createSession({
            systemPrompt,
            language: 'en'
        });

        console.log(`[${agent.name}] Starting execution with task: ${task.substring(0, 100)}...`);

        // 3. Prompt
        let response = await this.ai.generate(task, session);
        let maxTurns = 3;
        let currentTurn = 0;

        // 4. Check for Tool Call (Basic JSON detection)
        while (currentTurn < maxTurns) {
            try {
                const toolCall = this.extractToolCall(response);
                if (toolCall) {
                    console.log(`[${agent.name}] Tool call detected:`, toolCall.tool);

                    if (agent.assignedTool && mcpClients.has(agent.assignedTool.serverId)) {
                        try {
                            const client = mcpClients.get(agent.assignedTool.serverId)!;
                            console.log(`[${agent.name}] Executing tool '${toolCall.tool}' with args:`, toolCall.args);
                            const result = await client.callTool(toolCall.tool, toolCall.args);

                            // Feed back
                            const toolOutput = `Tool '${toolCall.tool}' output: ${JSON.stringify(result)}`;
                            console.log(`[${agent.name}] Tool output received, generating follow-up...`);
                            response = await this.ai.generate(toolOutput, session);
                            currentTurn++;
                            continue;
                        } catch (toolError: any) {
                            console.error(`[${agent.name}] Tool execution failed:`, toolError);
                            const errorMsg = toolError?.message || String(toolError);
                            response = await this.ai.generate(`Error executing tool '${toolCall.tool}': ${errorMsg}. Please try a different approach or fix the arguments.`, session);
                            currentTurn++;
                            continue;
                        }
                    } else {
                        console.warn(`[${agent.name}] Tool call detected but server not found or mapping missing.`);
                        response += "\nError: Tool execution failed (Tool source not found).";
                        break;
                    }
                }
            } catch (e) {
                console.error("Unexpected error in tool execution loop:", e);
            }

            // Fallback for conversational model that misses tool selection but user intent is clear
            if (agent.assignedTool && tools.length === 1 && mcpClients.has(agent.assignedTool.serverId)) {
                // Time
                if (this.shouldForceGetTime(agent.assignedTool.toolName, task)) {
                    try {
                        const client = mcpClients.get(agent.assignedTool.serverId)!;
                        const result = await client.callTool('get_time', {});
                        response = `Current time (from MCP tool): ${result?.now ?? JSON.stringify(result)}`;
                    } catch (e) {
                        response = `Error calling MCP tool get_time: ${String(e)}`;
                    }
                }
                // Echo
                else if (this.shouldForceEcho(agent.assignedTool.toolName)) {
                    try {
                        const client = mcpClients.get(agent.assignedTool.serverId)!;
                        const result = await client.callTool('echo', { text: task });
                        response = `Echo (from MCP tool): ${result?.echoed ?? JSON.stringify(result)}`;
                    } catch (e) {
                        response = `Error calling MCP tool echo: ${String(e)}`;
                    }
                }
                // Navigate
                else {
                    const navMatch = this.shouldForceNavigate(agent.assignedTool.toolName, task);
                    if (navMatch) {
                        try {
                            console.log(`[${agent.name}] Forcing navigate to:`, navMatch.url);
                            const client = mcpClients.get(agent.assignedTool.serverId)!;
                            const result = await client.callTool('navigate', navMatch);
                            response = `Navigating to ${navMatch.url}. Result: ${JSON.stringify(result)}`;
                        } catch (e) {
                            response = `Error forcing navigate: ${String(e)}`;
                        }
                    }
                }
            }
            break;
        }

        if (currentTurn >= maxTurns) {
            response += "\n\n(Agent reached maximum turn limit for tool calls)";
        }

        try {
            session.destroy();
        } catch (e) { /* ignore */ }

        console.log(`[${agent.name}] Completed. Response length: ${response.length} chars`);
        return response;
    }
}
