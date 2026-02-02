/**
 * LocalMemory - Per-agent ephemeral working memory
 *
 * Provides fast in-memory storage for agent-specific data:
 * - Conversation history
 * - Working state
 * - Scratchpad data
 *
 * Can be serialized/deserialized for state persistence on termination.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface LocalMemorySnapshot {
  version: number;
  data: Record<string, unknown>;
  conversationHistory: ConversationMessage[];
  scratchpad: Record<string, unknown>;
  timestamp: number;
}

/**
 * LocalMemory provides fast ephemeral storage for agent working state
 */
export class LocalMemory {
  private data: Map<string, unknown> = new Map();
  private conversationHistory: ConversationMessage[] = [];
  private scratchpad: Map<string, unknown> = new Map();
  private maxHistoryLength: number;
  private version: number = 0;

  constructor(options?: { maxHistoryLength?: number }) {
    this.maxHistoryLength = options?.maxHistoryLength ?? 100;
  }

  // ============================================================================
  // Key-Value Storage
  // ============================================================================

  /**
   * Get a value from local memory
   */
  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  /**
   * Set a value in local memory
   */
  set<T = unknown>(key: string, value: T): void {
    this.data.set(key, value);
    this.version++;
  }

  /**
   * Delete a value from local memory
   */
  delete(key: string): boolean {
    const existed = this.data.has(key);
    this.data.delete(key);
    if (existed) this.version++;
    return existed;
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.data.keys());
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.data.clear();
    this.version++;
  }

  /**
   * Get number of stored items
   */
  get size(): number {
    return this.data.size;
  }

  // ============================================================================
  // Conversation History
  // ============================================================================

  /**
   * Add a message to conversation history
   */
  addMessage(
    role: ConversationMessage['role'],
    content: string,
    metadata?: Record<string, unknown>
  ): void {
    const message: ConversationMessage = {
      role,
      content,
      timestamp: Date.now(),
      metadata,
    };

    this.conversationHistory.push(message);

    // Trim to max length
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }

    this.version++;
  }

  /**
   * Add a user message
   */
  addUserMessage(content: string, metadata?: Record<string, unknown>): void {
    this.addMessage('user', content, metadata);
  }

  /**
   * Add an assistant message
   */
  addAssistantMessage(content: string, metadata?: Record<string, unknown>): void {
    this.addMessage('assistant', content, metadata);
  }

  /**
   * Add a system message
   */
  addSystemMessage(content: string, metadata?: Record<string, unknown>): void {
    this.addMessage('system', content, metadata);
  }

  /**
   * Add a tool call/result message
   */
  addToolMessage(content: string, metadata?: Record<string, unknown>): void {
    this.addMessage('tool', content, metadata);
  }

  /**
   * Get full conversation history
   */
  getHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Get recent messages
   */
  getRecentHistory(count: number): ConversationMessage[] {
    return this.conversationHistory.slice(-count);
  }

  /**
   * Get history formatted for AI prompt
   */
  getHistoryForPrompt(count?: number): string {
    const messages = count
      ? this.getRecentHistory(count)
      : this.conversationHistory;

    return messages
      .map((msg) => {
        const roleLabel =
          msg.role === 'assistant' ? 'Assistant' :
          msg.role === 'user' ? 'User' :
          msg.role === 'system' ? 'System' :
          'Tool';
        return `${roleLabel}: ${msg.content}`;
      })
      .join('\n\n');
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
    this.version++;
  }

  /**
   * Get history length
   */
  get historyLength(): number {
    return this.conversationHistory.length;
  }

  // ============================================================================
  // Scratchpad (temporary working space)
  // ============================================================================

  /**
   * Get a scratchpad value
   */
  getScratch<T = unknown>(key: string): T | undefined {
    return this.scratchpad.get(key) as T | undefined;
  }

  /**
   * Set a scratchpad value
   */
  setScratch<T = unknown>(key: string, value: T): void {
    this.scratchpad.set(key, value);
    this.version++;
  }

  /**
   * Delete a scratchpad value
   */
  deleteScratch(key: string): boolean {
    const existed = this.scratchpad.has(key);
    this.scratchpad.delete(key);
    if (existed) this.version++;
    return existed;
  }

  /**
   * Clear all scratchpad data
   */
  clearScratch(): void {
    this.scratchpad.clear();
    this.version++;
  }

  /**
   * Get all scratchpad keys
   */
  getScratchKeys(): string[] {
    return Array.from(this.scratchpad.keys());
  }

  // ============================================================================
  // Serialization
  // ============================================================================

  /**
   * Serialize the entire local memory to a snapshot
   */
  serialize(): LocalMemorySnapshot {
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.data) {
      data[key] = value;
    }

    const scratchpad: Record<string, unknown> = {};
    for (const [key, value] of this.scratchpad) {
      scratchpad[key] = value;
    }

    return {
      version: this.version,
      data,
      conversationHistory: [...this.conversationHistory],
      scratchpad,
      timestamp: Date.now(),
    };
  }

  /**
   * Serialize to JSON string
   */
  toJSON(): string {
    return JSON.stringify(this.serialize());
  }

  /**
   * Deserialize from a snapshot
   */
  deserialize(snapshot: LocalMemorySnapshot): void {
    this.data.clear();
    for (const [key, value] of Object.entries(snapshot.data)) {
      this.data.set(key, value);
    }

    this.conversationHistory = [...snapshot.conversationHistory];

    this.scratchpad.clear();
    for (const [key, value] of Object.entries(snapshot.scratchpad)) {
      this.scratchpad.set(key, value);
    }

    this.version = snapshot.version;
  }

  /**
   * Deserialize from JSON string
   */
  static fromJSON(json: string): LocalMemory {
    const snapshot = JSON.parse(json) as LocalMemorySnapshot;
    const memory = new LocalMemory();
    memory.deserialize(snapshot);
    return memory;
  }

  /**
   * Create a new LocalMemory from a snapshot
   */
  static fromSnapshot(snapshot: LocalMemorySnapshot): LocalMemory {
    const memory = new LocalMemory();
    memory.deserialize(snapshot);
    return memory;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Get current version (increments on any change)
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get total memory size estimate (rough)
   */
  getMemorySizeEstimate(): number {
    let size = 0;

    // Data size
    for (const [key, value] of this.data) {
      size += key.length * 2; // UTF-16
      size += JSON.stringify(value).length * 2;
    }

    // History size
    for (const msg of this.conversationHistory) {
      size += msg.content.length * 2;
      size += JSON.stringify(msg.metadata || {}).length * 2;
    }

    // Scratchpad size
    for (const [key, value] of this.scratchpad) {
      size += key.length * 2;
      size += JSON.stringify(value).length * 2;
    }

    return size;
  }

  /**
   * Reset all memory
   */
  reset(): void {
    this.data.clear();
    this.conversationHistory = [];
    this.scratchpad.clear();
    this.version = 0;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new LocalMemory instance with default settings
 */
export function createLocalMemory(maxHistoryLength?: number): LocalMemory {
  return new LocalMemory({ maxHistoryLength });
}

/**
 * Create a LocalMemory instance from a persisted snapshot
 */
export function restoreLocalMemory(snapshotJson: string): LocalMemory {
  return LocalMemory.fromJSON(snapshotJson);
}
