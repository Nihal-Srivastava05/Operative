import { db, Agent } from '../../store/db';
import { ChromeAIService } from '../ai/ChromeAIService';
import { AgentRunner } from './AgentRunner';
import { InternalMcpClient } from '../mcp/InternalMcpClient';
import { IMcpClient } from '../mcp/interfaces';
import { McpClient } from '../mcp/McpClient';
import { BrowserMcpServer } from '../mcp/servers/BrowserMcpServer';
import { KnowledgeMcpServer } from '../mcp/servers/KnowledgeMcpServer';
import { WatchLaterMcpServer } from '../mcp/servers/WatchLaterMcpServer';
import { extractJson } from '../../utils/jsonUtils';
import { TaskDecomposer } from './TaskDecomposer';
import { TaskQueue } from './TaskQueue';

export class Orchestrator {
    private static instance: Orchestrator;
    private runner: AgentRunner;
    private ai: ChromeAIService;
    private mcpClients: Map<string, IMcpClient> = new Map();
    private taskDecomposer: TaskDecomposer;
    private taskQueue: TaskQueue;

    private constructor() {
        this.runner = new AgentRunner();
        this.ai = ChromeAIService.getInstance();
        this.taskDecomposer = TaskDecomposer.getInstance();
        this.taskQueue = TaskQueue.getInstance();
    }

    public static getInstance(): Orchestrator {
        if (!Orchestrator.instance) {
            Orchestrator.instance = new Orchestrator();
        }
        return Orchestrator.instance;
    }

    public async initialize() {
        // Register Internal Browser MCP
        this.mcpClients.set("internal-browser", new InternalMcpClient(new BrowserMcpServer()));

        // Register Internal Knowledge MCP
        this.mcpClients.set("internal-knowledge", new InternalMcpClient(new KnowledgeMcpServer()));

        // Register Internal Watch Later MCP
        this.mcpClients.set("internal-watchlater", new InternalMcpClient(new WatchLaterMcpServer()));

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

    /** All enabled workers (for task decomposition agent assignment). */
    private async getEnabledWorkers(): Promise<Agent[]> {
        const agents = await db.agents.toArray();
        return agents.filter(a => a.enabled && a.type === 'worker');
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

        // 1. Resume active task plan if one is executing
        const activePlan = await this.taskQueue.getCurrentPlan();
        if (activePlan && activePlan.status === 'executing') {
            return this.executePlan();
        }

        // 2. Check if task decomposition is enabled and try decomposition for complex tasks
        const decompositionSetting = await db.settings.get('task_decomposition_enabled');
        const decompositionEnabled = decompositionSetting?.value !== false;
        if (decompositionEnabled && rootCandidates.length > 0) {
            const decomposition = await this.taskDecomposer.analyzeComplexity(message);
            if (decomposition.needsDecomposition) {
                const workers = await this.getEnabledWorkers();
                if (workers.length > 0) {
                    const maxSubtasksSetting = await db.settings.get('task_decomposition_max_subtasks');
                    const maxSubtasks = typeof maxSubtasksSetting?.value === 'number' ? maxSubtasksSetting.value : 10;
                    const tasks = await this.taskDecomposer.decomposeTask(message, await db.agents.toArray(), maxSubtasks);
                    if (tasks.length > 1) {
                        await this.taskQueue.createPlan(tasks, message);
                        return this.executePlan();
                    }
                }
            }
        }

        // 3. Standard routing flow
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

    /** Executes the current task plan sequentially until complete, then aggregates results. */
    private async executePlan(): Promise<{ response: string; agentName: string }> {
        // Capture plan ID now — getCurrentPlan() nullifies activePlanId once the plan
        // transitions to 'completed', so aggregateResults() would lose track of it.
        const initialPlan = await this.taskQueue.getCurrentPlan();
        const planId = initialPlan?.id;

        while (!(await this.taskQueue.isPlanComplete())) {
            const task = await this.taskQueue.getNextTask();
            if (!task) break;

            try {
                const agentId = task.targetAgentId;
                if (!agentId) {
                    await this.taskQueue.markTaskFailed(task.id, 'No agent assigned');
                    continue;
                }
                const agent = await db.agents.get(agentId);
                if (!agent) {
                    await this.taskQueue.markTaskFailed(task.id, 'Agent not found');
                    continue;
                }

                // Inject outputs from already-completed tasks so later agents (e.g. Browser Agent)
                // receive real data (URLs, recommendations) instead of generic descriptions.
                const currentPlan = await this.taskQueue.getCurrentPlan();
                const priorOutputs = currentPlan
                    ? Object.values(currentPlan.results).filter(Boolean)
                    : [];
                const taskDescription = priorOutputs.length > 0
                    ? `${task.description}\n\nContext from previous steps:\n${priorOutputs.join('\n\n')}`
                    : task.description;

                const result = await this.runner.run(agent, taskDescription, this.mcpClients);
                await this.taskQueue.markTaskComplete(task.id, result);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                await this.taskQueue.markTaskFailed(task.id, errorMessage);
                // Continue with remaining tasks
            }
        }

        return this.taskQueue.aggregateResults(planId);
    }

    /** Expose current task plan for UI (e.g. progress indicator). */
    public async getCurrentTaskPlan() {
        return this.taskQueue.getCurrentPlan();
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
