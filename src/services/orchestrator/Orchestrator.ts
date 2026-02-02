import { db, Agent } from '../../store/db';
import { ChromeAIService } from '../ai/ChromeAIService';
import { AgentRunner } from './AgentRunner';
import { McpClient } from '../mcp/McpClient';
import {
  AgentIdentity,
  generateAgentId,
  CHANNELS,
} from '../../runtime/protocol/types';
import { getBroadcastManager } from '../../runtime/channels/BroadcastManager';
import { getTaskQueue, TaskQueue, CreateTaskOptions } from '../../runtime/orchestration/TaskQueue';
import { getWorkflowEngine, WorkflowEngine, WorkflowDefinition } from '../../runtime/orchestration/WorkflowEngine';
import { GlobalMemory } from '../../runtime/memory/GlobalMemory';

export interface OrchestratorConfig {
  /** Use new multi-agent runtime (default: false for backwards compatibility) */
  useMultiAgentRuntime?: boolean;
  /** Enable task queue polling (default: true when using multi-agent runtime) */
  enableTaskQueue?: boolean;
}

export class Orchestrator {
    private static instance: Orchestrator;
    private runner: AgentRunner;
    private ai: ChromeAIService;
    private mcpClients: Map<string, McpClient> = new Map();

    // Multi-agent runtime components
    private identity: AgentIdentity;
    private taskQueue: TaskQueue | null = null;
    private workflowEngine: WorkflowEngine | null = null;
    private globalMemory: GlobalMemory | null = null;
    private config: OrchestratorConfig;

    private constructor(config?: OrchestratorConfig) {
        this.config = config ?? {};
        this.runner = new AgentRunner();
        this.ai = ChromeAIService.getInstance();

        // Create orchestrator identity
        this.identity = {
            id: `orchestrator_${generateAgentId()}`,
            definitionId: 'system:orchestrator',
            contextType: 'side-panel',
        };

        // Initialize multi-agent runtime if enabled
        if (this.config.useMultiAgentRuntime) {
            this.initializeRuntime();
        }
    }

    /**
     * Initialize multi-agent runtime components
     */
    private initializeRuntime(): void {
        // Setup broadcast manager
        const broadcast = getBroadcastManager();
        broadcast.setIdentity(this.identity);

        // Initialize global memory
        this.globalMemory = new GlobalMemory(this.identity);

        // Initialize task queue
        this.taskQueue = getTaskQueue(this.identity);
        if (this.config.enableTaskQueue !== false) {
            this.taskQueue.startPolling();
        }

        // Initialize workflow engine
        this.workflowEngine = getWorkflowEngine(this.identity);

        // Subscribe to task results for async handling
        this.setupTaskResultListener();

        console.log('[Orchestrator] Multi-agent runtime initialized');
    }

    /**
     * Setup listener for task results
     */
    private setupTaskResultListener(): void {
        const broadcast = getBroadcastManager();

        broadcast.subscribeTasks(
            (message) => {
                if (message.type === 'task:result') {
                    const payload = message.payload as { taskId: string; result: unknown };
                    console.log(`[Orchestrator] Task ${payload.taskId} completed:`, payload.result);
                    // Results are handled by TaskQueue, this is for additional processing if needed
                }
            },
            { type: 'task:result' }
        );
    }

    public static getInstance(config?: OrchestratorConfig): Orchestrator {
        if (!Orchestrator.instance) {
            Orchestrator.instance = new Orchestrator(config);
        }
        return Orchestrator.instance;
    }

    /**
     * Reconfigure the orchestrator (e.g., enable multi-agent runtime)
     */
    public configure(config: OrchestratorConfig): void {
        const wasUsingRuntime = this.config.useMultiAgentRuntime;
        this.config = { ...this.config, ...config };

        if (!wasUsingRuntime && config.useMultiAgentRuntime) {
            this.initializeRuntime();
        }
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
        // Use multi-agent runtime if enabled
        if (this.config.useMultiAgentRuntime && this.taskQueue) {
            return this.handleUserMessageWithRuntime(message);
        }

        // Original implementation for backwards compatibility
        return this.handleUserMessageLegacy(message);
    }

    /**
     * Handle user message using multi-agent runtime
     */
    private async handleUserMessageWithRuntime(message: string): Promise<string> {
        const agents = await db.agents.toArray();
        const subAgents = agents.filter(a => a.enabled && a.type === 'worker');

        if (subAgents.length === 0) {
            return "No active agents found. Please create and enable an agent.";
        }

        // Route the message
        const routing = await this.routeMessage(message, subAgents);

        if (!routing.targetAgent) {
            return routing.reason || "I'm not sure which agent to use for that request.";
        }

        // Create task in queue
        const task = await this.taskQueue!.createTask({
            task: routing.task,
            targetDefinitionId: routing.targetAgent.id,
            context: {
                originalMessage: message,
                routing: routing.reasoning,
            },
        });

        // For synchronous response, wait for task completion
        return this.waitForTaskResult(task.id);
    }

    /**
     * Wait for a task to complete and return result
     */
    private async waitForTaskResult(taskId: string, timeoutMs: number = 60000): Promise<string> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const task = await this.taskQueue!.getTask(taskId);

            if (!task) {
                return `Task ${taskId} not found.`;
            }

            if (task.status === 'completed') {
                return typeof task.result === 'string'
                    ? task.result
                    : JSON.stringify(task.result);
            }

            if (task.status === 'failed') {
                return `Task failed: ${task.error}`;
            }

            if (task.status === 'cancelled') {
                return 'Task was cancelled.';
            }

            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        return 'Task timed out waiting for agent response.';
    }

    /**
     * Route a message to the appropriate agent
     */
    private async routeMessage(message: string, agents: Agent[]): Promise<{
        targetAgent: Agent | null;
        task: string;
        reasoning?: string;
        reason?: string;
    }> {
        // If only one agent, use it directly
        if (agents.length === 1) {
            return { targetAgent: agents[0], task: message, reasoning: 'Single agent available' };
        }

        const agentList = agents.map(a => `- ${a.name}: ${a.systemPrompt.substring(0, 100)}...`).join('\n');
        const routerPrompt = `
You are the Orchestrator. Your goal is to route the user's request to the most appropriate agent.
Available Agents:
${agentList}

User Request: "${message}"

Analyze the request. Return a JSON object with:
- "agentName": The exact name of the selected agent.
- "task": The specific instruction to give to that agent.
- "reasoning": Brief explanation of why this agent was selected.

IMPORTANT: You MUST select an agent. If the request is a greeting or general conversation, pick the most general-purpose agent. Never return "None".
`;

        const routerResponseRaw = await this.ai.generateWithSystem("Route this request.", routerPrompt);

        let targetAgentName = "";
        let task = message;
        let reasoning: string | undefined;

        try {
            const match = routerResponseRaw.match(/\{[\s\S]*\}/);
            if (match) {
                const json = JSON.parse(match[0]);
                targetAgentName = json.agentName;
                task = json.task || message;
                reasoning = json.reasoning;
            }
        } catch (e) {
            console.warn("Router returned non-JSON", routerResponseRaw);
        }

        // Find target agent, fall back to first agent if not found
        let targetAgent = agents.find(a => a.name === targetAgentName);

        if (!targetAgent) {
            console.log(`[Orchestrator] No match for '${targetAgentName}', falling back to first agent`);
            targetAgent = agents[0];
            task = message;
            reasoning = 'Fallback to default agent';
        }

        return { targetAgent, task, reasoning };
    }

    /**
     * Legacy message handling (original implementation)
     */
    private async handleUserMessageLegacy(message: string): Promise<string> {
        const agents = await db.agents.toArray();
        const subAgents = agents.filter(a => a.enabled && a.type === 'worker');

        if (subAgents.length === 0) {
            return "No active agents found. Please create and enable an agent.";
        }

        // If only one agent, use it directly without routing
        if (subAgents.length === 1) {
            console.log(`[Orchestrator] Single agent mode - using ${subAgents[0].name}`);
            return await this.runner.run(subAgents[0], message, this.mcpClients);
        }

        const agentList = subAgents.map(a => `- ${a.name}: ${a.systemPrompt.substring(0, 100)}...`).join('\n');
        const routerPrompt = `
You are the Orchestrator. Your goal is to route the user's request to the most appropriate agent.
Available Agents:
${agentList}

User Request: "${message}"

Analyze the request. Return a JSON object with:
- "agentName": The exact name of the selected agent.
- "task": The specific instruction to give to that agent.

IMPORTANT: You MUST select an agent. If the request is a greeting or general conversation, pick the most general-purpose agent. Never return "None".
`;

        const routerResponseRaw = await this.ai.generateWithSystem("Route this request.", routerPrompt);

        let targetAgentName = "";
        let task = message;

        try {
            const match = routerResponseRaw.match(/\{[\s\S]*\}/);
            if (match) {
                const json = JSON.parse(match[0]);
                targetAgentName = json.agentName;
                task = json.task || message;
            }
        } catch (e) {
            console.warn("Router returned non-JSON", routerResponseRaw);
        }

        // Find the target agent, or fall back to first agent
        let targetAgent = subAgents.find(a => a.name === targetAgentName);

        if (!targetAgent) {
            console.log(`[Orchestrator] No match for '${targetAgentName}', falling back to first agent`);
            targetAgent = subAgents[0];
            task = message;
        }

        console.log(`[Orchestrator] Routing to: ${targetAgent.name}`);
        return await this.runner.run(targetAgent, task, this.mcpClients);
    }

    /**
     * Submit a task directly to the task queue (async)
     */
    public async submitTask(options: CreateTaskOptions): Promise<string> {
        if (!this.taskQueue) {
            throw new Error('Multi-agent runtime not enabled. Call configure({ useMultiAgentRuntime: true })');
        }

        const task = await this.taskQueue.createTask(options);
        return task.id;
    }

    /**
     * Execute a workflow
     */
    public async executeWorkflow(definition: WorkflowDefinition, input?: unknown) {
        if (!this.workflowEngine) {
            throw new Error('Multi-agent runtime not enabled. Call configure({ useMultiAgentRuntime: true })');
        }

        return this.workflowEngine.execute(definition, input);
    }

    /**
     * Get task by ID
     */
    public async getTask(taskId: string) {
        return this.taskQueue?.getTask(taskId);
    }

    /**
     * Cancel a task
     */
    public async cancelTask(taskId: string): Promise<boolean> {
        return this.taskQueue?.cancelTask(taskId) ?? false;
    }

    /**
     * Get task queue statistics
     */
    public async getTaskQueueStats() {
        return this.taskQueue?.getStats();
    }

    /**
     * Read from global memory
     */
    public async readMemory<T = unknown>(namespace: string, key: string): Promise<T | undefined> {
        return this.globalMemory?.read<T>(namespace, key);
    }

    /**
     * Write to global memory
     */
    public async writeMemory<T = unknown>(
        namespace: string,
        key: string,
        value: T,
        ttl?: number
    ): Promise<boolean> {
        if (!this.globalMemory) return false;
        const result = await this.globalMemory.write(namespace, key, value, { ttl });
        return result.success;
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

    /**
     * Get orchestrator identity
     */
    public getIdentity(): AgentIdentity {
        return this.identity;
    }

    /**
     * Check if multi-agent runtime is enabled
     */
    public isRuntimeEnabled(): boolean {
        return this.config.useMultiAgentRuntime ?? false;
    }

    /**
     * Cleanup and destroy the orchestrator
     */
    public destroy(): void {
        if (this.taskQueue) {
            this.taskQueue.destroy();
            this.taskQueue = null;
        }
        if (this.workflowEngine) {
            this.workflowEngine.destroy();
            this.workflowEngine = null;
        }
        if (this.globalMemory) {
            this.globalMemory.destroy();
            this.globalMemory = null;
        }

        // Disconnect MCP clients
        for (const client of this.mcpClients.values()) {
            client.disconnect();
        }
        this.mcpClients.clear();
    }
}
