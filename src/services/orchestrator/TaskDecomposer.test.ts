import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskDecomposer } from './TaskDecomposer';
import type { Agent } from '../../store/db';

const mockGenerate = vi.fn();
vi.mock('../ai/ChromeAIService', () => ({
    ChromeAIService: {
        getInstance: () => ({
            createSession: vi.fn().mockResolvedValue({ destroy: vi.fn() }),
            generate: mockGenerate
        })
    }
}));

describe('TaskDecomposer', () => {
    let decomposer: TaskDecomposer;

    beforeEach(() => {
        vi.clearAllMocks();
        decomposer = TaskDecomposer.getInstance();
    });

    it('analyzeComplexity returns needsDecomposition true when AI says true', async () => {
        mockGenerate.mockResolvedValue(
            '{"needsDecomposition": true, "reasoning": "Multiple steps required"}'
        );
        const result = await decomposer.analyzeComplexity('Fetch data, analyze it, and report');
        expect(result.needsDecomposition).toBe(true);
        expect(result.reasoning).toContain('Multiple');
    });

    it('analyzeComplexity returns needsDecomposition false when AI says false', async () => {
        mockGenerate.mockResolvedValue(
            '{"needsDecomposition": false, "reasoning": "Single action"}'
        );
        const result = await decomposer.analyzeComplexity('What time is it?');
        expect(result.needsDecomposition).toBe(false);
    });

    it('analyzeComplexity returns false on parse failure', async () => {
        mockGenerate.mockResolvedValue('not valid json');
        const result = await decomposer.analyzeComplexity('hello');
        expect(result.needsDecomposition).toBe(false);
        expect(result.reasoning).toBeDefined();
    });

    it('decomposeTask returns single task when no workers', async () => {
        const tasks = await decomposer.decomposeTask('Do something', []);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].description).toBe('Do something');
        expect(tasks[0].status).toBe('pending');
        expect(tasks[0].dependencies).toEqual([]);
    });

    it('decomposeTask returns single task fallback when AI returns invalid response', async () => {
        mockGenerate.mockResolvedValue('{}');
        const workers: Agent[] = [
            {
                id: 'w1',
                name: 'Worker One',
                systemPrompt: 'Help',
                type: 'worker',
                enabled: true,
                createdAt: Date.now()
            }
        ];
        const tasks = await decomposer.decomposeTask('Complex task', workers);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].targetAgentId).toBe('w1');
        expect(tasks[0].targetAgentName).toBe('Worker One');
    });

    it('decomposeTask parses AI response into ordered tasks with agent assignment', async () => {
        const workers: Agent[] = [
            { id: 'a1', name: 'SearchAgent', systemPrompt: 'Search', type: 'worker', enabled: true, createdAt: Date.now() },
            { id: 'a2', name: 'ReportAgent', systemPrompt: 'Report', type: 'worker', enabled: true, createdAt: Date.now() }
        ];
        mockGenerate.mockResolvedValue(
            JSON.stringify({
                tasks: [
                    { description: 'Search for info', agentName: 'SearchAgent', priority: 0, dependencies: [] },
                    { description: 'Write report', agentName: 'ReportAgent', priority: 1, dependencies: [0] }
                ]
            })
        );
        const tasks = await decomposer.decomposeTask('Search and report', workers);
        expect(tasks.length).toBeGreaterThanOrEqual(1);
        expect(tasks[0].description).toBe('Search for info');
        expect(tasks[0].targetAgentName).toBe('SearchAgent');
        expect(tasks[0].priority).toBe(0);
    });
});
