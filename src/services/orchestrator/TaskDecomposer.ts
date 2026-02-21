import { v4 as uuidv4 } from 'uuid';
import { ChromeAIService } from '../ai/ChromeAIService';
import { extractJson } from '../../utils/jsonUtils';
import type { Agent } from '../../store/db';
import type { DecompositionResult, Task } from './types';

const MAX_SUBTASKS_DEFAULT = 10;

export class TaskDecomposer {
    private static instance: TaskDecomposer;
    private ai: ChromeAIService;

    private constructor() {
        this.ai = ChromeAIService.getInstance();
    }

    public static getInstance(): TaskDecomposer {
        if (!TaskDecomposer.instance) {
            TaskDecomposer.instance = new TaskDecomposer();
        }
        return TaskDecomposer.instance;
    }

    /**
     * Determines whether the user message represents a complex task that should be
     * decomposed into subtasks. Uses the AI to analyze the request.
     */
    public async analyzeComplexity(message: string): Promise<DecompositionResult> {
        const prompt = `You are a task analyst. Decide if the following user request requires multiple distinct steps that should be handled by different specialized agents in sequence.

User request: "${message}"

Consider decomposition when:
- The request explicitly asks for multiple things (e.g. "fetch X, then analyze Y, and summarize")
- The request implies a pipeline (e.g. "research, compare, and report")
- Different steps need different skills or tools (e.g. get data → analyze → format report)

Do NOT decompose when:
- The request is a single question or action
- One agent can reasonably handle the whole request
- The request is vague or very short

Respond with valid JSON only, no other text:
{"needsDecomposition": true or false, "reasoning": "brief explanation"}

JSON:`;

        try {
            const session = await this.ai.createSession({ language: 'en', temperature: 0.2 });
            const raw = await this.ai.generate(prompt, session);
            session.destroy();

            const json = extractJson(raw, { logFailure: true });
            if (json && typeof json.needsDecomposition === 'boolean') {
                return {
                    needsDecomposition: json.needsDecomposition,
                    reasoning: typeof json.reasoning === 'string' ? json.reasoning : ''
                };
            }
        } catch (e) {
            console.error('TaskDecomposer.analyzeComplexity failed', e);
        }

        return { needsDecomposition: false, reasoning: 'Analysis failed; treating as single task.' };
    }

    /**
     * Breaks down a complex task into ordered subtasks and assigns each to an agent.
     * Returns an array of Task objects with dependencies and agent assignments.
     */
    public async decomposeTask(
        message: string,
        agents: Agent[],
        maxSubtasks: number = MAX_SUBTASKS_DEFAULT
    ): Promise<Task[]> {
        const workers = agents.filter(a => a.enabled && a.type === 'worker');
        if (workers.length === 0) {
            return [{
                id: uuidv4(),
                description: message,
                status: 'pending',
                priority: 0,
                dependencies: [],
                createdAt: Date.now()
            }];
        }

        const agentList = workers.map(a => {
            let toolInfo = '';
            if (a.assignedTool) {
                toolInfo = a.assignedTool.toolName
                    ? ` (tool: ${a.assignedTool.toolName})`
                    : ` (all tools from: ${a.assignedTool.serverId})`;
            }
            return `- ${a.name}${toolInfo}: ${a.systemPrompt.substring(0, 120)}...`;
        }).join('\n');

        const prompt = `You are a task planner. Break the user request into the minimum number of subtasks needed. Assign each subtask to exactly one agent from the list. Order matters: earlier task outputs are automatically passed as context to later tasks.

User request: "${message}"

Available agents (use exact names):
${agentList}

Rules:
- Create between 2 and ${Math.min(maxSubtasks, 4)} subtasks. Use FEWER tasks when possible.
- Each subtask must be assigned to one agent by name from the list above.
- Use "dependencies" to list task indices (0-based) that must complete before this task.
- priority: 0 for first task, 1 for second, etc.
- Keep descriptions clear and actionable. Include any relevant data (e.g. URLs) directly in the description.
- IMPORTANT: Do NOT create a subtask whose only purpose is to "retrieve" or "get" data from another agent — outputs flow automatically. For example, if task 0 returns a URL, task 1 will receive it in context automatically.
- IMPORTANT: Do NOT assign a task to an agent that doesn't have the right tools for it. A Browser Agent navigates/clicks; a Media/Knowledge agent retrieves data.
- A "recommend then play" flow needs exactly 2 tasks: (1) get recommendation, (2) navigate to URL.

Respond with valid JSON only:
{"tasks": [
  {"description": "...", "agentName": "...", "priority": 0, "dependencies": []},
  ...
]}

JSON:`;

        try {
            const session = await this.ai.createSession({ language: 'en', temperature: 0.2 });
            const raw = await this.ai.generate(prompt, session);
            session.destroy();

            const json = extractJson(raw, { logFailure: true });
            const taskSpecs = json?.tasks;
            if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) {
                return this.singleTaskFallback(message, workers);
            }

            const taskIdByPriority = new Map<number, string>();
            const tasks: Task[] = [];
            const now = Date.now();

            for (let i = 0; i < Math.min(taskSpecs.length, maxSubtasks); i++) {
                const spec = taskSpecs[i];
                const description = typeof spec.description === 'string' ? spec.description.trim() : String(spec.description || '');
                const agentName = typeof spec.agentName === 'string' ? spec.agentName.trim() : '';
                const priority = typeof spec.priority === 'number' ? spec.priority : i;
                const depIndices = Array.isArray(spec.dependencies) ? spec.dependencies : [];

                const agent = workers.find(a => a.name === agentName)
                    ?? workers.find(a => a.name.toLowerCase().includes(agentName.toLowerCase()))
                    ?? workers[0];

                const id = uuidv4();
                taskIdByPriority.set(priority, id);

                const dependencies = depIndices
                    .map((idx: number) => taskIdByPriority.get(idx))
                    .filter(Boolean) as string[];

                tasks.push({
                    id,
                    description: description || message,
                    status: 'pending',
                    targetAgentId: agent.id,
                    targetAgentName: agent.name,
                    priority,
                    dependencies,
                    createdAt: now
                });
            }

            // Sort by priority for consistent execution order
            tasks.sort((a, b) => a.priority - b.priority);
            return tasks;
        } catch (e) {
            console.error('TaskDecomposer.decomposeTask failed', e);
            return this.singleTaskFallback(message, workers);
        }
    }

    private singleTaskFallback(message: string, workers: Agent[]): Task[] {
        const agent = workers[0];
        return [{
            id: uuidv4(),
            description: message,
            status: 'pending',
            targetAgentId: agent?.id,
            targetAgentName: agent?.name,
            priority: 0,
            dependencies: [],
            createdAt: Date.now()
        }];
    }
}
