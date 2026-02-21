import Dexie, { type EntityTable } from 'dexie';

export interface Agent {
    id: string;
    name: string;
    systemPrompt: string;
    type: 'orchestrator' | 'worker';
    enabled: boolean;
    parentId?: string;
    assignedTool?: {
        serverId: string;
        toolName?: string; // undefined = all tools from this server
    };
    createdAt: number;
}

export interface Message {
    id?: number;
    agentId: string;
    role: 'user' | 'model' | 'system';
    content: string;
    timestamp: number;
    metadata?: any;
}

export interface Settings {
    key: string;
    value: any;
}

export interface Task {
    id: string;
    parentId?: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    targetAgentId?: string;
    targetAgentName?: string;
    priority: number;
    dependencies: string[];
    result?: string;
    error?: string;
    createdAt: number;
    completedAt?: number;
    planId: string; // Links task to its TaskPlan
}

export interface TaskPlanRecord {
    id: string;
    userMessage: string;
    taskIds: string[]; // Ordered list of task IDs
    currentTaskIndex: number;
    status: 'planning' | 'executing' | 'completed' | 'failed';
    results: Record<string, string>; // Task ID → result
    createdAt: number;
    completedAt?: number;
}

export interface Knowledge {
    id: string;
    content: string;
    embedding: number[];
    metadata?: any;
    createdAt: number;
}

export interface WatchLaterItem {
    id: string;
    url: string;
    videoId: string;
    title: string;
    channel: string;
    durationSeconds: number;
    thumbnail: string;
    addedAt: number;
    watchedAt?: number;
    tags: string[];
    embedding: number[];
}

export interface Note {
    id: string;
    title?: string;
    content: string;
    tags: string[];
    source?: string;
    createdAt: number;
    updatedAt: number;
    embedding: number[];
}

const db = new Dexie('OperativeDB') as Dexie & {
    agents: EntityTable<Agent, 'id'>;
    messages: EntityTable<Message, 'id'>;
    settings: EntityTable<Settings, 'key'>;
    tasks: EntityTable<Task, 'id'>;
    taskPlans: EntityTable<TaskPlanRecord, 'id'>;
    knowledge: EntityTable<Knowledge, 'id'>;
    watchLater: EntityTable<WatchLaterItem, 'id'>;
    notes: EntityTable<Note, 'id'>;
};

db.version(1).stores({
    agents: 'id, name, type, enabled',
    messages: '++id, agentId, timestamp',
    settings: 'key'
});

db.version(2).stores({
    agents: 'id, name, type, enabled, parentId',
    messages: '++id, agentId, timestamp',
    settings: 'key'
});

db.version(3).stores({
    agents: 'id, name, type, enabled, parentId',
    messages: '++id, agentId, timestamp',
    settings: 'key',
    tasks: 'id, planId, status',
    taskPlans: 'id, status',
    knowledge: 'id, content, createdAt'
});

db.version(4).stores({
    agents:    'id, name, type, enabled, parentId',
    messages:  '++id, agentId, timestamp',
    settings:  'key',
    tasks:     'id, planId, status',
    taskPlans: 'id, status',
    knowledge: 'id, content, createdAt',
    watchLater:'id, videoId, addedAt, watchedAt, durationSeconds',
    notes:     'id, createdAt, updatedAt'
});

export { db };
