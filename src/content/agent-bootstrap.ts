/**
 * Agent Bootstrap - Content script for tab-based agents
 *
 * This script is injected into tabs to enable agent functionality.
 * It bridges the content script context to BroadcastChannel via chrome.runtime.
 *
 * Content scripts cannot directly use BroadcastChannel to communicate with
 * service workers, so this script uses chrome.runtime messaging as a bridge.
 */

import {
  AgentIdentity,
  AgentMessage,
  CHANNELS,
  generateAgentId,
  createMessage,
  MessageType,
  MessageTarget,
  MessagePayloadMap,
} from '../runtime/protocol/types';
import { LocalMemory, createLocalMemory } from '../runtime/memory/LocalMemory';

interface AgentInitMessage {
  type: 'agent:init';
  agentId: string;
  definitionId: string;
  config?: Record<string, unknown>;
}

interface RuntimeMessage {
  channel: string;
  message: AgentMessage;
}

/**
 * ContentScriptAgent - Simplified agent context for content scripts
 */
class ContentScriptAgent {
  private identity: AgentIdentity | null = null;
  private localMemory: LocalMemory | null = null;
  private status: 'idle' | 'busy' | 'error' | 'terminated' = 'idle';
  private currentTaskId: string | null = null;
  private messageHandlers: Map<MessageType, Array<(message: AgentMessage) => void>> = new Map();
  private port: chrome.runtime.Port | null = null;

  constructor() {
    this.setupMessageListener();
  }

  /**
   * Setup listener for initialization messages from the service worker
   */
  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'agent:init') {
        this.initialize(message as AgentInitMessage);
        sendResponse({ success: true });
      } else if (message.type === 'agent:message') {
        // Forward incoming agent messages
        this.handleIncomingMessage(message.payload);
        sendResponse({ success: true });
      }
      return false;
    });
  }

  /**
   * Initialize the content script agent
   */
  private async initialize(initMessage: AgentInitMessage): Promise<void> {
    const { agentId, definitionId, config } = initMessage;

    // Create identity
    this.identity = {
      id: agentId,
      definitionId,
      contextType: 'content-script',
      tabId: undefined, // Will be filled by coordinator
    };

    // Initialize local memory
    this.localMemory = createLocalMemory();

    // Connect to service worker via port for persistent connection
    this.setupPort();

    // Register with coordinator
    this.sendToBackground('registry:register', { type: 'coordinator' }, {
      identity: this.identity,
      capabilities: ['dom-access', 'page-interaction'],
      status: 'idle',
    });

    // Notify ready
    this.sendToBackground('lifecycle:ready', { type: 'coordinator' }, {
      capabilities: ['dom-access', 'page-interaction'],
    });

    console.log(`[ContentScriptAgent] Initialized agent ${agentId} in content script`);
  }

  /**
   * Setup persistent port connection to service worker
   */
  private setupPort(): void {
    this.port = chrome.runtime.connect({ name: `agent:${this.identity?.id}` });

    this.port.onMessage.addListener((message) => {
      if (message.type === 'agent:message') {
        this.handleIncomingMessage(message.payload);
      }
    });

    this.port.onDisconnect.addListener(() => {
      console.log('[ContentScriptAgent] Port disconnected');
      this.port = null;
      // Attempt to reconnect
      setTimeout(() => {
        if (this.status !== 'terminated') {
          this.setupPort();
        }
      }, 1000);
    });
  }

  /**
   * Send a message to the background service worker
   */
  private sendToBackground<T extends MessageType>(
    type: T,
    target: MessageTarget,
    payload: MessagePayloadMap[T],
    correlationId?: string
  ): void {
    if (!this.identity) {
      console.error('[ContentScriptAgent] Cannot send message: not initialized');
      return;
    }

    const message = createMessage(type, this.identity, target, payload, correlationId);

    // Use port if available, fall back to sendMessage
    if (this.port) {
      this.port.postMessage({ type: 'agent:message', channel: CHANNELS.SYSTEM, message });
    } else {
      chrome.runtime.sendMessage({
        type: 'agent:message',
        channel: CHANNELS.SYSTEM,
        message,
      });
    }
  }

  /**
   * Handle incoming messages from background
   */
  private handleIncomingMessage(message: AgentMessage): void {
    // Check if message is for us
    if (!this.isMessageForUs(message)) return;

    switch (message.type) {
      case 'task:delegate':
        this.handleTaskDelegate(message);
        break;

      case 'heartbeat:ping':
        this.handleHeartbeatPing(message);
        break;

      case 'lifecycle:terminate':
        this.handleTerminate();
        break;

      default:
        // Dispatch to registered handlers
        const handlers = this.messageHandlers.get(message.type) || [];
        for (const handler of handlers) {
          try {
            handler(message);
          } catch (error) {
            console.error('[ContentScriptAgent] Handler error:', error);
          }
        }
    }
  }

  /**
   * Check if message is intended for this agent
   */
  private isMessageForUs(message: AgentMessage): boolean {
    const target = message.target;

    if (target.type === 'broadcast') return true;
    if (target.type === 'agent' && target.agentId === this.identity?.id) return true;
    if (target.type === 'definition' && target.definitionId === this.identity?.definitionId) return true;

    return false;
  }

  /**
   * Handle task delegation
   */
  private async handleTaskDelegate(message: AgentMessage): Promise<void> {
    const payload = message.payload as {
      taskId: string;
      task: string;
      priority: string;
      context?: Record<string, unknown>;
    };

    if (this.status !== 'idle') {
      this.sendToBackground(
        'task:reject',
        { type: 'agent', agentId: message.source.id },
        { taskId: payload.taskId, reason: `Agent is ${this.status}` },
        message.id
      );
      return;
    }

    this.status = 'busy';
    this.currentTaskId = payload.taskId;

    // Accept the task
    this.sendToBackground(
      'task:accept',
      { type: 'agent', agentId: message.source.id },
      { taskId: payload.taskId },
      message.id
    );

    try {
      // Execute task - content scripts can interact with the DOM
      const result = await this.executeTask(payload.task, payload.context);

      this.sendToBackground(
        'task:result',
        { type: 'agent', agentId: message.source.id },
        { taskId: payload.taskId, result },
        message.id
      );
    } catch (error) {
      this.sendToBackground(
        'task:error',
        { type: 'agent', agentId: message.source.id },
        {
          taskId: payload.taskId,
          error: error instanceof Error ? error.message : 'Unknown error',
          recoverable: false,
        },
        message.id
      );
    } finally {
      this.status = 'idle';
      this.currentTaskId = null;
    }
  }

  /**
   * Execute a task (can be extended for specific DOM operations)
   */
  private async executeTask(
    task: string,
    context?: Record<string, unknown>
  ): Promise<unknown> {
    // Default implementation - return page information
    return {
      task,
      pageTitle: document.title,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    };
  }

  /**
   * Handle heartbeat ping
   */
  private handleHeartbeatPing(message: AgentMessage): void {
    this.sendToBackground(
      'heartbeat:pong',
      { type: 'coordinator' },
      {
        timestamp: Date.now(),
        originalTimestamp: (message.payload as { timestamp: number }).timestamp,
        status: this.status,
        currentTaskId: this.currentTaskId || undefined,
      },
      message.id
    );
  }

  /**
   * Handle termination request
   */
  private handleTerminate(): void {
    console.log('[ContentScriptAgent] Received termination request');

    this.status = 'terminated';

    // Notify coordinator
    this.sendToBackground('lifecycle:terminated', { type: 'coordinator' }, {});
    this.sendToBackground('registry:unregister', { type: 'coordinator' }, {});

    // Disconnect port
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }

    // Clear local memory
    this.localMemory = null;
    this.identity = null;
  }

  /**
   * Register a message handler
   */
  onMessage(type: MessageType, handler: (message: AgentMessage) => void): () => void {
    const handlers = this.messageHandlers.get(type) || [];
    handlers.push(handler);
    this.messageHandlers.set(type, handlers);

    return () => {
      const currentHandlers = this.messageHandlers.get(type) || [];
      const index = currentHandlers.indexOf(handler);
      if (index !== -1) {
        currentHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Get local memory instance
   */
  getLocalMemory(): LocalMemory | null {
    return this.localMemory;
  }

  /**
   * Get current status
   */
  getStatus(): string {
    return this.status;
  }

  /**
   * Get identity
   */
  getIdentity(): AgentIdentity | null {
    return this.identity;
  }
}

// Create and export singleton instance
const contentScriptAgent = new ContentScriptAgent();

// Expose to window for debugging
(window as any).__operativeAgent = contentScriptAgent;

console.log('[ContentScriptAgent] Bootstrap loaded');

export { contentScriptAgent };
