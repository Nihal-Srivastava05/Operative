import Dexie, { type EntityTable } from 'dexie';

// ============================================================================
// Agent Definitions (existing)
// ============================================================================

export interface Agent {
    id: string;
    name: string;
    systemPrompt: string;
    type: 'orchestrator' | 'worker';
    enabled: boolean;
    assignedTool?: {
        serverId: string;
        toolName: string;
    };
    createdAt: number;
}

// ============================================================================
// Messages (existing)
// ============================================================================

export interface Message {
    id?: number;
    agentId: string;
    role: 'user' | 'model' | 'system';
    content: string;
    timestamp: number;
    metadata?: any;
}

// ============================================================================
// Settings (existing)
// ============================================================================

export interface Settings {
    key: string;
    value: any;
}

// ============================================================================
// Global Memory (new) - IndexedDB-backed shared memory
// ============================================================================

export interface MemoryEntry {
    /** Composite key: `${namespace}:${key}` */
    id: string;
    /** Agent ID or "shared" for global access */
    namespace: string;
    /** Key within the namespace */
    key: string;
    /** Stored value (can be any JSON-serializable type) */
    value: unknown;
    /** Version for optimistic concurrency control */
    version: number;
    /** Agent ID that created this entry */
    createdBy: string;
    /** Agent ID that last updated this entry */
    updatedBy: string;
    /** Creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
    /** Optional TTL - entry expires after this timestamp */
    expiresAt?: number;
}

// ============================================================================
// Agent States (new) - Runtime state of active agent instances
// ============================================================================

export type AgentStatus = 'idle' | 'busy' | 'error' | 'terminated';

export interface AgentState {
    /** Unique instance ID (different from definition ID) */
    agentInstanceId: string;
    /** Reference to the agent definition */
    definitionId: string;
    /** Context where the agent is running */
    contextType: 'service-worker' | 'tab' | 'offscreen' | 'content-script' | 'side-panel';
    /** Current status */
    status: AgentStatus;
    /** Tab ID if running in a tab */
    tabId?: number;
    /** Window ID if relevant */
    windowId?: number;
    /** Last heartbeat timestamp */
    lastHeartbeat: number;
    /** Current task being processed */
    currentTask?: string;
    /** Task ID being processed */
    currentTaskId?: string;
    /** Capabilities this agent instance supports */
    capabilities: string[];
    /** When this instance was spawned */
    spawnedAt: number;
    /** Serialized local memory for recovery */
    localMemorySnapshot?: string;
}

// ============================================================================
// Task Queue (new) - Persistent task queue
// ============================================================================

export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface QueuedTask {
    /** Unique task ID */
    id: string;
    /** Task description/prompt */
    task: string;
    /** Priority level */
    priority: TaskPriority;
    /** Current status */
    status: TaskStatus;
    /** Agent instance assigned to this task */
    assignedAgentId?: string;
    /** Agent definition to target (optional) */
    targetDefinitionId?: string;
    /** Additional context for the task */
    context?: Record<string, unknown>;
    /** Task result when completed */
    result?: unknown;
    /** Error message if failed */
    error?: string;
    /** Number of retry attempts */
    retryCount: number;
    /** Maximum retries allowed */
    maxRetries: number;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Agent that created this task */
    createdBy: string;
    /** Creation timestamp */
    createdAt: number;
    /** When task was assigned */
    assignedAt?: number;
    /** When task started processing */
    startedAt?: number;
    /** When task completed/failed */
    completedAt?: number;
    /** Parent task ID for sub-tasks */
    parentTaskId?: string;
    /** Correlation ID for request tracking */
    correlationId?: string;
}

// ============================================================================
// Workflow Executions (new) - Track workflow runs
// ============================================================================

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowExecution {
    /** Unique execution ID */
    id: string;
    /** Workflow definition ID */
    workflowId: string;
    /** Current status */
    status: WorkflowStatus;
    /** Current step being executed */
    currentStep?: string;
    /** Map of step outputs */
    stepOutputs: Record<string, unknown>;
    /** Workflow input */
    input?: unknown;
    /** Final output when completed */
    output?: unknown;
    /** Error if failed */
    error?: string;
    /** Creation timestamp */
    createdAt: number;
    /** Start timestamp */
    startedAt?: number;
    /** Completion timestamp */
    completedAt?: number;
}

// ============================================================================
// Database Definition
// ============================================================================

const db = new Dexie('OperativeDB') as Dexie & {
    agents: EntityTable<Agent, 'id'>;
    messages: EntityTable<Message, 'id'>;
    settings: EntityTable<Settings, 'key'>;
    memory: EntityTable<MemoryEntry, 'id'>;
    agentStates: EntityTable<AgentState, 'agentInstanceId'>;
    taskQueue: EntityTable<QueuedTask, 'id'>;
    workflowExecutions: EntityTable<WorkflowExecution, 'id'>;
};

// Version 1: Original schema
db.version(1).stores({
    agents: 'id, name, type, enabled',
    messages: '++id, agentId, timestamp',
    settings: 'key'
});

// Version 2: Multi-agent runtime schema
db.version(2).stores({
    agents: 'id, name, type, enabled',
    messages: '++id, agentId, timestamp',
    settings: 'key',
    memory: 'id, namespace, key, expiresAt, updatedAt',
    agentStates: 'agentInstanceId, definitionId, status, lastHeartbeat',
    taskQueue: 'id, status, priority, assignedAgentId, createdAt, [status+priority]',
    workflowExecutions: 'id, workflowId, status, createdAt'
});

export { db };

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a composite memory entry ID
 */
export function createMemoryId(namespace: string, key: string): string {
    return `${namespace}:${key}`;
}

/**
 * Parse a composite memory entry ID
 */
export function parseMemoryId(id: string): { namespace: string; key: string } {
    const colonIndex = id.indexOf(':');
    if (colonIndex === -1) {
        return { namespace: 'shared', key: id };
    }
    return {
        namespace: id.substring(0, colonIndex),
        key: id.substring(colonIndex + 1)
    };
}

/**
 * Clean up expired memory entries
 */
export async function cleanupExpiredMemory(): Promise<number> {
    const now = Date.now();
    const expired = await db.memory
        .where('expiresAt')
        .below(now)
        .toArray();

    if (expired.length > 0) {
        await db.memory.bulkDelete(expired.map(e => e.id));
    }

    return expired.length;
}

/**
 * Clean up terminated agent states older than specified age
 */
export async function cleanupTerminatedAgents(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const old = await db.agentStates
        .where('status')
        .equals('terminated')
        .filter(state => state.lastHeartbeat < cutoff)
        .toArray();

    if (old.length > 0) {
        await db.agentStates.bulkDelete(old.map(s => s.agentInstanceId));
    }

    return old.length;
}

/**
 * Get tasks by status with priority ordering
 */
export async function getTasksByStatus(status: TaskStatus): Promise<QueuedTask[]> {
    return db.taskQueue
        .where('[status+priority]')
        .between([status, 'high'], [status, 'low'], true, true)
        .reverse() // high priority first
        .toArray();
}

/**
 * Get pending tasks ordered by priority
 */
export async function getPendingTasks(): Promise<QueuedTask[]> {
    return getTasksByStatus('pending');
}
