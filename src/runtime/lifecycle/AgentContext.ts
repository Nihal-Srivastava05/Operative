/**
 * AgentContext - Runtime that initializes in each agent context
 *
 * Provides unified interface for agents regardless of their execution context:
 * - BroadcastChannel communication
 * - Local and Global memory access
 * - Task handling
 * - Heartbeat emission
 * - Graceful shutdown
 */

import {
  AgentIdentity,
  AgentMessage,
  TaskDelegatePayload,
  TaskResultPayload,
  TaskErrorPayload,
  CHANNELS,
  generateAgentId,
  ContextType,
} from '../protocol/types';
import { BroadcastManager, getBroadcastManager } from '../channels/BroadcastManager';
import { GlobalMemory } from '../memory/GlobalMemory';
import { LocalMemory, createLocalMemory } from '../memory/LocalMemory';
import { db, Agent } from '../../store/db';

export interface AgentContextConfig {
  /** Pre-assigned agent instance ID (or generate new one) */
  agentId?: string;
  /** Agent definition ID from database */
  definitionId: string;
  /** Context type this agent is running in */
  contextType: ContextType;
  /** Tab ID if running in a tab */
  tabId?: number;
  /** Window ID if relevant */
  windowId?: number;
  /** Additional configuration */
  config?: Record<string, unknown>;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
}

export interface TaskHandler {
  (task: TaskDelegatePayload): Promise<unknown>;
}

/**
 * AgentContext provides the runtime environment for an agent instance
 */
export class AgentContext {
  readonly identity: AgentIdentity;
  readonly broadcast: BroadcastManager;
  readonly globalMemory: GlobalMemory;
  readonly localMemory: LocalMemory;

  private definition: Agent | null = null;
  private taskHandler: TaskHandler | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private status: 'initializing' | 'idle' | 'busy' | 'error' | 'terminated' = 'initializing';
  private currentTaskId: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private config: Record<string, unknown>;

  constructor(contextConfig: AgentContextConfig) {
    // Create identity
    this.identity = {
      id: contextConfig.agentId || generateAgentId(),
      definitionId: contextConfig.definitionId,
      contextType: contextConfig.contextType,
      tabId: contextConfig.tabId,
      windowId: contextConfig.windowId,
    };

    // Initialize components
    this.broadcast = getBroadcastManager();
    this.broadcast.setIdentity(this.identity);

    this.globalMemory = new GlobalMemory(this.identity);
    this.localMemory = createLocalMemory();

    this.heartbeatIntervalMs = contextConfig.heartbeatInterval ?? 30000;
    this.config = contextConfig.config ?? {};

    console.log(`[AgentContext] Created context for agent ${this.identity.id}`);
  }

  /**
   * Initialize the agent context (call after construction)
   */
  async initialize(): Promise<void> {
    try {
      // Load agent definition from database
      await this.loadDefinition();

      // Register with coordinator
      await this.registerWithCoordinator();

      // Subscribe to messages
      this.setupMessageHandlers();

      // Start heartbeat
      this.startHeartbeat();

      // Mark as ready
      this.status = 'idle';

      // Notify coordinator we're ready
      this.broadcast.publishSystem(
        'lifecycle:ready',
        { type: 'coordinator' },
        { capabilities: this.getCapabilities() }
      );

      console.log(`[AgentContext] Agent ${this.identity.id} initialized and ready`);
    } catch (error) {
      this.status = 'error';
      console.error(`[AgentContext] Failed to initialize agent ${this.identity.id}:`, error);
      throw error;
    }
  }

  /**
   * Load agent definition from database
   */
  private async loadDefinition(): Promise<void> {
    this.definition = await db.agents.get(this.identity.definitionId) ?? null;

    if (!this.definition) {
      throw new Error(`Agent definition not found: ${this.identity.definitionId}`);
    }

    console.log(`[AgentContext] Loaded definition: ${this.definition.name}`);
  }

  /**
   * Register with the coordinator
   */
  private async registerWithCoordinator(): Promise<void> {
    this.broadcast.publishSystem(
      'registry:register',
      { type: 'coordinator' },
      {
        identity: this.identity,
        capabilities: this.getCapabilities(),
        status: 'idle',
      }
    );
  }

  /**
   * Get agent capabilities
   */
  private getCapabilities(): string[] {
    const capabilities: string[] = [];

    if (this.definition?.assignedTool) {
      capabilities.push(`tool:${this.definition.assignedTool.toolName}`);
    }

    if (this.definition?.type === 'orchestrator') {
      capabilities.push('orchestrator');
    }

    return capabilities;
  }

  /**
   * Setup message handlers for incoming messages
   */
  private setupMessageHandlers(): void {
    // Handle task delegation
    const taskUnsub = this.broadcast.subscribeTasks<TaskDelegatePayload>(
      async (message) => {
        if (message.type !== 'task:delegate') return;
        await this.handleTaskDelegate(message);
      },
      { type: 'task:delegate' }
    );
    this.unsubscribers.push(taskUnsub);

    // Handle heartbeat pings
    const heartbeatUnsub = this.broadcast.subscribeSystem(
      (message) => {
        if (message.type !== 'heartbeat:ping') return;
        this.handleHeartbeatPing(message);
      },
      { type: 'heartbeat:ping' }
    );
    this.unsubscribers.push(heartbeatUnsub);

    // Handle termination requests
    const terminateUnsub = this.broadcast.subscribeSystem(
      async (message) => {
        if (message.type !== 'lifecycle:terminate') return;
        await this.handleTerminate(message);
      },
      { type: 'lifecycle:terminate' }
    );
    this.unsubscribers.push(terminateUnsub);
  }

  /**
   * Handle incoming task delegation
   */
  private async handleTaskDelegate(message: AgentMessage<TaskDelegatePayload>): Promise<void> {
    const payload = message.payload;

    // Check if we can accept
    if (this.status !== 'idle') {
      this.broadcast.publishTask(
        'task:reject',
        { type: 'agent', agentId: message.source.id },
        { taskId: payload.taskId, reason: `Agent is ${this.status}` },
        { correlationId: message.id }
      );
      return;
    }

    // Accept the task
    this.status = 'busy';
    this.currentTaskId = payload.taskId;

    this.broadcast.publishTask(
      'task:accept',
      { type: 'agent', agentId: message.source.id },
      { taskId: payload.taskId },
      { correlationId: message.id }
    );

    try {
      // Execute the task
      let result: unknown;

      if (this.taskHandler) {
        result = await this.taskHandler(payload);
      } else {
        // Default handler - just return task acknowledgment
        result = { message: 'Task received but no handler configured', task: payload.task };
      }

      // Report success
      this.broadcast.publishTask(
        'task:result',
        { type: 'agent', agentId: message.source.id },
        { taskId: payload.taskId, result },
        { correlationId: message.id }
      );
    } catch (error) {
      // Report error
      this.broadcast.publishTask(
        'task:error',
        { type: 'agent', agentId: message.source.id },
        {
          taskId: payload.taskId,
          error: error instanceof Error ? error.message : 'Unknown error',
          recoverable: false,
        },
        { correlationId: message.id }
      );
    } finally {
      this.status = 'idle';
      this.currentTaskId = null;
    }
  }

  /**
   * Handle heartbeat ping from coordinator
   */
  private handleHeartbeatPing(message: AgentMessage): void {
    this.broadcast.publishSystem(
      'heartbeat:pong',
      { type: 'coordinator' },
      {
        timestamp: Date.now(),
        originalTimestamp: (message.payload as { timestamp: number }).timestamp,
        status: this.status === 'initializing' ? 'idle' : this.status,
        currentTaskId: this.currentTaskId || undefined,
      },
      { correlationId: message.id }
    );
  }

  /**
   * Handle termination request
   */
  private async handleTerminate(message: AgentMessage): Promise<void> {
    console.log(`[AgentContext] Received termination request for agent ${this.identity.id}`);

    // Graceful shutdown
    await this.shutdown();
  }

  /**
   * Start sending periodic heartbeats
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      // The heartbeat response is sent when we receive a ping
      // This interval is just to ensure we're alive
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Set the task handler for this agent
   */
  setTaskHandler(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  /**
   * Get the agent definition
   */
  getDefinition(): Agent | null {
    return this.definition;
  }

  /**
   * Get the system prompt from the definition
   */
  getSystemPrompt(): string {
    return this.definition?.systemPrompt ?? '';
  }

  /**
   * Get current status
   */
  getStatus(): string {
    return this.status;
  }

  /**
   * Get configuration
   */
  getConfig<T = unknown>(key: string): T | undefined {
    return this.config[key] as T | undefined;
  }

  /**
   * Delegate a task to another agent
   */
  async delegateTask(
    task: string,
    options?: {
      targetAgentId?: string;
      targetDefinitionId?: string;
      priority?: 'low' | 'normal' | 'high';
      timeout?: number;
    }
  ): Promise<AgentMessage> {
    const taskId = generateAgentId().replace('agent_', 'task_');

    const target = options?.targetAgentId
      ? { type: 'agent' as const, agentId: options.targetAgentId }
      : options?.targetDefinitionId
        ? { type: 'definition' as const, definitionId: options.targetDefinitionId }
        : { type: 'coordinator' as const };

    return this.broadcast.publishTask(
      'task:delegate',
      target,
      {
        taskId,
        task,
        priority: options?.priority ?? 'normal',
        timeout: options?.timeout,
      }
    );
  }

  /**
   * Report task progress
   */
  reportProgress(taskId: string, progress: number, status: string): void {
    this.broadcast.publishTask(
      'task:progress',
      { type: 'broadcast' },
      { taskId, progress, status }
    );
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log(`[AgentContext] Shutting down agent ${this.identity.id}`);

    this.status = 'terminated';

    // Stop heartbeat
    this.stopHeartbeat();

    // Unsubscribe from all messages
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Persist local memory to global memory for recovery
    try {
      const snapshot = this.localMemory.toJSON();
      await this.globalMemory.write(
        `agent:${this.identity.id}`,
        'localMemorySnapshot',
        snapshot,
        { ttl: 24 * 60 * 60 * 1000 } // 24 hour TTL
      );
    } catch (error) {
      console.warn('[AgentContext] Failed to persist local memory:', error);
    }

    // Notify coordinator
    this.broadcast.publishSystem(
      'lifecycle:terminated',
      { type: 'coordinator' },
      {}
    );

    // Unregister
    this.broadcast.publishSystem(
      'registry:unregister',
      { type: 'coordinator' },
      {}
    );

    // Cleanup
    this.globalMemory.destroy();

    console.log(`[AgentContext] Agent ${this.identity.id} shutdown complete`);
  }
}

/**
 * Create and initialize an agent context
 */
export async function createAgentContext(config: AgentContextConfig): Promise<AgentContext> {
  const context = new AgentContext(config);
  await context.initialize();
  return context;
}

/**
 * Parse URL parameters for agent initialization (used in agent pages)
 */
export function parseAgentParams(): AgentContextConfig | null {
  const params = new URLSearchParams(window.location.search);

  const definitionId = params.get('definitionId');
  if (!definitionId) {
    console.error('[AgentContext] Missing definitionId parameter');
    return null;
  }

  let config: Record<string, unknown> = {};
  const configParam = params.get('config');
  if (configParam) {
    try {
      config = JSON.parse(configParam);
    } catch (error) {
      console.warn('[AgentContext] Failed to parse config parameter:', error);
    }
  }

  return {
    agentId: params.get('agentId') || undefined,
    definitionId,
    contextType: 'tab', // Will be overridden based on actual context
    config,
  };
}
