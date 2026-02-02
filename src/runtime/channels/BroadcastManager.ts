/**
 * BroadcastManager - Pub/sub system for cross-context communication
 * Uses BroadcastChannel API for communication between tabs, workers, and frames
 */

import {
  AgentMessage,
  AgentIdentity,
  MessageType,
  MessageTarget,
  MessagePayloadMap,
  CHANNELS,
  ChannelName,
  createMessage,
  isMessageExpired,
  generateMessageId,
} from '../protocol/types';

type MessageHandler<T = unknown> = (message: AgentMessage<T>) => void | Promise<void>;
type UnsubscribeFn = () => void;

interface Subscription {
  id: string;
  channel: ChannelName;
  handler: MessageHandler;
  filter?: {
    type?: MessageType | MessageType[];
    sourceId?: string;
  };
}

/**
 * Manages BroadcastChannel communication for inter-agent messaging
 */
export class BroadcastManager {
  private channels: Map<ChannelName, BroadcastChannel> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private identity: AgentIdentity | null = null;
  private messageLog: AgentMessage[] = [];
  private maxLogSize = 100;

  constructor() {
    // Channels are initialized lazily on first subscribe/publish
  }

  /**
   * Set the identity of this agent (required before publishing)
   */
  setIdentity(identity: AgentIdentity): void {
    this.identity = identity;
  }

  /**
   * Get or create a BroadcastChannel for the given channel name
   */
  private getChannel(name: ChannelName): BroadcastChannel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = new BroadcastChannel(name);
      channel.onmessage = (event) => this.handleMessage(name, event.data);
      channel.onmessageerror = (event) => {
        console.error(`[BroadcastManager] Message error on ${name}:`, event);
      };
      this.channels.set(name, channel);
    }
    return channel;
  }

  /**
   * Handle incoming messages and dispatch to subscribers
   */
  private handleMessage(channelName: ChannelName, data: unknown): void {
    // Validate message structure
    if (!this.isValidMessage(data)) {
      console.warn('[BroadcastManager] Received invalid message:', data);
      return;
    }

    const message = data as AgentMessage;

    // Check if message has expired
    if (isMessageExpired(message)) {
      console.debug('[BroadcastManager] Dropping expired message:', message.id);
      return;
    }

    // Don't process our own messages (except for specific cases)
    if (this.identity && message.source.id === this.identity.id) {
      return;
    }

    // Check if message is targeted at us
    if (!this.isMessageForUs(message)) {
      return;
    }

    // Log message for debugging
    this.logMessage(message);

    // Dispatch to matching subscribers
    for (const subscription of this.subscriptions.values()) {
      if (subscription.channel !== channelName) continue;
      if (!this.matchesFilter(message, subscription.filter)) continue;

      try {
        subscription.handler(message);
      } catch (error) {
        console.error('[BroadcastManager] Handler error:', error);
      }
    }
  }

  /**
   * Validate that data is a valid AgentMessage
   */
  private isValidMessage(data: unknown): data is AgentMessage {
    if (!data || typeof data !== 'object') return false;
    const msg = data as Record<string, unknown>;
    return (
      typeof msg.id === 'string' &&
      typeof msg.type === 'string' &&
      typeof msg.source === 'object' &&
      typeof msg.target === 'object' &&
      typeof msg.timestamp === 'number'
    );
  }

  /**
   * Check if message is intended for this agent
   */
  private isMessageForUs(message: AgentMessage): boolean {
    const target = message.target;

    if (target.type === 'broadcast') return true;

    if (target.type === 'coordinator' && this.identity?.contextType === 'service-worker') {
      return true;
    }

    if (target.type === 'agent' && this.identity) {
      return target.agentId === this.identity.id;
    }

    if (target.type === 'definition' && this.identity) {
      return target.definitionId === this.identity.definitionId;
    }

    return false;
  }

  /**
   * Check if message matches subscription filter
   */
  private matchesFilter(
    message: AgentMessage,
    filter?: Subscription['filter']
  ): boolean {
    if (!filter) return true;

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.includes(message.type)) return false;
    }

    if (filter.sourceId && message.source.id !== filter.sourceId) {
      return false;
    }

    return true;
  }

  /**
   * Log message for debugging (maintains fixed size buffer)
   */
  private logMessage(message: AgentMessage): void {
    this.messageLog.push(message);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog.shift();
    }
  }

  /**
   * Subscribe to messages on a channel
   */
  subscribe<T = unknown>(
    channel: ChannelName,
    handler: MessageHandler<T>,
    filter?: Subscription['filter']
  ): UnsubscribeFn {
    const id = generateMessageId();
    const subscription: Subscription = {
      id,
      channel,
      handler: handler as MessageHandler,
      filter,
    };

    this.subscriptions.set(id, subscription);

    // Ensure channel is opened
    this.getChannel(channel);

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * Publish a typed message to a channel
   */
  publish<T extends MessageType>(
    channel: ChannelName,
    type: T,
    target: MessageTarget,
    payload: MessagePayloadMap[T],
    options?: { correlationId?: string; ttl?: number }
  ): AgentMessage<MessagePayloadMap[T]> {
    if (!this.identity) {
      throw new Error('[BroadcastManager] Identity not set. Call setIdentity() first.');
    }

    const message = createMessage(type, this.identity, target, payload, options?.correlationId);
    if (options?.ttl) {
      message.ttl = options.ttl;
    }

    const broadcastChannel = this.getChannel(channel);
    broadcastChannel.postMessage(message);

    // Log our own messages too
    this.logMessage(message);

    return message;
  }

  /**
   * Publish to the system channel
   */
  publishSystem<T extends MessageType>(
    type: T,
    target: MessageTarget,
    payload: MessagePayloadMap[T],
    options?: { correlationId?: string; ttl?: number }
  ): AgentMessage<MessagePayloadMap[T]> {
    return this.publish(CHANNELS.SYSTEM, type, target, payload, options);
  }

  /**
   * Publish to the tasks channel
   */
  publishTask<T extends MessageType>(
    type: T,
    target: MessageTarget,
    payload: MessagePayloadMap[T],
    options?: { correlationId?: string; ttl?: number }
  ): AgentMessage<MessagePayloadMap[T]> {
    return this.publish(CHANNELS.TASKS, type, target, payload, options);
  }

  /**
   * Publish to the memory channel
   */
  publishMemory<T extends MessageType>(
    type: T,
    target: MessageTarget,
    payload: MessagePayloadMap[T],
    options?: { correlationId?: string; ttl?: number }
  ): AgentMessage<MessagePayloadMap[T]> {
    return this.publish(CHANNELS.MEMORY, type, target, payload, options);
  }

  /**
   * Subscribe to system channel
   */
  subscribeSystem<T = unknown>(
    handler: MessageHandler<T>,
    filter?: Subscription['filter']
  ): UnsubscribeFn {
    return this.subscribe(CHANNELS.SYSTEM, handler, filter);
  }

  /**
   * Subscribe to tasks channel
   */
  subscribeTasks<T = unknown>(
    handler: MessageHandler<T>,
    filter?: Subscription['filter']
  ): UnsubscribeFn {
    return this.subscribe(CHANNELS.TASKS, handler, filter);
  }

  /**
   * Subscribe to memory channel
   */
  subscribeMemory<T = unknown>(
    handler: MessageHandler<T>,
    filter?: Subscription['filter']
  ): UnsubscribeFn {
    return this.subscribe(CHANNELS.MEMORY, handler, filter);
  }

  /**
   * Create a private channel for direct communication
   */
  createPrivateChannel(name: string): BroadcastChannel {
    const channelName = `operative:private:${name}` as ChannelName;
    return this.getChannel(channelName);
  }

  /**
   * Get recent message log for debugging
   */
  getMessageLog(): AgentMessage[] {
    return [...this.messageLog];
  }

  /**
   * Clear all subscriptions and close channels
   */
  destroy(): void {
    this.subscriptions.clear();
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
    this.messageLog = [];
    this.identity = null;
  }
}

// Singleton instance for convenience
let defaultInstance: BroadcastManager | null = null;

export function getBroadcastManager(): BroadcastManager {
  if (!defaultInstance) {
    defaultInstance = new BroadcastManager();
  }
  return defaultInstance;
}

export function destroyBroadcastManager(): void {
  if (defaultInstance) {
    defaultInstance.destroy();
    defaultInstance = null;
  }
}
