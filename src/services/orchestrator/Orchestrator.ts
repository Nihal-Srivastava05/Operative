import { db, Agent } from '../../store/db';
import { ChromeAIService } from '../ai/ChromeAIService';
import { AgentRunner } from './AgentRunner';
import { McpClient } from '../mcp/McpClient';

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

    public async handleUserMessage(message: string): Promise<string> {
        const agents = await db.agents.toArray();
        const subAgents = agents.filter(a => a.enabled && a.type === 'worker');

        // If no agents, check if orchestrator itself is enabled, otherwise fail
        if (subAgents.length === 0) {
            return "No active agents found. Please create and enable an agent.";
        }

        // 1. Routing
        // Construct routing prompt
        const agentList = subAgents.map(a => `- ${a.name}: ${a.systemPrompt.substring(0, 100)}...`).join('\n');
        const routerPrompt = `
You are the Orchestrator. Your goal is to route the user's request to the most appropriate agent.
Available Agents:
${agentList}

User Request: "${message}"

Analyze the request. Return a JSON object with:
- "agentName": The exact name of the selected agent.
- "task": The specific instruction to give to that agent.
If no agent is suitable, return "agentName": "None".
`;

        const routerSession = await this.ai.createSession({ systemPrompt: routerPrompt }); // Routing is a one-shot task usually
        const routerResponseRaw = await this.ai.generate("Route this request.", routerSession);
        routerSession.destroy();

        let targetAgentName = "None";
        let task = message;

        try {
            // Attempt to parse JSON
            const match = routerResponseRaw.match(/\{[\s\S]*\}/);
            if (match) {
                const json = JSON.parse(match[0]);
                targetAgentName = json.agentName;
                task = json.task || message;
            }
        } catch (e) {
            console.warn("Router returned non-JSON", routerResponseRaw);
            // Fallback: if we only have one agent, maybe default to it? 
            // Or just ask user to clarify.
        }

        if (targetAgentName === "None") {
            return "I'm not sure which agent to use for that request.";
        }

        const targetAgent = subAgents.find(a => a.name === targetAgentName);
        if (!targetAgent) {
            // AI hallucinations dealing
            return `Orchestrator tried to route to '${targetAgentName}' but it doesn't exist.`;
        }

        // 2. Execution
        return await this.runner.run(targetAgent, task, this.mcpClients);
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
