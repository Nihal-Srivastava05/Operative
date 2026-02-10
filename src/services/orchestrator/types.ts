import { Agent } from '../../store/db';

export interface AgentRunResult {
    output: string;
    toolCalls?: any[];
}

export interface RouterResponse {
    targetAgentId: string;
    refinedTask: string;
    reasoning: string; // Thoughts
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TaskPlanStatus = 'planning' | 'executing' | 'completed' | 'failed';

export interface Task {
    id: string;
    parentId?: string;
    description: string;
    status: TaskStatus;
    targetAgentId?: string;
    targetAgentName?: string;
    priority: number;
    dependencies: string[];
    result?: string;
    error?: string;
    createdAt: number;
    completedAt?: number;
}

export interface TaskPlan {
    id: string;
    userMessage: string;
    tasks: Task[];
    currentTaskIndex: number;
    status: TaskPlanStatus;
    results: Record<string, string>; // Task ID → result (serializable for IndexedDB)
    createdAt: number;
    completedAt?: number;
}

export interface DecompositionResult {
    needsDecomposition: boolean;
    reasoning: string;
    tasks?: Task[];
}
