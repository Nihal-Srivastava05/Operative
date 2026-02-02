/**
 * AgentRegistry - Central tracking of active agent instances
 *
 * Maintained by the Coordinator (service worker) to track:
 * - Active agent instances across all contexts
 * - Agent status and health
 * - Heartbeat monitoring
 */

import { db, AgentState, AgentStatus } from '../../store/db';
import { AgentIdentity, ContextType } from '../protocol/types';
import { getBroadcastManager } from '../channels/BroadcastManager';

export interface RegisteredAgent {
  identity: AgentIdentity;
  capabilities: string[];
  status: AgentStatus;
  lastHeartbeat: number;
  currentTaskId?: string;
  registeredAt: number;
}

export interface AgentFilter {
  definitionId?: string;
  contextType?: ContextType;
  status?: AgentStatus;
  hasCapability?: string;
}

export interface RegistryStats {
  total: number;
  byStatus: Record<AgentStatus, number>;
  byContextType: Record<ContextType, number>;
}

/**
 * AgentRegistry manages the lifecycle state of all agent instances
 */
export class AgentRegistry {
  private agents: Map<string, RegisteredAgent> = new Map();
  private heartbeatTimeout: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { heartbeatTimeoutMs?: number }) {
    this.heartbeatTimeout = options?.heartbeatTimeoutMs ?? 90000; // 90 seconds default
  }

  /**
   * Initialize the registry, loading persisted state
   */
  async initialize(): Promise<void> {
    await this.loadFromDatabase();
    this.startCleanupInterval();
  }

  /**
   * Load persisted agent states from database
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      const states = await db.agentStates.toArray();

      for (const state of states) {
        // Skip terminated agents
        if (state.status === 'terminated') continue;

        const agent: RegisteredAgent = {
          identity: {
            id: state.agentInstanceId,
            definitionId: state.definitionId,
            contextType: state.contextType as ContextType,
            tabId: state.tabId,
            windowId: state.windowId,
          },
          capabilities: state.capabilities,
          status: 'error', // Mark as error until heartbeat confirms
          lastHeartbeat: state.lastHeartbeat,
          currentTaskId: state.currentTaskId,
          registeredAt: state.spawnedAt,
        };

        this.agents.set(state.agentInstanceId, agent);
      }

      console.log(`[AgentRegistry] Loaded ${this.agents.size} agents from database`);
    } catch (error) {
      console.error('[AgentRegistry] Failed to load from database:', error);
    }
  }

  /**
   * Start periodic cleanup of stale agents
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.checkStaleAgents();
    }, 30000); // Check every 30 seconds
  }

  /**
   * Stop the cleanup interval
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Register a new agent instance
   */
  async register(
    identity: AgentIdentity,
    capabilities: string[] = [],
    status: AgentStatus = 'idle'
  ): Promise<void> {
    const agent: RegisteredAgent = {
      identity,
      capabilities,
      status,
      lastHeartbeat: Date.now(),
      registeredAt: Date.now(),
    };

    this.agents.set(identity.id, agent);

    // Persist to database
    await this.persistAgent(agent);

    console.log(`[AgentRegistry] Registered agent: ${identity.id}`);
  }

  /**
   * Unregister an agent instance
   */
  async unregister(agentId: string): Promise<boolean> {
    const existed = this.agents.has(agentId);
    this.agents.delete(agentId);

    if (existed) {
      // Update database to mark as terminated
      await db.agentStates.update(agentId, { status: 'terminated' });
      console.log(`[AgentRegistry] Unregistered agent: ${agentId}`);
    }

    return existed;
  }

  /**
   * Update agent status
   */
  async updateStatus(
    agentId: string,
    status: AgentStatus,
    currentTaskId?: string
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.status = status;
    agent.lastHeartbeat = Date.now();
    if (currentTaskId !== undefined) {
      agent.currentTaskId = currentTaskId;
    }

    await this.persistAgent(agent);
    return true;
  }

  /**
   * Record a heartbeat from an agent
   */
  recordHeartbeat(
    agentId: string,
    status?: AgentStatus,
    currentTaskId?: string
  ): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.lastHeartbeat = Date.now();
    if (status) agent.status = status;
    if (currentTaskId !== undefined) agent.currentTaskId = currentTaskId;

    return true;
  }

  /**
   * Get an agent by ID
   */
  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Check if an agent exists
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Query agents with filters
   */
  query(filter?: AgentFilter): RegisteredAgent[] {
    const results: RegisteredAgent[] = [];

    for (const agent of this.agents.values()) {
      // Skip terminated agents
      if (agent.status === 'terminated') continue;

      // Apply filters
      if (filter?.definitionId && agent.identity.definitionId !== filter.definitionId) {
        continue;
      }
      if (filter?.contextType && agent.identity.contextType !== filter.contextType) {
        continue;
      }
      if (filter?.status && agent.status !== filter.status) {
        continue;
      }
      if (filter?.hasCapability && !agent.capabilities.includes(filter.hasCapability)) {
        continue;
      }

      results.push(agent);
    }

    return results;
  }

  /**
   * Get all agents
   */
  getAll(): RegisteredAgent[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.status !== 'terminated'
    );
  }

  /**
   * Get idle agents (available for work)
   */
  getIdleAgents(): RegisteredAgent[] {
    return this.query({ status: 'idle' });
  }

  /**
   * Get busy agents (currently working)
   */
  getBusyAgents(): RegisteredAgent[] {
    return this.query({ status: 'busy' });
  }

  /**
   * Get agents by definition ID
   */
  getByDefinition(definitionId: string): RegisteredAgent[] {
    return this.query({ definitionId });
  }

  /**
   * Get agents by context type
   */
  getByContextType(contextType: ContextType): RegisteredAgent[] {
    return this.query({ contextType });
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const stats: RegistryStats = {
      total: 0,
      byStatus: {
        idle: 0,
        busy: 0,
        error: 0,
        terminated: 0,
      },
      byContextType: {
        'service-worker': 0,
        tab: 0,
        offscreen: 0,
        'content-script': 0,
        'side-panel': 0,
      },
    };

    for (const agent of this.agents.values()) {
      if (agent.status !== 'terminated') {
        stats.total++;
        stats.byStatus[agent.status]++;
        stats.byContextType[agent.identity.contextType]++;
      }
    }

    return stats;
  }

  /**
   * Check for stale agents and mark them as error
   */
  checkStaleAgents(): string[] {
    const now = Date.now();
    const staleAgentIds: string[] = [];

    for (const [agentId, agent] of this.agents) {
      if (agent.status === 'terminated') continue;

      const timeSinceHeartbeat = now - agent.lastHeartbeat;
      if (timeSinceHeartbeat > this.heartbeatTimeout) {
        agent.status = 'error';
        staleAgentIds.push(agentId);
        console.warn(
          `[AgentRegistry] Agent ${agentId} is stale (${timeSinceHeartbeat}ms since heartbeat)`
        );
      }
    }

    return staleAgentIds;
  }

  /**
   * Persist agent state to database
   */
  private async persistAgent(agent: RegisteredAgent): Promise<void> {
    try {
      const state: AgentState = {
        agentInstanceId: agent.identity.id,
        definitionId: agent.identity.definitionId,
        contextType: agent.identity.contextType,
        status: agent.status,
        tabId: agent.identity.tabId,
        windowId: agent.identity.windowId,
        lastHeartbeat: agent.lastHeartbeat,
        currentTask: undefined,
        currentTaskId: agent.currentTaskId,
        capabilities: agent.capabilities,
        spawnedAt: agent.registeredAt,
      };

      await db.agentStates.put(state);
    } catch (error) {
      console.error('[AgentRegistry] Failed to persist agent:', error);
    }
  }

  /**
   * Cleanup terminated agents from database
   */
  async cleanupTerminated(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;

    const toDelete = await db.agentStates
      .where('status')
      .equals('terminated')
      .filter((state) => state.lastHeartbeat < cutoff)
      .toArray();

    if (toDelete.length > 0) {
      await db.agentStates.bulkDelete(toDelete.map((s) => s.agentInstanceId));
    }

    return toDelete.length;
  }

  /**
   * Clear all agents (use with caution)
   */
  async clear(): Promise<void> {
    this.agents.clear();
    await db.agentStates.clear();
    console.log('[AgentRegistry] Cleared all agents');
  }

  /**
   * Destroy the registry
   */
  destroy(): void {
    this.stopCleanupInterval();
    this.agents.clear();
  }
}

// Singleton instance for coordinator
let registryInstance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}

export function destroyAgentRegistry(): void {
  if (registryInstance) {
    registryInstance.destroy();
    registryInstance = null;
  }
}
