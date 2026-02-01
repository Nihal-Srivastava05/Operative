import { db, Agent } from '../../store/db';
import { ChromeAIService } from '../ai/ChromeAIService';
import { AgentRunner } from './AgentRunner';
import { McpClient } from '../mcp/McpClient';
import { extractJson } from '../../utils/jsonUtils';

export class Orchestrator {
    private static instance: Orchestrator;
    private runner: AgentRunner;
    private ai: ChromeAIService;
    private mcpClients: Map<string, McpClient> = new Map();

    private constructor() {
        this.runner = new AgentRunner();
        this.ai = ChromeAIService.getInstance();
    }

    public static getInstance(): Orchestrator {
        if (!Orchestrator.instance) {
            Orchestrator.instance = new Orchestrator();
        }
        return Orchestrator.instance;
    }

    public async initialize() {
        const settings = await db.settings.get('mcp_servers');
        if (settings && Array.isArray(settings.value)) {
            for (const url of settings.value) {
                this.registerMcpServer(url, url).catch(e => console.warn("Init connection failed", e));
            }
        }
    }

    public async registerMcpServer(id: string, url: string) {
        if (this.mcpClients.has(id)) return;
        const client = new McpClient(url);
        try {
            await client.connect();
            this.mcpClients.set(id, client);
            console.log(`Connected to MCP Server ${id}`);
        } catch (e) {
            console.error(`Failed to connect to MCP Server ${id}`, e);
            throw e;
        }
    }

    public async handleUserMessage(message: string): Promise<{ response: string; agentName: string }> {
        const agents = await db.agents.toArray();
        const subAgents = agents.filter(a => a.enabled && a.type === 'worker');

        // If no agents, check if orchestrator itself is enabled, otherwise fail
        if (subAgents.length === 0) {
            return { response: "No active agents found. Please create and enable an agent.", agentName: "System" };
        }

        // 1. Routing
        // Construct routing prompt
        const agentList = subAgents.map(a => `- ${a.name}: ${a.systemPrompt.substring(0, 100)}...`).join('\n');

        let targetAgentName = "None";
        let task = message;
        let attempt = 0;
        let lastError = "";

        // If only one agent, route directly to it
        if (subAgents.length === 1) {
            console.log("Only one agent available, routing directly");
            const response = await this.runner.run(subAgents[0], message, this.mcpClients);
            return { response, agentName: subAgents[0].name };
        }

        while (attempt < 2) {
            const routerPrompt = `
You are the Orchestrator. Your job is to route the user's request to the most appropriate agent.

Available Agents:
${agentList}

User Request: "${message}"

CRITICAL INSTRUCTIONS:
1. Read the user's request carefully
2. Look at each agent's name and description
3. Match keywords in the request to agent names/descriptions
4. ALWAYS pick an agent if there's even a slight match
5. Only use "None" if the request is completely unrelated to all agents
6. Return ONLY valid JSON, no markdown, no extra text

JSON FORMAT (copy this exactly):
{"agentName": "exact name from list", "task": "user request"}

EXAMPLES:
Request: "Summarize this text: hello world"
Agents: ["Summarize Agent", "Code Helper"]
Response: {"agentName": "Summarize Agent", "task": "Summarize this text: hello world"}

Request: "Generate a name for my project"
Agents: ["Name Generator Agent", "Summarize Agent"]
Response: {"agentName": "Name Generator Agent", "task": "Generate a name for my project"}

Request: "Help me code"
Agents: ["Code Helper", "Math Solver"]
Response: {"agentName": "Code Helper", "task": "Help me code"}
${lastError ? `\n\n⚠️ ERROR: ${lastError}\nFIX IT NOW. Return valid JSON only.` : ""}
`;

            const routerSession = await this.ai.createSession({ systemPrompt: routerPrompt });
            const routerResponseRaw = await this.ai.generate("Return the JSON routing decision now:", routerSession);
            routerSession.destroy();

            console.log("Router Response:", routerResponseRaw);

            const json = extractJson(routerResponseRaw);
            if (json && json.agentName) {
                targetAgentName = json.agentName;
                task = json.task || message;
                console.log(`Routing to agent: ${targetAgentName}`);
                break;
            } else {
                console.warn("Router returned invalid JSON", routerResponseRaw);
                lastError = "Invalid JSON format. Response was: " + routerResponseRaw.substring(0, 100);
                attempt++;
            }
        }

        // If routing failed or returned "None", try keyword-based fallback
        if (targetAgentName === "None" || !targetAgentName) {
            console.log("Attempting keyword-based fallback routing");
            const lowerMessage = message.toLowerCase();

            // Try to match keywords in message to agent names/prompts
            for (const agent of subAgents) {
                const lowerName = agent.name.toLowerCase();
                const lowerPrompt = agent.systemPrompt.toLowerCase();

                // Extract key words from agent name
                const nameWords = lowerName.split(/\s+/);

                // Check if any significant word from agent name appears in message
                for (const word of nameWords) {
                    if (word.length > 3 && lowerMessage.includes(word)) {
                        console.log(`Keyword match: "${word}" in message matched agent "${agent.name}"`);
                        const response = await this.runner.run(agent, message, this.mcpClients);
                        return { response, agentName: agent.name };
                    }
                }

                // Check for common action words
                if (lowerMessage.includes('summarize') || lowerMessage.includes('summary')) {
                    if (lowerName.includes('summar') || lowerPrompt.includes('summar')) {
                        console.log(`Action word match: "summarize" matched agent "${agent.name}"`);
                        const response = await this.runner.run(agent, message, this.mcpClients);
                        return { response, agentName: agent.name };
                    }
                }

                if (lowerMessage.includes('generate') || lowerMessage.includes('create') || lowerMessage.includes('make')) {
                    if (lowerName.includes('generat') || lowerName.includes('creat') || lowerPrompt.includes('generat')) {
                        console.log(`Action word match: found generation-related agent "${agent.name}"`);
                        const response = await this.runner.run(agent, message, this.mcpClients);
                        return { response, agentName: agent.name };
                    }
                }
            }

            return {
                response: "I'm not sure which agent to use for that request. Available agents: " + subAgents.map(a => a.name).join(", "),
                agentName: "Orchestrator"
            };
        }

        const targetAgent = subAgents.find(a => a.name === targetAgentName);
        if (!targetAgent) {
            // AI hallucination - try fuzzy matching
            const lowerTargetName = targetAgentName.toLowerCase();
            const fuzzyMatch = subAgents.find(a =>
                a.name.toLowerCase().includes(lowerTargetName) ||
                lowerTargetName.includes(a.name.toLowerCase())
            );

            if (fuzzyMatch) {
                console.log(`Fuzzy matched '${targetAgentName}' to '${fuzzyMatch.name}'`);
                const response = await this.runner.run(fuzzyMatch, task, this.mcpClients);
                return { response, agentName: fuzzyMatch.name };
            }

            return {
                response: `Orchestrator tried to route to '${targetAgentName}' but it doesn't exist. Available agents: ${subAgents.map(a => a.name).join(", ")}`,
                agentName: "Orchestrator"
            };
        }

        // 2. Execution
        const response = await this.runner.run(targetAgent, task, this.mcpClients);
        return { response, agentName: targetAgent.name };
    }

    public async getConnectedTools(): Promise<{ serverId: string, toolName: string }[]> {
        const tools: { serverId: string, toolName: string }[] = [];
        for (const [serverId, client] of this.mcpClients.entries()) {
            try {
                const list = await client.listTools();
                list.forEach(t => tools.push({ serverId, toolName: t.name }));
            } catch (e) {
                console.warn(`Failed to list tools for ${serverId}`, e);
            }
        }
        return tools;
    }
}
