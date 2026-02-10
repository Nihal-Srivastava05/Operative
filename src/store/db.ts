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
        toolName: string;
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

const db = new Dexie('OperativeDB') as Dexie & {
    agents: EntityTable<Agent, 'id'>;
    messages: EntityTable<Message, 'id'>;
    settings: EntityTable<Settings, 'key'>;
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

export { db };
