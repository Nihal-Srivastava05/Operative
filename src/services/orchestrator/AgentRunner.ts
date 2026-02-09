import { ChromeAIService } from '../ai/ChromeAIService';
import { Agent } from '../../store/db';
import { McpClient } from '../mcp/McpClient';
import { extractJson } from '../../utils/jsonUtils';

export class AgentRunner {
    private ai: ChromeAIService;

    constructor() {
        this.ai = ChromeAIService.getInstance();
    }

    private async constructSystemPrompt(agent: Agent, tools: any[]): Promise<string> {
        let prompt = agent.systemPrompt + "\n";

        if (tools.length > 0) {
            prompt += "\n=== AVAILABLE TOOLS ===\n";
            prompt += "You have access to the following tools via the Model Context Protocol:\n";
            prompt += JSON.stringify(tools, null, 2);
            prompt += "\n\n=== HOW TO USE TOOLS ===\n";
            prompt += "To use a tool, respond with ONLY a JSON object in this exact format:\n";
            prompt += `{"tool": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}\n`;
            prompt += "\nDo NOT include any markdown formatting or explanation.\n";
            prompt += "If a tool is relevant to the user request, you MUST call it rather than guessing.\n";
            prompt += "After using a tool, you'll receive the result and can then provide your final answer.\n";
        }

        return prompt;
    }

    private extractToolCall(response: string): { tool: string; args: any } | null {
        const potentialJson = extractJson(response);
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

    public async run(agent: Agent, task: string, mcpClients: Map<string, McpClient>): Promise<string> {
        // 1. Gather tools
        let tools: any[] = [];
        if (agent.assignedTool) {
            const client = mcpClients.get(agent.assignedTool.serverId);
            if (client) {
                // We might cache tools or fetch them. For now assume we fetch.
                // Ideally we should list tools once and store. 
                // For this MVP, let's assume we fetch or have them passed.
                // To keep it simple, we'll just skip listTools for now and assume the agent knows the tool if explicitly assigned,
                // OR we implement a tool discovery cache.
                try {
                    const serverTools = await client.listTools();
                    // Filter if specific tool assigned? The requirement says "option to configure tools", "For each agent only one tool can be connected".
                    // So we filter.
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
            language: 'en' // Specify output language to ensure optimal quality
        });

        console.log(`[${agent.name}] Starting execution with task: ${task.substring(0, 100)}...`);

        // 3. Prompt
        let response = await this.ai.generate(task, session);

        // 4. Check for Tool Call (Basic JSON detection)
        // Basic loop: 
        // Model -> JSON -> Execute -> Model -> Final Answer
        // Limit loop to avoid infinite.

        let maxTurns = 3;
        let currentTurn = 0;

        while (currentTurn < maxTurns) {
            try {
                const toolCall = this.extractToolCall(response);
                if (toolCall) {
                    console.log(`[${agent.name}] Calling tool:`, toolCall.tool);

                    // Execute
                    // Need the client again
                    if (agent.assignedTool && mcpClients.has(agent.assignedTool.serverId)) {
                        const client = mcpClients.get(agent.assignedTool.serverId)!;
                        const result = await client.callTool(toolCall.tool, toolCall.args);

                        // Feed back
                        const toolOutput = `Tool '${toolCall.tool}' output: ${JSON.stringify(result)}`;
                        response = await this.ai.generate(toolOutput, session);
                        currentTurn++;
                        continue;
                    } else {
                        response += "\nError: Tool execution failed (Client not found).";
                        break;
                    }
                }
            } catch (e) {
                // Not JSON or parse error, assume text response
            }

            // If we get here, it wasn't a tool call or we processed it. 
            // If it wasn't a tool call, we are done.
            // Small safety fallback for the common "what time is it" demo:
            // if the agent has exactly one tool `get_time` but the model didn't emit a tool call,
            // call it directly so the UX is reliable.
            if (
                agent.assignedTool &&
                tools.length === 1 &&
                this.shouldForceGetTime(agent.assignedTool.toolName, task) &&
                mcpClients.has(agent.assignedTool.serverId)
            ) {
                try {
                    const client = mcpClients.get(agent.assignedTool.serverId)!;
                    const result = await client.callTool('get_time', {});
                    response = `Current time (from MCP tool): ${result?.now ?? JSON.stringify(result)}`;
                } catch (e) {
                    response = `Error calling MCP tool get_time: ${String(e)}`;
                }
            }
            break;
        }

        session.destroy();
        console.log(`[${agent.name}] Completed. Response length: ${response.length} chars`);
        return response;
    }
}
