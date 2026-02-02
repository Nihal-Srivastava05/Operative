/**
 * GlobalMemory - IndexedDB-backed shared memory for agents
 *
 * Provides persistent storage accessible by all agents with:
 * - Namespace-scoped access control
 * - TTL-based expiration
 * - Change notifications via BroadcastChannel
 * - Optimistic concurrency control
 */

import { db, MemoryEntry, createMemoryId, parseMemoryId } from '../../store/db';
import { getBroadcastManager } from '../channels/BroadcastManager';
import { AgentIdentity, MemoryChangedPayload, CHANNELS } from '../protocol/types';

export interface ReadOptions {
  /** Return default value if key not found */
  defaultValue?: unknown;
}

export interface WriteOptions {
  /** Time-to-live in milliseconds */
  ttl?: number;
  /** Expected version for optimistic concurrency (fails if mismatch) */
  expectedVersion?: number;
  /** If true, only write if key doesn't exist */
  ifNotExists?: boolean;
}

export interface QueryOptions {
  /** Filter by namespace prefix */
  namespacePrefix?: string;
  /** Include expired entries (default: false) */
  includeExpired?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface MemoryChangeEvent {
  namespace: string;
  key: string;
  operation: 'write' | 'delete';
  newValue?: unknown;
  oldValue?: unknown;
  changedBy: string;
}

type ChangeHandler = (event: MemoryChangeEvent) => void;

/**
 * Global shared memory backed by IndexedDB
 */
export class GlobalMemory {
  private identity: AgentIdentity;
  private changeHandlers: Map<string, Set<ChangeHandler>> = new Map();
  private unsubscribeBroadcast: (() => void) | null = null;

  constructor(identity: AgentIdentity) {
    this.identity = identity;
    this.setupBroadcastListener();
  }

  /**
   * Setup listener for memory change broadcasts from other agents
   */
  private setupBroadcastListener(): void {
    const broadcastManager = getBroadcastManager();

    this.unsubscribeBroadcast = broadcastManager.subscribeMemory<MemoryChangedPayload>(
      (message) => {
        if (message.type !== 'memory:changed') return;

        const payload = message.payload;
        const event: MemoryChangeEvent = {
          namespace: payload.namespace,
          key: payload.key,
          operation: payload.operation,
          newValue: payload.newValue,
          oldValue: payload.oldValue,
          changedBy: message.source.id,
        };

        this.notifyChangeHandlers(event);
      },
      { type: 'memory:changed' }
    );
  }

  /**
   * Notify registered change handlers
   */
  private notifyChangeHandlers(event: MemoryChangeEvent): void {
    // Notify namespace-specific handlers
    const namespaceHandlers = this.changeHandlers.get(event.namespace);
    if (namespaceHandlers) {
      for (const handler of namespaceHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('[GlobalMemory] Change handler error:', error);
        }
      }
    }

    // Notify wildcard handlers
    const wildcardHandlers = this.changeHandlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('[GlobalMemory] Wildcard handler error:', error);
        }
      }
    }
  }

  /**
   * Broadcast a memory change to other agents
   */
  private broadcastChange(
    namespace: string,
    key: string,
    operation: 'write' | 'delete',
    newValue?: unknown,
    oldValue?: unknown
  ): void {
    const broadcastManager = getBroadcastManager();

    broadcastManager.publishMemory(
      'memory:changed',
      { type: 'broadcast' },
      { namespace, key, operation, newValue, oldValue }
    );
  }

  /**
   * Read a value from global memory
   */
  async read<T = unknown>(
    namespace: string,
    key: string,
    options?: ReadOptions
  ): Promise<T | undefined> {
    const id = createMemoryId(namespace, key);
    const entry = await db.memory.get(id);

    if (!entry) {
      return options?.defaultValue as T | undefined;
    }

    // Check expiration
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      // Entry expired, delete it
      await db.memory.delete(id);
      return options?.defaultValue as T | undefined;
    }

    return entry.value as T;
  }

  /**
   * Write a value to global memory
   */
  async write<T = unknown>(
    namespace: string,
    key: string,
    value: T,
    options?: WriteOptions
  ): Promise<{ success: boolean; version: number }> {
    const id = createMemoryId(namespace, key);
    const now = Date.now();

    // Get existing entry for version check and old value
    const existing = await db.memory.get(id);

    // Check ifNotExists condition
    if (options?.ifNotExists && existing) {
      return { success: false, version: existing.version };
    }

    // Check optimistic concurrency
    if (options?.expectedVersion !== undefined && existing) {
      if (existing.version !== options.expectedVersion) {
        return { success: false, version: existing.version };
      }
    }

    const newVersion = (existing?.version ?? 0) + 1;

    const entry: MemoryEntry = {
      id,
      namespace,
      key,
      value,
      version: newVersion,
      createdBy: existing?.createdBy ?? this.identity.id,
      updatedBy: this.identity.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: options?.ttl ? now + options.ttl : undefined,
    };

    await db.memory.put(entry);

    // Broadcast change
    this.broadcastChange(namespace, key, 'write', value, existing?.value);

    // Also notify local handlers
    this.notifyChangeHandlers({
      namespace,
      key,
      operation: 'write',
      newValue: value,
      oldValue: existing?.value,
      changedBy: this.identity.id,
    });

    return { success: true, version: newVersion };
  }

  /**
   * Delete a value from global memory
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    const id = createMemoryId(namespace, key);
    const existing = await db.memory.get(id);

    if (!existing) {
      return false;
    }

    await db.memory.delete(id);

    // Broadcast change
    this.broadcastChange(namespace, key, 'delete', undefined, existing.value);

    // Notify local handlers
    this.notifyChangeHandlers({
      namespace,
      key,
      operation: 'delete',
      oldValue: existing.value,
      changedBy: this.identity.id,
    });

    return true;
  }

  /**
   * Query memory entries
   */
  async query(options?: QueryOptions): Promise<MemoryEntry[]> {
    let collection = db.memory.toCollection();

    // Apply namespace prefix filter
    if (options?.namespacePrefix) {
      collection = db.memory
        .where('namespace')
        .startsWith(options.namespacePrefix);
    }

    let results = await collection.toArray();

    // Filter expired unless requested
    if (!options?.includeExpired) {
      const now = Date.now();
      results = results.filter(
        (entry) => !entry.expiresAt || entry.expiresAt > now
      );
    }

    // Apply pagination
    if (options?.offset) {
      results = results.slice(options.offset);
    }
    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Get all keys in a namespace
   */
  async keys(namespace: string): Promise<string[]> {
    const entries = await db.memory
      .where('namespace')
      .equals(namespace)
      .toArray();

    const now = Date.now();
    return entries
      .filter((e) => !e.expiresAt || e.expiresAt > now)
      .map((e) => e.key);
  }

  /**
   * Check if a key exists
   */
  async has(namespace: string, key: string): Promise<boolean> {
    const value = await this.read(namespace, key);
    return value !== undefined;
  }

  /**
   * Get entry metadata (version, timestamps, etc.)
   */
  async getMetadata(
    namespace: string,
    key: string
  ): Promise<Omit<MemoryEntry, 'value'> | null> {
    const id = createMemoryId(namespace, key);
    const entry = await db.memory.get(id);

    if (!entry) return null;

    // Check expiration
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      return null;
    }

    const { value, ...metadata } = entry;
    return metadata;
  }

  /**
   * Subscribe to changes in a namespace
   */
  onChange(namespace: string | '*', handler: ChangeHandler): () => void {
    if (!this.changeHandlers.has(namespace)) {
      this.changeHandlers.set(namespace, new Set());
    }
    this.changeHandlers.get(namespace)!.add(handler);

    return () => {
      const handlers = this.changeHandlers.get(namespace);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.changeHandlers.delete(namespace);
        }
      }
    };
  }

  /**
   * Clear all entries in a namespace
   */
  async clearNamespace(namespace: string): Promise<number> {
    const entries = await db.memory.where('namespace').equals(namespace).toArray();

    if (entries.length > 0) {
      await db.memory.bulkDelete(entries.map((e) => e.id));

      // Broadcast deletions
      for (const entry of entries) {
        this.broadcastChange(namespace, entry.key, 'delete', undefined, entry.value);
      }
    }

    return entries.length;
  }

  /**
   * Cleanup expired entries
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    const expired = await db.memory.where('expiresAt').below(now).toArray();

    if (expired.length > 0) {
      await db.memory.bulkDelete(expired.map((e) => e.id));

      // Broadcast deletions
      for (const entry of expired) {
        this.broadcastChange(
          entry.namespace,
          entry.key,
          'delete',
          undefined,
          entry.value
        );
      }
    }

    return expired.length;
  }

  /**
   * Destroy the global memory instance and cleanup
   */
  destroy(): void {
    if (this.unsubscribeBroadcast) {
      this.unsubscribeBroadcast();
      this.unsubscribeBroadcast = null;
    }
    this.changeHandlers.clear();
  }
}

// ============================================================================
// Convenience Functions for Shared Namespace
// ============================================================================

/**
 * Create a GlobalMemory instance bound to the shared namespace
 */
export function createSharedMemory(identity: AgentIdentity): {
  read: <T = unknown>(key: string, defaultValue?: T) => Promise<T | undefined>;
  write: <T = unknown>(key: string, value: T, ttl?: number) => Promise<boolean>;
  delete: (key: string) => Promise<boolean>;
  keys: () => Promise<string[]>;
  onChange: (handler: ChangeHandler) => () => void;
} {
  const memory = new GlobalMemory(identity);
  const namespace = 'shared';

  return {
    read: <T = unknown>(key: string, defaultValue?: T) =>
      memory.read<T>(namespace, key, { defaultValue }),
    write: async <T = unknown>(key: string, value: T, ttl?: number) => {
      const result = await memory.write(namespace, key, value, { ttl });
      return result.success;
    },
    delete: (key: string) => memory.delete(namespace, key),
    keys: () => memory.keys(namespace),
    onChange: (handler: ChangeHandler) =>
      memory.onChange(namespace, handler),
  };
}
