import { v4 as uuidv4 } from 'uuid';
import { db } from '../../store/db';
import type { Task, TaskPlan } from './types';

export class TaskQueue {
    private static instance: TaskQueue;
    private activePlanId: string | null = null;

    private constructor() {}

    public static getInstance(): TaskQueue {
        if (!TaskQueue.instance) {
            TaskQueue.instance = new TaskQueue();
        }
        return TaskQueue.instance;
    }

    /**
     * Creates a new task plan from an array of tasks, persists to IndexedDB, and returns the in-memory plan.
     */
    public async createPlan(tasks: Task[], userMessage: string): Promise<TaskPlan> {
        const planId = uuidv4();
        const now = Date.now();
        const taskIds = tasks.map(t => t.id);

        const record = {
            id: planId,
            userMessage,
            taskIds,
            currentTaskIndex: 0,
            status: 'executing' as const,
            results: {} as Record<string, string>,
            createdAt: now
        };

        await db.taskPlans.add(record);

        for (const task of tasks) {
            await db.tasks.add({
                ...task,
                planId
            });
        }

        this.activePlanId = planId;

        return {
            id: planId,
            userMessage,
            tasks: tasks.map(t => ({ ...t })),
            currentTaskIndex: 0,
            status: 'executing',
            results: {},
            createdAt: now
        };
    }

    /**
     * Gets the current active plan (status === 'executing'), hydrated from DB, or null.
     */
    public async getCurrentPlan(): Promise<TaskPlan | null> {
        const planRecord = await db.taskPlans
            .where('status')
            .equals('executing')
            .first();

        if (!planRecord) {
            this.activePlanId = null;
            return null;
        }

        this.activePlanId = planRecord.id;
        return this.hydratePlan(planRecord);
    }

    /**
     * Returns the next task that is pending and whose dependencies are all completed.
     * Marks the task as in_progress. Returns null if no such task or plan is complete.
     */
    public async getNextTask(): Promise<Task | null> {
        const plan = await this.getCurrentPlan();
        if (!plan || plan.status !== 'executing') return null;

        const completedIds = new Set<string>();
        for (const t of plan.tasks) {
            if (t.status === 'completed' || t.status === 'failed') {
                completedIds.add(t.id);
            }
        }
        for (const taskId of Object.keys(plan.results)) {
            completedIds.add(taskId);
        }

        const pending = plan.tasks
            .filter(t => t.status === 'pending')
            .filter(t => t.dependencies.every(depId => completedIds.has(depId)))
            .sort((a, b) => a.priority - b.priority);

        if (pending.length === 0) return null;

        const next = pending[0];
        await this.markTaskInProgress(next.id);
        const updated = await db.tasks.get(next.id);
        if (!updated) return null;

        return this.dbTaskToTask(updated);
    }

    /**
     * Marks a task as completed with the given result. Updates both the task and the plan's results.
     */
    public async markTaskComplete(taskId: string, result: string): Promise<void> {
        const now = Date.now();
        await db.tasks.update(taskId, { status: 'completed', result, completedAt: now });

        const task = await db.tasks.get(taskId);
        if (task) {
            const planRecord = await db.taskPlans.get(task.planId);
            if (planRecord) {
                const results = { ...planRecord.results, [taskId]: result };
                await db.taskPlans.update(task.planId, { results });
            }
        }

        await this.checkPlanComplete();
    }

    /**
     * Marks a task as failed with the given error message.
     */
    public async markTaskFailed(taskId: string, error: string): Promise<void> {
        await db.tasks.update(taskId, { status: 'failed', error });

        const task = await db.tasks.get(taskId);
        if (task) {
            const planRecord = await db.taskPlans.get(task.planId);
            if (planRecord) {
                const results = { ...planRecord.results, [taskId]: `[Failed] ${error}` };
                await db.taskPlans.update(task.planId, { results });
            }
        }

        await this.checkPlanComplete();
    }

    /**
     * Returns whether the current plan has no more tasks to run (all completed or failed).
     */
    public async isPlanComplete(): Promise<boolean> {
        const plan = await this.getCurrentPlan();
        if (!plan) return true;

        const allDone = plan.tasks.every(
            t => t.status === 'completed' || t.status === 'failed'
        );
        if (allDone) return true;

        const completedIds = new Set(Object.keys(plan.results));
        for (const t of plan.tasks) {
            if (t.status === 'completed' || t.status === 'failed') completedIds.add(t.id);
        }
        const pending = plan.tasks.filter(
            t => t.status === 'pending' && t.dependencies.every(d => completedIds.has(d))
        );
        return pending.length === 0 && plan.tasks.some(t => t.status === 'pending') === false;
    }

    /**
     * Aggregates results of all completed tasks into a single response string.
     * Marks the plan as completed. Call after isPlanComplete() is true.
     */
    public async aggregateResults(): Promise<{ response: string; agentName: string }> {
        let planRecord = await db.taskPlans
            .where('status')
            .equals('executing')
            .first();

        if (!planRecord && this.activePlanId) {
            planRecord = await db.taskPlans.get(this.activePlanId);
        }

        if (!planRecord) {
            return { response: 'No active plan.', agentName: 'System' };
        }

        const now = Date.now();
        await db.taskPlans.update(planRecord.id, { status: 'completed', completedAt: now });

        const tasks = await db.tasks.where('planId').equals(planRecord.id).sortBy('priority');
        const parts: string[] = [];

        for (const task of tasks) {
            const result = planRecord.results[task.id] ?? task.result;
            if (result && task.status === 'completed') {
                parts.push(`**${task.targetAgentName ?? 'Agent'}:**\n${result}`);
            } else if (task.status === 'failed' && task.error) {
                parts.push(`**${task.targetAgentName ?? 'Agent'} (failed):** ${task.error}`);
            }
        }

        this.activePlanId = null;

        const response = parts.length > 0
            ? parts.join('\n\n---\n\n')
            : 'Task plan completed with no results.';
        return { response, agentName: 'Orchestrator' };
    }

    /**
     * Cancels the current plan (marks as failed). Optional.
     */
    public async cancelPlan(): Promise<void> {
        const planRecord = await db.taskPlans
            .where('status')
            .equals('executing')
            .first();
        if (planRecord) {
            await db.taskPlans.update(planRecord.id, { status: 'failed' });
            this.activePlanId = null;
        }
    }

    private async markTaskInProgress(taskId: string): Promise<void> {
        await db.tasks.update(taskId, { status: 'in_progress' });
    }

    private async checkPlanComplete(): Promise<void> {
        const plan = await this.getCurrentPlan();
        if (!plan) return;
        const allDone = plan.tasks.every(
            t => t.status === 'completed' || t.status === 'failed'
        );
        if (allDone) {
            await db.taskPlans.update(plan.id, {
                status: 'completed',
                completedAt: Date.now()
            });
            // Keep activePlanId so aggregateResults() can find the plan
        }
    }

    private async hydratePlan(planRecord: { id: string; userMessage: string; taskIds: string[]; currentTaskIndex: number; status: 'planning' | 'executing' | 'completed' | 'failed'; results: Record<string, string>; createdAt: number; completedAt?: number }): Promise<TaskPlan> {
        const taskRecords = await db.tasks.where('planId').equals(planRecord.id).sortBy('priority');
        const tasks = taskRecords.map(tr => this.dbTaskToTask(tr));
        return {
            id: planRecord.id,
            userMessage: planRecord.userMessage,
            tasks,
            currentTaskIndex: planRecord.currentTaskIndex,
            status: planRecord.status,
            results: { ...planRecord.results },
            createdAt: planRecord.createdAt,
            completedAt: planRecord.completedAt
        };
    }

    private dbTaskToTask(tr: { id: string; parentId?: string; description: string; status: string; targetAgentId?: string; targetAgentName?: string; priority: number; dependencies: string[]; result?: string; error?: string; createdAt: number; completedAt?: number }): Task {
        return {
            id: tr.id,
            parentId: tr.parentId,
            description: tr.description,
            status: tr.status as Task['status'],
            targetAgentId: tr.targetAgentId,
            targetAgentName: tr.targetAgentName,
            priority: tr.priority,
            dependencies: tr.dependencies ?? [],
            result: tr.result,
            error: tr.error,
            createdAt: tr.createdAt,
            completedAt: tr.completedAt
        };
    }
}
