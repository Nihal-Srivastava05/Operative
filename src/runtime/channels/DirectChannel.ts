/**
 * DirectChannel - Point-to-point communication with guaranteed delivery
 * Uses MessageChannel API for direct communication between two agents
 */

import {
  AgentMessage,
  AgentIdentity,
  MessageType,
  MessagePayloadMap,
  createMessage,
  generateMessageId,
} from '../protocol/types';

type MessageHandler<T = unknown> = (message: AgentMessage<T>) => void | Promise<void>;

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  timestamp: number;
}

/**
 * DirectChannel provides point-to-point communication with request/response patterns
 */
export class DirectChannel {
  private port: MessagePort | null = null;
  private localIdentity: AgentIdentity;
  private remoteIdentity: AgentIdentity | null = null;
  private handlers: Map<MessageType, MessageHandler[]> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private defaultTimeout = 30000; // 30 seconds
  private connected = false;

  constructor(localIdentity: AgentIdentity) {
    this.localIdentity = localIdentity;
  }

  /**
   * Initialize with an existing MessagePort (receiver side)
   */
  initWithPort(port: MessagePort, remoteIdentity?: AgentIdentity): void {
    this.port = port;
    this.remoteIdentity = remoteIdentity || null;
    this.setupPort();
    this.connected = true;
  }

  /**
   * Create a new MessageChannel and return the remote port (initiator side)
   */
  createChannel(): MessagePort {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.setupPort();
    this.connected = true;
    return channel.port2;
  }

  /**
   * Setup message handling on the port
   */
  private setupPort(): void {
    if (!this.port) return;

    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.port.onmessageerror = (event) => {
      console.error('[DirectChannel] Message error:', event);
    };

    // Start receiving messages
    this.port.start();
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(data: unknown): void {
    if (!this.isValidMessage(data)) {
      console.warn('[DirectChannel] Received invalid message:', data);
      return;
    }

    const message = data as AgentMessage;

    // Update remote identity if not set
    if (!this.remoteIdentity) {
      this.remoteIdentity = message.source;
    }

    // Check if this is a response to a pending request
    if (message.correlationId && this.pendingRequests.has(message.correlationId)) {
      const pending = this.pendingRequests.get(message.correlationId)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.correlationId);
      pending.resolve(message);
      return;
    }

    // Dispatch to registered handlers
    const handlers = this.handlers.get(message.type) || [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[DirectChannel] Handler error:', error);
      }
    }

    // Also call wildcard handlers
    const wildcardHandlers = this.handlers.get('*' as MessageType) || [];
    for (const handler of wildcardHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[DirectChannel] Wildcard handler error:', error);
      }
    }
  }

  /**
   * Validate message structure
   */
  private isValidMessage(data: unknown): data is AgentMessage {
    if (!data || typeof data !== 'object') return false;
    const msg = data as Record<string, unknown>;
    return (
      typeof msg.id === 'string' &&
      typeof msg.type === 'string' &&
      typeof msg.source === 'object' &&
      typeof msg.timestamp === 'number'
    );
  }

  /**
   * Send a message and wait for a response
   */
  async request<T extends MessageType, R = unknown>(
    type: T,
    payload: MessagePayloadMap[T],
    options?: { timeout?: number }
  ): Promise<AgentMessage<R>> {
    if (!this.connected || !this.port) {
      throw new Error('[DirectChannel] Not connected');
    }

    const correlationId = generateMessageId();
    const timeout = options?.timeout || this.defaultTimeout;

    const message = createMessage(
      type,
      this.localIdentity,
      { type: 'agent', agentId: this.remoteIdentity?.id || 'unknown' },
      payload,
      correlationId
    );

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`[DirectChannel] Request timeout after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutHandle,
        timestamp: Date.now(),
      });

      this.port!.postMessage(message);
    });
  }

  /**
   * Send a message without waiting for response (fire and forget)
   */
  send<T extends MessageType>(type: T, payload: MessagePayloadMap[T]): void {
    if (!this.connected || !this.port) {
      throw new Error('[DirectChannel] Not connected');
    }

    const message = createMessage(
      type,
      this.localIdentity,
      { type: 'agent', agentId: this.remoteIdentity?.id || 'unknown' },
      payload
    );

    this.port.postMessage(message);
  }

  /**
   * Send a response to a specific request
   */
  respond<T extends MessageType>(
    originalMessage: AgentMessage,
    type: T,
    payload: MessagePayloadMap[T]
  ): void {
    if (!this.connected || !this.port) {
      throw new Error('[DirectChannel] Not connected');
    }

    const message = createMessage(
      type,
      this.localIdentity,
      { type: 'agent', agentId: originalMessage.source.id },
      payload,
      originalMessage.id // Use original message ID as correlation
    );

    this.port.postMessage(message);
  }

  /**
   * Register a handler for a specific message type
   */
  onMessage<T = unknown>(
    type: MessageType | '*',
    handler: MessageHandler<T>
  ): () => void {
    const handlers = this.handlers.get(type as MessageType) || [];
    handlers.push(handler as MessageHandler);
    this.handlers.set(type as MessageType, handlers);

    return () => {
      const currentHandlers = this.handlers.get(type as MessageType) || [];
      const index = currentHandlers.indexOf(handler as MessageHandler);
      if (index !== -1) {
        currentHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Register a one-time handler
   */
  once<T = unknown>(
    type: MessageType,
    handler: MessageHandler<T>
  ): () => void {
    const unsubscribe = this.onMessage(type, (message) => {
      unsubscribe();
      handler(message as AgentMessage<T>);
    });
    return unsubscribe;
  }

  /**
   * Check if channel is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get remote agent identity
   */
  getRemoteIdentity(): AgentIdentity | null {
    return this.remoteIdentity;
  }

  /**
   * Get number of pending requests
   */
  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Close the channel and cleanup
   */
  close(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('[DirectChannel] Channel closed'));
    }
    this.pendingRequests.clear();

    // Close the port
    if (this.port) {
      this.port.close();
      this.port = null;
    }

    this.handlers.clear();
    this.connected = false;
    this.remoteIdentity = null;
  }
}

/**
 * DirectChannelManager - Manages multiple direct channels
 */
export class DirectChannelManager {
  private channels: Map<string, DirectChannel> = new Map();
  private localIdentity: AgentIdentity;

  constructor(localIdentity: AgentIdentity) {
    this.localIdentity = localIdentity;
  }

  /**
   * Create a new channel to a remote agent
   */
  createChannel(remoteAgentId: string): { channel: DirectChannel; port: MessagePort } {
    const channel = new DirectChannel(this.localIdentity);
    const remotePort = channel.createChannel();
    this.channels.set(remoteAgentId, channel);
    return { channel, port: remotePort };
  }

  /**
   * Accept a channel from a remote agent
   */
  acceptChannel(
    remoteAgentId: string,
    port: MessagePort,
    remoteIdentity?: AgentIdentity
  ): DirectChannel {
    const channel = new DirectChannel(this.localIdentity);
    channel.initWithPort(port, remoteIdentity);
    this.channels.set(remoteAgentId, channel);
    return channel;
  }

  /**
   * Get an existing channel
   */
  getChannel(remoteAgentId: string): DirectChannel | undefined {
    return this.channels.get(remoteAgentId);
  }

  /**
   * Check if a channel exists
   */
  hasChannel(remoteAgentId: string): boolean {
    return this.channels.has(remoteAgentId);
  }

  /**
   * Close a specific channel
   */
  closeChannel(remoteAgentId: string): void {
    const channel = this.channels.get(remoteAgentId);
    if (channel) {
      channel.close();
      this.channels.delete(remoteAgentId);
    }
  }

  /**
   * Close all channels
   */
  closeAll(): void {
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
  }

  /**
   * Get all connected agent IDs
   */
  getConnectedAgentIds(): string[] {
    return Array.from(this.channels.keys()).filter(
      (id) => this.channels.get(id)?.isConnected()
    );
  }
}
