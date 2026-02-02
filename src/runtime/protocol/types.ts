/**
 * Protocol types for inter-agent communication
 * All messages follow a structured JSON protocol
 */

/** Context types where agents can run */
export type ContextType = 'service-worker' | 'tab' | 'offscreen' | 'content-script' | 'side-panel';

/** Unique identity for each agent instance */
export interface AgentIdentity {
  /** Unique instance ID (generated at spawn) */
  id: string;
  /** Reference to the agent definition in the database */
  definitionId: string;
  /** The browser context type hosting this agent */
  contextType: ContextType;
  /** Tab ID if running in a tab context */
  tabId?: number;
  /** Window ID if relevant */
  windowId?: number;
}

/** All supported message types in the protocol */
export type MessageType =
  // Task delegation
  | 'task:delegate'
  | 'task:accept'
  | 'task:reject'
  | 'task:progress'
  | 'task:result'
  | 'task:error'
  // State synchronization
  | 'state:sync'
  | 'state:request'
  | 'state:update'
  // Heartbeat for liveness
  | 'heartbeat:ping'
  | 'heartbeat:pong'
  // Lifecycle management
  | 'lifecycle:spawn'
  | 'lifecycle:ready'
  | 'lifecycle:terminate'
  | 'lifecycle:terminated'
  // Memory operations
  | 'memory:read'
  | 'memory:write'
  | 'memory:delete'
  | 'memory:changed'
  // Registry operations
  | 'registry:register'
  | 'registry:unregister'
  | 'registry:query'
  | 'registry:response';

/** Target specification for message routing */
export type MessageTarget =
  | { type: 'broadcast' }                    // All agents on a channel
  | { type: 'coordinator' }                  // Service worker coordinator
  | { type: 'agent'; agentId: string }       // Specific agent instance
  | { type: 'definition'; definitionId: string }; // Any agent of a definition

/** Base message structure for all inter-agent communication */
export interface AgentMessage<T = unknown> {
  /** Unique message ID */
  id: string;
  /** Correlation ID for request/response tracking */
  correlationId?: string;
  /** Type of message */
  type: MessageType;
  /** Source agent identity */
  source: AgentIdentity;
  /** Target specification */
  target: MessageTarget;
  /** Message payload (type varies by MessageType) */
  payload: T;
  /** Creation timestamp */
  timestamp: number;
  /** Time-to-live in milliseconds (optional) */
  ttl?: number;
}

// ============================================================================
// Task Payloads
// ============================================================================

export interface TaskDelegatePayload {
  taskId: string;
  task: string;
  priority: 'low' | 'normal' | 'high';
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface TaskAcceptPayload {
  taskId: string;
}

export interface TaskRejectPayload {
  taskId: string;
  reason: string;
}

export interface TaskProgressPayload {
  taskId: string;
  progress: number; // 0-100
  status: string;
}

export interface TaskResultPayload {
  taskId: string;
  result: unknown;
  toolCalls?: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    result: unknown;
  }>;
}

export interface TaskErrorPayload {
  taskId: string;
  error: string;
  code?: string;
  recoverable: boolean;
}

// ============================================================================
// Lifecycle Payloads
// ============================================================================

export interface LifecycleSpawnPayload {
  definitionId: string;
  contextType: ContextType;
  config?: Record<string, unknown>;
}

export interface LifecycleReadyPayload {
  capabilities: string[];
}

export interface LifecycleTerminatePayload {
  reason: 'requested' | 'error' | 'timeout' | 'shutdown';
  graceful: boolean;
}

// ============================================================================
// Memory Payloads
// ============================================================================

export interface MemoryReadPayload {
  namespace: string;
  key: string;
}

export interface MemoryWritePayload {
  namespace: string;
  key: string;
  value: unknown;
  ttl?: number;
}

export interface MemoryDeletePayload {
  namespace: string;
  key: string;
}

export interface MemoryChangedPayload {
  namespace: string;
  key: string;
  operation: 'write' | 'delete';
  newValue?: unknown;
  oldValue?: unknown;
}

// ============================================================================
// Registry Payloads
// ============================================================================

export interface RegistryRegisterPayload {
  identity: AgentIdentity;
  capabilities: string[];
  status: 'idle' | 'busy' | 'error' | 'terminated';
}

export interface RegistryQueryPayload {
  filter?: {
    definitionId?: string;
    contextType?: ContextType;
    status?: 'idle' | 'busy' | 'error' | 'terminated';
  };
}

export interface RegistryResponsePayload {
  agents: Array<{
    identity: AgentIdentity;
    status: 'idle' | 'busy' | 'error' | 'terminated';
    lastHeartbeat: number;
  }>;
}

// ============================================================================
// Heartbeat Payloads
// ============================================================================

export interface HeartbeatPingPayload {
  timestamp: number;
}

export interface HeartbeatPongPayload {
  timestamp: number;
  originalTimestamp: number;
  status: 'idle' | 'busy' | 'error' | 'terminated';
  currentTaskId?: string;
}

// ============================================================================
// Utility Types
// ============================================================================

/** Type-safe message creation helpers */
export type MessagePayloadMap = {
  'task:delegate': TaskDelegatePayload;
  'task:accept': TaskAcceptPayload;
  'task:reject': TaskRejectPayload;
  'task:progress': TaskProgressPayload;
  'task:result': TaskResultPayload;
  'task:error': TaskErrorPayload;
  'lifecycle:spawn': LifecycleSpawnPayload;
  'lifecycle:ready': LifecycleReadyPayload;
  'lifecycle:terminate': LifecycleTerminatePayload;
  'lifecycle:terminated': Record<string, never>;
  'memory:read': MemoryReadPayload;
  'memory:write': MemoryWritePayload;
  'memory:delete': MemoryDeletePayload;
  'memory:changed': MemoryChangedPayload;
  'registry:register': RegistryRegisterPayload;
  'registry:unregister': Record<string, never>;
  'registry:query': RegistryQueryPayload;
  'registry:response': RegistryResponsePayload;
  'heartbeat:ping': HeartbeatPingPayload;
  'heartbeat:pong': HeartbeatPongPayload;
  'state:sync': Record<string, unknown>;
  'state:request': { keys: string[] };
  'state:update': Record<string, unknown>;
};

/** Generate a unique message ID */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Generate a unique agent instance ID */
export function generateAgentId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Create a typed message */
export function createMessage<T extends MessageType>(
  type: T,
  source: AgentIdentity,
  target: MessageTarget,
  payload: MessagePayloadMap[T],
  correlationId?: string
): AgentMessage<MessagePayloadMap[T]> {
  return {
    id: generateMessageId(),
    correlationId,
    type,
    source,
    target,
    payload,
    timestamp: Date.now(),
  };
}

/** Check if a message has expired based on TTL */
export function isMessageExpired(message: AgentMessage): boolean {
  if (!message.ttl) return false;
  return Date.now() > message.timestamp + message.ttl;
}

/** Channel names for BroadcastChannel */
export const CHANNELS = {
  SYSTEM: 'operative:system',
  TASKS: 'operative:tasks',
  STATE: 'operative:state',
  MEMORY: 'operative:memory',
} as const;

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS];
