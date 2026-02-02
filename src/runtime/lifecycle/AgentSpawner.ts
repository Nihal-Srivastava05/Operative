/**
 * AgentSpawner - Spawn agents in different browser contexts
 *
 * Supports spawning agents in:
 * - New tabs (dedicated agent page)
 * - Existing tabs (content script injection)
 * - Offscreen documents (background processing)
 */

import { AgentIdentity, ContextType, generateAgentId } from '../protocol/types';
import { getAgentRegistry } from '../registry/AgentRegistry';
import { getBroadcastManager } from '../channels/BroadcastManager';

export interface SpawnOptions {
  /** Agent definition ID to use */
  definitionId: string;
  /** Additional configuration */
  config?: Record<string, unknown>;
  /** Wait for agent to be ready (default: true) */
  waitForReady?: boolean;
  /** Timeout for ready wait in ms (default: 30000) */
  timeout?: number;
}

export interface SpawnInTabOptions extends SpawnOptions {
  /** Open tab in active state */
  active?: boolean;
  /** Specific window to open in */
  windowId?: number;
  /** URL to load (default: agent.html) */
  url?: string;
}

export interface SpawnInExistingTabOptions extends SpawnOptions {
  /** Tab ID to inject into */
  tabId: number;
}

export interface SpawnInOffscreenOptions extends SpawnOptions {
  /** Reason for offscreen document */
  reason?: string;
}

export interface SpawnResult {
  success: boolean;
  agentId?: string;
  identity?: AgentIdentity;
  error?: string;
}

/**
 * AgentSpawner handles creating agent instances in various browser contexts
 */
export class AgentSpawner {
  private pendingSpawns: Map<string, {
    resolve: (result: SpawnResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor() {
    this.setupReadyListener();
  }

  /**
   * Listen for agent ready messages
   */
  private setupReadyListener(): void {
    const broadcastManager = getBroadcastManager();

    broadcastManager.subscribeSystem(
      (message) => {
        if (message.type !== 'lifecycle:ready') return;

        const agentId = message.source.id;
        const pending = this.pendingSpawns.get(agentId);

        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingSpawns.delete(agentId);

          pending.resolve({
            success: true,
            agentId,
            identity: message.source,
          });
        }
      },
      { type: 'lifecycle:ready' }
    );
  }

  /**
   * Spawn an agent in a new tab
   */
  async spawnInTab(options: SpawnInTabOptions): Promise<SpawnResult> {
    const agentId = generateAgentId();
    const { definitionId, config, active = false, windowId, waitForReady = true, timeout = 30000 } = options;

    try {
      // Build the agent page URL with parameters
      const baseUrl = options.url || chrome.runtime.getURL('agent.html');
      const params = new URLSearchParams({
        agentId,
        definitionId,
        ...(config ? { config: JSON.stringify(config) } : {}),
      });

      const url = `${baseUrl}?${params.toString()}`;

      // Create the tab
      const createOptions: chrome.tabs.CreateProperties = {
        url,
        active,
      };

      if (windowId !== undefined) {
        createOptions.windowId = windowId;
      }

      const tab = await chrome.tabs.create(createOptions);

      const identity: AgentIdentity = {
        id: agentId,
        definitionId,
        contextType: 'tab',
        tabId: tab.id,
        windowId: tab.windowId,
      };

      console.log(`[AgentSpawner] Created tab ${tab.id} for agent ${agentId}`);

      if (!waitForReady) {
        return { success: true, agentId, identity };
      }

      // Wait for agent to report ready
      return this.waitForReady(agentId, identity, timeout);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to spawn tab agent',
      };
    }
  }

  /**
   * Spawn an agent by injecting content script into existing tab
   */
  async spawnInExistingTab(options: SpawnInExistingTabOptions): Promise<SpawnResult> {
    const agentId = generateAgentId();
    const { definitionId, tabId, config, waitForReady = true, timeout = 30000 } = options;

    try {
      // Verify tab exists
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        return { success: false, error: `Tab ${tabId} not found` };
      }

      // Inject the content script
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/agent-bootstrap.js'],
      });

      // Send initialization message to the content script
      await chrome.tabs.sendMessage(tabId, {
        type: 'agent:init',
        agentId,
        definitionId,
        config,
      });

      const identity: AgentIdentity = {
        id: agentId,
        definitionId,
        contextType: 'content-script',
        tabId,
        windowId: tab.windowId,
      };

      console.log(`[AgentSpawner] Injected agent ${agentId} into tab ${tabId}`);

      if (!waitForReady) {
        return { success: true, agentId, identity };
      }

      return this.waitForReady(agentId, identity, timeout);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to inject content script',
      };
    }
  }

  /**
   * Spawn an agent in an offscreen document
   */
  async spawnInOffscreen(options: SpawnInOffscreenOptions): Promise<SpawnResult> {
    const agentId = generateAgentId();
    const { definitionId, config, reason = 'Running background AI agent', waitForReady = true, timeout = 30000 } = options;

    try {
      // Check if offscreen document already exists
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });

      // Build URL with parameters
      const params = new URLSearchParams({
        agentId,
        definitionId,
        ...(config ? { config: JSON.stringify(config) } : {}),
      });

      const url = `offscreen.html?${params.toString()}`;

      if (existingContexts.length === 0) {
        // Create new offscreen document
        await chrome.offscreen.createDocument({
          url,
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: reason,
        });
      } else {
        // Send message to existing offscreen document to spawn new agent
        chrome.runtime.sendMessage({
          type: 'agent:spawn',
          agentId,
          definitionId,
          config,
        });
      }

      const identity: AgentIdentity = {
        id: agentId,
        definitionId,
        contextType: 'offscreen',
      };

      console.log(`[AgentSpawner] Created offscreen agent ${agentId}`);

      if (!waitForReady) {
        return { success: true, agentId, identity };
      }

      return this.waitForReady(agentId, identity, timeout);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create offscreen document',
      };
    }
  }

  /**
   * Wait for an agent to report ready
   */
  private waitForReady(
    agentId: string,
    identity: AgentIdentity,
    timeout: number
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingSpawns.delete(agentId);
        resolve({
          success: false,
          agentId,
          identity,
          error: `Agent ${agentId} did not become ready within ${timeout}ms`,
        });
      }, timeout);

      this.pendingSpawns.set(agentId, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });
    });
  }

  /**
   * Terminate an agent gracefully
   */
  async terminate(agentId: string, graceful: boolean = true): Promise<boolean> {
    const registry = getAgentRegistry();
    const agent = registry.get(agentId);

    if (!agent) {
      console.warn(`[AgentSpawner] Agent ${agentId} not found for termination`);
      return false;
    }

    // Send termination message
    const broadcastManager = getBroadcastManager();
    broadcastManager.publishSystem(
      'lifecycle:terminate',
      { type: 'agent', agentId },
      { reason: 'requested', graceful }
    );

    // Context-specific cleanup
    switch (agent.identity.contextType) {
      case 'tab':
        if (agent.identity.tabId && !graceful) {
          // Force close the tab
          try {
            await chrome.tabs.remove(agent.identity.tabId);
          } catch (error) {
            console.warn(`[AgentSpawner] Failed to close tab ${agent.identity.tabId}:`, error);
          }
        }
        break;

      case 'content-script':
        // Content scripts will receive the termination message via broadcast
        break;

      case 'offscreen':
        // Check if this is the only agent in offscreen, if so close it
        const offscreenAgents = registry.getByContextType('offscreen');
        if (offscreenAgents.length <= 1) {
          try {
            await chrome.offscreen.closeDocument();
          } catch (error) {
            console.warn('[AgentSpawner] Failed to close offscreen document:', error);
          }
        }
        break;
    }

    // Update registry
    await registry.unregister(agentId);

    console.log(`[AgentSpawner] Terminated agent ${agentId}`);
    return true;
  }

  /**
   * Terminate all agents of a specific definition
   */
  async terminateByDefinition(definitionId: string, graceful: boolean = true): Promise<number> {
    const registry = getAgentRegistry();
    const agents = registry.getByDefinition(definitionId);

    let count = 0;
    for (const agent of agents) {
      if (await this.terminate(agent.identity.id, graceful)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Terminate all agents
   */
  async terminateAll(graceful: boolean = true): Promise<number> {
    const registry = getAgentRegistry();
    const agents = registry.getAll();

    let count = 0;
    for (const agent of agents) {
      if (await this.terminate(agent.identity.id, graceful)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Cleanup pending spawns
   */
  destroy(): void {
    for (const [agentId, pending] of this.pendingSpawns) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Spawner destroyed'));
    }
    this.pendingSpawns.clear();
  }
}

// Singleton instance
let spawnerInstance: AgentSpawner | null = null;

export function getAgentSpawner(): AgentSpawner {
  if (!spawnerInstance) {
    spawnerInstance = new AgentSpawner();
  }
  return spawnerInstance;
}

export function destroyAgentSpawner(): void {
  if (spawnerInstance) {
    spawnerInstance.destroy();
    spawnerInstance = null;
  }
}
