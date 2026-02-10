import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskQueue } from './TaskQueue';
import type { Task } from './types';

const { taskPlansStore, tasksStore, mockDb } = vi.hoisted(() => {
    const taskPlansStore = new Map<string, any>();
    const tasksStore = new Map<string, any>();
    const mockDb = {
        taskPlans: {
            add: vi.fn(async (record: any) => {
                taskPlansStore.set(record.id, { ...record });
            }),
            get: vi.fn(async (id: string) => taskPlansStore.get(id) ?? null),
            update: vi.fn(async (id: string, updates: any) => {
                const existing = taskPlansStore.get(id);
                if (existing) taskPlansStore.set(id, { ...existing, ...updates });
            }),
            where: vi.fn(() => ({
                equals: vi.fn(() => ({
                    first: vi.fn(async () => {
                        for (const p of taskPlansStore.values()) {
                            if (p.status === 'executing') return p;
                        }
                        return null;
                    })
                }))
            }))
        },
        tasks: {
            add: vi.fn(async (task: any) => {
                tasksStore.set(task.id, { ...task });
            }),
            get: vi.fn(async (id: string) => tasksStore.get(id) ?? null),
            update: vi.fn(async (id: string, updates: any) => {
                const existing = tasksStore.get(id);
                if (existing) tasksStore.set(id, { ...existing, ...updates });
            }),
            where: vi.fn((_field: string) => ({
                equals: vi.fn((planId: string) => ({
                    sortBy: vi.fn(async (_sortField: string) => {
                        return Array.from(tasksStore.values())
                            .filter((t: any) => t.planId === planId)
                            .sort((a: any, b: any) => a.priority - b.priority);
                    })
                }))
            }))
        }
    };
    return { taskPlansStore, tasksStore, mockDb };
});

vi.mock('../../store/db', () => ({ db: mockDb }));

describe('TaskQueue', () => {
    let queue: TaskQueue;

    beforeEach(() => {
        taskPlansStore.clear();
        tasksStore.clear();
        vi.clearAllMocks();
        TaskQueue.getInstance();
        queue = TaskQueue.getInstance();
    });

    it('createPlan persists tasks and returns plan', async () => {
        const tasks: Task[] = [
            { id: 't1', description: 'First', status: 'pending', priority: 0, dependencies: [], createdAt: 1 },
            { id: 't2', description: 'Second', status: 'pending', priority: 1, dependencies: ['t1'], createdAt: 1 }
        ];
        const plan = await queue.createPlan(tasks, 'User message');
        expect(plan.id).toBeDefined();
        expect(plan.userMessage).toBe('User message');
        expect(plan.tasks).toHaveLength(2);
        expect(plan.status).toBe('executing');
        expect(mockDb.taskPlans.add).toHaveBeenCalled();
        expect(mockDb.tasks.add).toHaveBeenCalledTimes(2);
    });

    it('getCurrentPlan returns null when no executing plan', async () => {
        const plan = await queue.getCurrentPlan();
        expect(plan).toBeNull();
    });

    it('getNextTask returns first pending task and marks in progress', async () => {
        const tasks: Task[] = [
            { id: 't1', description: 'First', status: 'pending', priority: 0, dependencies: [], createdAt: 1 },
            { id: 't2', description: 'Second', status: 'pending', priority: 1, dependencies: ['t1'], createdAt: 1 }
        ];
        await queue.createPlan(tasks, 'Msg');
        const next = await queue.getNextTask();
        expect(next).not.toBeNull();
        expect(next!.id).toBe('t1');
        expect(next!.description).toBe('First');
    });

    it('getNextTask respects dependencies', async () => {
        const tasks: Task[] = [
            { id: 't1', description: 'First', status: 'pending', priority: 0, dependencies: [], createdAt: 1 },
            { id: 't2', description: 'Second', status: 'pending', priority: 1, dependencies: ['t1'], createdAt: 1 }
        ];
        await queue.createPlan(tasks, 'Msg');
        const first = await queue.getNextTask();
        expect(first!.id).toBe('t1');
        await queue.markTaskComplete('t1', 'done');
        const second = await queue.getNextTask();
        expect(second!.id).toBe('t2');
    });

    it('markTaskComplete updates task and plan results', async () => {
        const tasks: Task[] = [
            { id: 't1', description: 'First', status: 'pending', priority: 0, dependencies: [], createdAt: 1 }
        ];
        await queue.createPlan(tasks, 'Msg');
        await queue.getNextTask();
        await queue.markTaskComplete('t1', 'Result text');
        expect(mockDb.tasks.update).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'completed', result: 'Result text' }));
    });

    it('isPlanComplete returns true when no plan or all tasks done', async () => {
        expect(await queue.isPlanComplete()).toBe(true);
        const tasks: Task[] = [
            { id: 't1', description: 'Only', status: 'pending', priority: 0, dependencies: [], createdAt: 1 }
        ];
        await queue.createPlan(tasks, 'Msg');
        expect(await queue.isPlanComplete()).toBe(false);
        await queue.getNextTask();
        await queue.markTaskComplete('t1', 'ok');
        expect(await queue.isPlanComplete()).toBe(true);
    });

    it('aggregateResults returns combined response when plan exists', async () => {
        const tasks: Task[] = [
            { id: 't1', description: 'One', status: 'pending', priority: 0, dependencies: [], createdAt: 1, targetAgentName: 'Agent1' },
            { id: 't2', description: 'Two', status: 'pending', priority: 1, dependencies: ['t1'], createdAt: 1, targetAgentName: 'Agent2' }
        ];
        await queue.createPlan(tasks, 'Msg');
        await queue.getNextTask();
        await queue.markTaskComplete('t1', 'Result one');
        await queue.getNextTask();
        await queue.markTaskComplete('t2', 'Result two');
        const { response, agentName } = await queue.aggregateResults();
        expect(agentName).toBe('Orchestrator');
        expect(response).toContain('Result one');
        expect(response).toContain('Result two');
    });
});
