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
        // Short-circuit: patterns that are always single-agent — no need to spend an LLM call.
        const single = message.trim().toLowerCase();
        const singleAgentPatterns = [
            /^(yes|yeah|yep|no|nope|ok|okay|sure|play|navigate|open\s*it?)[\s!.]*$/i, // short confirmations
            /\bon\s+youtube\b/i,                              // "search X on youtube"
            /^(search|find|look\s+up)\b/i,                   // "search X", "find X"
            /^(navigate\s+to|go\s+to|open\s+url|open\s+https?)/i, // "navigate to X"
        ];
        if (singleAgentPatterns.some(p => p.test(single))) {
            return { needsDecomposition: false, reasoning: 'Single-agent action.' };
        }

        const prompt = `You are a task analyst. Decide if the following user request requires multiple distinct steps that should be handled by different specialized agents in sequence.

User request: "${message}"

Consider decomposition when:
- The request explicitly asks for multiple things (e.g. "fetch X, then analyze Y, and summarize")
- The request implies a pipeline (e.g. "recommend a video then open it")
- Different steps need different skills or tools (e.g. get data from database → navigate browser)

Do NOT decompose when:
- The request is a single question or action
- One agent can reasonably handle the whole request
- The request is vague or very short
- The request is a YouTube search (e.g. "search X on youtube", "find X video on youtube") — one Browser Agent handles this in one step
- The request is navigate/open a URL — one Browser Agent handles this in one step

Respond with valid JSON only, no other text:
{"needsDecomposition": true or false, "reasoning": "brief"}

JSON:`;

        try {
            const session = await this.ai.createSession({ language: 'en', temperature: 0.2 });
            const raw = await this.ai.generate(prompt, session);
            session.destroy();

            const json = extractJson(raw, { logFailure: false });
            if (json && typeof json.needsDecomposition === 'boolean') {
                return {
                    needsDecomposition: json.needsDecomposition,
                    reasoning: typeof json.reasoning === 'string' ? json.reasoning : ''
                };
            }

            // Regex fallback: model often puts literal newlines inside the JSON string
            // values (e.g. reasoning) which makes JSON.parse fail. Extract just the bool.
            const boolMatch = raw.match(/"needsDecomposition"\s*:\s*(true|false)/);
            if (boolMatch) {
                return { needsDecomposition: boolMatch[1] === 'true', reasoning: '' };
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
- IMPORTANT: Do NOT assign a task to an agent that doesn't have the right tools for it. A Browser Agent navigates/clicks; a Media/Knowledge agent retrieves from databases.
- IMPORTANT: Do NOT create a "show", "display", "navigate to", or "open" task that follows a youtube_search task — the search already navigates the browser. If the previous task searched YouTube, no follow-up navigation task is needed.
- A "recommend then play" flow needs exactly 2 tasks: (1) Media Curator gets recommendation with URL, (2) Browser Agent navigates to that URL.
- A "search X on youtube" request needs exactly 1 task: Browser Agent calls youtube_search. Do NOT add a Media Curator task before it.

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

            // Post-check: if every subtask goes to the same agent, decomposition adds no value.
            // This catches cases like "search + show results" where both tasks hit Browser Agent.
            const uniqueAgents = new Set(tasks.map(t => t.targetAgentId).filter(Boolean));
            if (uniqueAgents.size <= 1) {
                console.log('[TaskDecomposer] All subtasks assigned to same agent — collapsing to single task.');
                return this.singleTaskFallback(message, workers);
            }

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
