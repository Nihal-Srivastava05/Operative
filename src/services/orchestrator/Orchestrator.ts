import { db, Agent } from '../../store/db';
import { ChromeAIService } from '../ai/ChromeAIService';
import { AgentRunner } from './AgentRunner';
import { InternalMcpClient } from '../mcp/InternalMcpClient';
import { IMcpClient } from '../mcp/interfaces';
import { McpClient } from '../mcp/McpClient';
import { extractJson } from '../../utils/jsonUtils';

export class Orchestrator {
    private static instance: Orchestrator;
    private runner: AgentRunner;
    private ai: ChromeAIService;
    private mcpClients: Map<string, IMcpClient> = new Map();

    private constructor() {
        this.runner = new AgentRunner();
        this.ai = ChromeAIService.getInstance();
        // Ensure the internal browser MCP is always present (avoids races with initialize()).
        this.mcpClients.set("internal-browser", new InternalMcpClient());
    }

    public static getInstance(): Orchestrator {
        if (!Orchestrator.instance) {
            Orchestrator.instance = new Orchestrator();
        }
        return Orchestrator.instance;
    }

    public async initialize() {
        // Register Internal Browser MCP (idempotent)
        if (!this.mcpClients.has("internal-browser")) {
            this.mcpClients.set("internal-browser", new InternalMcpClient());
        }

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

    /** Root candidates: enabled orchestrators + enabled workers with no parent (top-level). */
    private async getRootCandidates(): Promise<Agent[]> {
        const agents = await db.agents.toArray();
        const orchestrators = agents.filter(a => a.enabled && a.type === 'orchestrator');
        const topLevelWorkers = agents.filter(a => a.enabled && a.type === 'worker' && !a.parentId);
        return [...orchestrators, ...topLevelWorkers];
    }

    /** Enabled worker children of a given orchestrator. */
    private async getChildren(parentId: string): Promise<Agent[]> {
        const agents = await db.agents.toArray();
        return agents.filter(a => a.enabled && a.type === 'worker' && a.parentId === parentId);
    }

    /** Reusable router: pick one candidate from the list (LLM + validation). Returns agent + refined task or null. */
    private async routeRequest(message: string, candidates: Agent[]): Promise<{ agent: Agent; task: string } | null> {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return { agent: candidates[0], task: message };

        const agentList = candidates.map(a => {
            const kind = a.type === 'orchestrator' ? 'orchestrator' : 'worker';
            const toolInfo = a.assignedTool ? ` (tool: ${a.assignedTool.toolName})` : '';
            return `- ${a.name} [${kind}]${toolInfo}: ${a.systemPrompt.substring(0, 100)}...`;
        }).join('\n');

        let attempt = 0;
        let lastError = '';

        while (attempt < 2) {
            const routerPrompt = `Task: Route the user request to the correct option.
Response format: Valid JSON only.

Available options:
${agentList}

User Request: "${message}"

Respond with a single JSON object: {"agentName":"<name from list OR None>","task":"<rewritten task or user request>"}
- Choose from the list only. If none fit, use "None".
- "task" must be actionable; if unsure, repeat the user request.
- Output ONLY the JSON.
${lastError ? `\nPrevious error: ${lastError}` : ''}

JSON:`;

            const routerSession = await this.ai.createSession({ language: 'en', temperature: 0.1 });
            const routerResponseRaw = await this.ai.generate(routerPrompt, routerSession);
            routerSession.destroy();

            const json = extractJson(routerResponseRaw, { logFailure: true });
            if (json && typeof json.agentName === 'string') {
                const targetName = json.agentName.trim();
                if (targetName === 'None' || !targetName) return null;

                let proposedTask = typeof json.task === 'string' ? json.task.trim() : '';
                const placeholder = proposedTask.toLowerCase();
                if (!proposedTask || placeholder === 'request for agent' || placeholder === 'request for agent:' || placeholder === 'request for the agent' || placeholder === 'request for the agent:') {
                    proposedTask = message;
                }

                const agent = candidates.find(a => a.name === targetName);
                if (agent) return { agent, task: proposedTask };

                const lowerTarget = targetName.toLowerCase();
                const fuzzy = candidates.find(a =>
                    a.name.toLowerCase().includes(lowerTarget) || lowerTarget.includes(a.name.toLowerCase())
                );
                if (fuzzy) {
                    console.log(`Fuzzy matched '${targetName}' to '${fuzzy.name}'`);
                    return { agent: fuzzy, task: proposedTask };
                }
                lastError = `"${targetName}" is not in the list. Use exact names from the list or "None".`;
            } else {
                lastError = 'Invalid JSON. Return only the JSON object.';
            }
            attempt++;
        }
        return null;
    }

    /** Keyword-based fallback within a candidate set (workers only for tool/action hints). */
    private async keywordFallback(message: string, candidates: Agent[]): Promise<Agent | null> {
        const lowerMessage = message.toLowerCase();
        for (const agent of candidates) {
            const lowerName = agent.name.toLowerCase();
            const lowerPrompt = agent.systemPrompt.toLowerCase();
            const lowerTool = agent.assignedTool?.toolName?.toLowerCase() || '';

            const nameWords = lowerName.split(/\s+/);
            for (const word of nameWords) {
                if (word.length > 3 && lowerMessage.includes(word)) {
                    console.log(`Keyword match: "${word}" -> "${agent.name}"`);
                    return agent;
                }
            }
            if (lowerTool && lowerMessage.includes(lowerTool)) {
                console.log(`Tool name match: "${lowerTool}" -> "${agent.name}"`);
                return agent;
            }
            if ((lowerMessage.includes('summarize') || lowerMessage.includes('summary')) && (lowerName.includes('summar') || lowerPrompt.includes('summar'))) {
                console.log(`Action match: summarize -> "${agent.name}"`);
                return agent;
            }
            if ((lowerMessage.includes('generate') || lowerMessage.includes('create') || lowerMessage.includes('make')) && (lowerName.includes('generat') || lowerName.includes('creat') || lowerPrompt.includes('generat'))) {
                console.log(`Action match: generate -> "${agent.name}"`);
                return agent;
            }
            if ((lowerMessage.includes('time') || lowerMessage.includes('date')) && lowerTool.includes('time')) {
                console.log(`Intent match: time/date -> "${agent.name}"`);
                return agent;
            }
        }
        return null;
    }

    public async handleUserMessage(message: string): Promise<{ response: string; agentName: string }> {
        const rootCandidates = await this.getRootCandidates();

        if (rootCandidates.length === 0) {
            return { response: "No active agents found. Please create and enable an agent.", agentName: "System" };
        }

        // Single root candidate: if worker, run; if orchestrator, route among its children
        if (rootCandidates.length === 1) {
            const only = rootCandidates[0];
            if (only.type === 'worker') {
                const response = await this.runner.run(only, message, this.mcpClients);
                return { response, agentName: only.name };
            }
            const children = await this.getChildren(only.id);
            if (children.length === 0) {
                return { response: `Orchestrator "${only.name}" has no active child agents.`, agentName: only.name };
            }
            if (children.length === 1) {
                const response = await this.runner.run(children[0], message, this.mcpClients);
                return { response, agentName: children[0].name };
            }
            const routed = await this.routeRequest(message, children);
            if (routed) {
                const response = await this.runner.run(routed.agent, routed.task, this.mcpClients);
                return { response, agentName: routed.agent.name };
            }
            const fallback = await this.keywordFallback(message, children);
            if (fallback) {
                const response = await this.runner.run(fallback, message, this.mcpClients);
                return { response, agentName: fallback.name };
            }
            return {
                response: "Could not route to a child agent. Available: " + children.map(a => a.name).join(", "),
                agentName: only.name
            };
        }

        // Meta-level routing among root candidates (orchestrators + top-level workers)
        let routed = await this.routeRequest(message, rootCandidates);
        if (!routed) {
            const fallback = await this.keywordFallback(message, rootCandidates);
            if (fallback) {
                const response = await this.runner.run(fallback, message, this.mcpClients);
                return { response, agentName: fallback.name };
            }
            return {
                response: "I'm not sure which agent to use. Available: " + rootCandidates.map(a => a.name).join(", "),
                agentName: "Orchestrator"
            };
        }

        const { agent: selected, task } = routed;

        if (selected.type === 'worker') {
            const response = await this.runner.run(selected, task, this.mcpClients);
            return { response, agentName: selected.name };
        }

        // Selected is a mini-orchestrator: route among its children
        const children = await this.getChildren(selected.id);
        if (children.length === 0) {
            return { response: `Orchestrator "${selected.name}" has no active child agents.`, agentName: selected.name };
        }
        if (children.length === 1) {
            const response = await this.runner.run(children[0], task, this.mcpClients);
            return { response, agentName: children[0].name };
        }
        const childRouted = await this.routeRequest(task, children);
        if (childRouted) {
            const response = await this.runner.run(childRouted.agent, childRouted.task, this.mcpClients);
            return { response, agentName: childRouted.agent.name };
        }
        const childFallback = await this.keywordFallback(task, children);
        if (childFallback) {
            const response = await this.runner.run(childFallback, task, this.mcpClients);
            return { response, agentName: childFallback.name };
        }
        return {
            response: `Could not route within "${selected.name}". Available: ` + children.map(a => a.name).join(", "),
            agentName: selected.name
        };
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
