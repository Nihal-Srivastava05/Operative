import { ChromeAIService } from '../ai/ChromeAIService';
import { Agent } from '../../store/db';
import { McpClient } from '../mcp/McpClient';

export class AgentRunner {
    private ai: ChromeAIService;

    constructor() {
        this.ai = ChromeAIService.getInstance();
    }

    private constructSystemPrompt(agent: Agent, tools: any[]): string {
        let prompt = agent.systemPrompt + "\n";

        if (tools.length > 0) {
            prompt += "\nYou have access to the following tools via the Model Context Protocol:\n";
            prompt += JSON.stringify(tools, null, 2);
            prompt += "\n\nTo use a tool, you MUST reply with a JSON object in this format:\n";
            prompt += `{"tool": "tool_name", "arguments": { ... }}`;
            prompt += "\nIf you do not need to use a tool, just reply normally.";
        }

        return prompt;
    }

    public async run(agent: Agent, task: string, mcpClients: Map<string, McpClient>): Promise<string> {
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

        // 2. Build system prompt
        const systemPrompt = this.constructSystemPrompt(agent, tools);

        // 3. Generate response (works in both service worker and extension page contexts)
        let response = await this.ai.generateWithSystem(task, systemPrompt);

        // 4. Check for Tool Call (Basic JSON detection)
        let maxTurns = 3;
        let currentTurn = 0;

        while (currentTurn < maxTurns) {
            try {
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const potentialJson = JSON.parse(jsonMatch[0]);
                    if (potentialJson.tool && potentialJson.arguments) {
                        console.log(`[${agent.name}] Calling tool:`, potentialJson.tool);

                        if (agent.assignedTool && mcpClients.has(agent.assignedTool.serverId)) {
                            const client = mcpClients.get(agent.assignedTool.serverId)!;
                            const result = await client.callTool(potentialJson.tool, potentialJson.arguments);

                            const toolOutput = `Tool '${potentialJson.tool}' output: ${JSON.stringify(result)}`;
                            response = await this.ai.generateWithSystem(toolOutput, systemPrompt);
                            currentTurn++;
                            continue;
                        } else {
                            response += "\nError: Tool execution failed (Client not found).";
                            break;
                        }
                    }
                }
            } catch (e) {
                // Not JSON or parse error, assume text response
            }

            break;
        }

        return response;
    }
}
