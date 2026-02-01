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
