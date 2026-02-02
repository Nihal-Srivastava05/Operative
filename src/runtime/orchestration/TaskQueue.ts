/**
 * TaskQueue - Distributed task queue for agent work
 *
 * Provides:
 * - Priority-based task ordering
 * - Task lifecycle management (pending → assigned → completed/failed)
 * - Retry logic with configurable max retries
 * - Persistence to IndexedDB via GlobalMemory
 */

import { db, QueuedTask, TaskPriority, TaskStatus, getPendingTasks } from '../../store/db';
import { AgentIdentity, generateAgentId } from '../protocol/types';
import { getBroadcastManager } from '../channels/BroadcastManager';
import { getAgentRegistry } from '../registry/AgentRegistry';

export interface CreateTaskOptions {
  /** Task description/prompt */
  task: string;
  /** Priority level (default: normal) */
  priority?: TaskPriority;
  /** Target specific agent definition */
  targetDefinitionId?: string;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Parent task ID for sub-tasks */
  parentTaskId?: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
}

type TaskEventHandler = (task: QueuedTask) => void | Promise<void>;

/**
 * TaskQueue manages the distributed task queue
 */
export class TaskQueue {
  private identity: AgentIdentity;
  private eventHandlers: Map<TaskStatus, Set<TaskEventHandler>> = new Map();
  private processingTasks: Set<string> = new Set();
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private pollingIntervalMs: number;
  private unsubscribers: Array<() => void> = [];

  constructor(identity: AgentIdentity, options?: { pollingIntervalMs?: number }) {
    this.identity = identity;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 5000;
    this.setupMessageListeners();
  }

  /**
   * Setup listeners for task-related messages
   */
  private setupMessageListeners(): void {
    const broadcast = getBroadcastManager();

    // Listen for task results
    const resultUnsub = broadcast.subscribeTasks(
      async (message) => {
        if (message.type === 'task:result') {
          const payload = message.payload as { taskId: string; result: unknown };
          await this.markCompleted(payload.taskId, payload.result);
        }
      },
      { type: 'task:result' }
    );
    this.unsubscribers.push(resultUnsub);

    // Listen for task errors
    const errorUnsub = broadcast.subscribeTasks(
      async (message) => {
        if (message.type === 'task:error') {
          const payload = message.payload as { taskId: string; error: string; recoverable: boolean };
          await this.markFailed(payload.taskId, payload.error, payload.recoverable);
        }
      },
      { type: 'task:error' }
    );
    this.unsubscribers.push(errorUnsub);

    // Listen for task accepts
    const acceptUnsub = broadcast.subscribeTasks(
      async (message) => {
        if (message.type === 'task:accept') {
          const payload = message.payload as { taskId: string };
          await this.markInProgress(payload.taskId, message.source.id);
        }
      },
      { type: 'task:accept' }
    );
    this.unsubscribers.push(acceptUnsub);
  }

  /**
   * Start polling for pending tasks to assign
   */
  startPolling(): void {
    if (this.pollingInterval) return;

    this.pollingInterval = setInterval(() => {
      this.assignPendingTasks();
    }, this.pollingIntervalMs);

    // Run immediately
    this.assignPendingTasks();
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Create a new task
   */
  async createTask(options: CreateTaskOptions): Promise<QueuedTask> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const task: QueuedTask = {
      id: taskId,
      task: options.task,
      priority: options.priority ?? 'normal',
      status: 'pending',
      targetDefinitionId: options.targetDefinitionId,
      context: options.context,
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeout,
      createdBy: this.identity.id,
      createdAt: Date.now(),
      parentTaskId: options.parentTaskId,
    };

    await db.taskQueue.add(task);
    await this.emitEvent('pending', task);

    console.log(`[TaskQueue] Created task ${taskId}: ${options.task.substring(0, 50)}...`);

    return task;
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<QueuedTask | undefined> {
    return db.taskQueue.get(taskId);
  }

  /**
   * Get all pending tasks
   */
  async getPendingTasks(): Promise<QueuedTask[]> {
    return getPendingTasks();
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: TaskStatus): Promise<QueuedTask[]> {
    return db.taskQueue.where('status').equals(status).toArray();
  }

  /**
   * Assign pending tasks to available agents
   */
  private async assignPendingTasks(): Promise<void> {
    const pending = await this.getPendingTasks();
    if (pending.length === 0) return;

    const registry = getAgentRegistry();
    const idleAgents = registry.getIdleAgents();

    for (const task of pending) {
      // Skip if already being processed
      if (this.processingTasks.has(task.id)) continue;

      // Find suitable agent
      let targetAgent = idleAgents.find((agent) => {
        // Skip if agent is no longer idle
        if (agent.status !== 'idle') return false;

        // Check definition match if specified
        if (task.targetDefinitionId && agent.identity.definitionId !== task.targetDefinitionId) {
          return false;
        }

        return true;
      });

      if (!targetAgent) {
        // No suitable agent available
        continue;
      }

      // Mark as being processed
      this.processingTasks.add(task.id);

      // Delegate the task
      const broadcast = getBroadcastManager();
      broadcast.publishTask(
        'task:delegate',
        { type: 'agent', agentId: targetAgent.identity.id },
        {
          taskId: task.id,
          task: task.task,
          priority: task.priority,
          context: task.context,
          timeout: task.timeout,
        }
      );

      // Update task status
      await db.taskQueue.update(task.id, {
        status: 'assigned',
        assignedAgentId: targetAgent.identity.id,
        assignedAt: Date.now(),
      });

      // Update agent status
      registry.updateStatus(targetAgent.identity.id, 'busy', task.id);

      // Remove from idle list for this iteration
      idleAgents.splice(idleAgents.indexOf(targetAgent), 1);

      console.log(`[TaskQueue] Assigned task ${task.id} to agent ${targetAgent.identity.id}`);
    }
  }

  /**
   * Mark task as in progress
   */
  private async markInProgress(taskId: string, agentId: string): Promise<void> {
    await db.taskQueue.update(taskId, {
      status: 'in_progress',
      assignedAgentId: agentId,
      startedAt: Date.now(),
    });

    const task = await this.getTask(taskId);
    if (task) {
      await this.emitEvent('in_progress', task);
    }
  }

  /**
   * Mark task as completed
   */
  async markCompleted(taskId: string, result?: unknown): Promise<void> {
    this.processingTasks.delete(taskId);

    await db.taskQueue.update(taskId, {
      status: 'completed',
      result,
      completedAt: Date.now(),
    });

    const task = await this.getTask(taskId);
    if (task) {
      // Update agent status back to idle
      if (task.assignedAgentId) {
        getAgentRegistry().updateStatus(task.assignedAgentId, 'idle');
      }

      await this.emitEvent('completed', task);
      console.log(`[TaskQueue] Task ${taskId} completed`);
    }
  }

  /**
   * Mark task as failed
   */
  async markFailed(taskId: string, error: string, recoverable: boolean = false): Promise<void> {
    this.processingTasks.delete(taskId);

    const task = await this.getTask(taskId);
    if (!task) return;

    // Update agent status back to idle
    if (task.assignedAgentId) {
      getAgentRegistry().updateStatus(task.assignedAgentId, 'idle');
    }

    // Check if we should retry
    if (recoverable && task.retryCount < task.maxRetries) {
      await db.taskQueue.update(taskId, {
        status: 'pending',
        retryCount: task.retryCount + 1,
        assignedAgentId: undefined,
        error,
      });

      console.log(`[TaskQueue] Task ${taskId} failed, retrying (${task.retryCount + 1}/${task.maxRetries})`);
      return;
    }

    // Mark as failed
    await db.taskQueue.update(taskId, {
      status: 'failed',
      error,
      completedAt: Date.now(),
    });

    const updatedTask = await this.getTask(taskId);
    if (updatedTask) {
      await this.emitEvent('failed', updatedTask);
      console.log(`[TaskQueue] Task ${taskId} failed: ${error}`);
    }
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task) return false;

    // Can only cancel pending or assigned tasks
    if (task.status !== 'pending' && task.status !== 'assigned') {
      return false;
    }

    this.processingTasks.delete(taskId);

    await db.taskQueue.update(taskId, {
      status: 'cancelled',
      completedAt: Date.now(),
    });

    // If assigned, notify the agent
    if (task.assignedAgentId) {
      const broadcast = getBroadcastManager();
      broadcast.publishTask(
        'lifecycle:terminate',
        { type: 'agent', agentId: task.assignedAgentId },
        { reason: 'requested', graceful: true }
      );

      getAgentRegistry().updateStatus(task.assignedAgentId, 'idle');
    }

    const updatedTask = await this.getTask(taskId);
    if (updatedTask) {
      await this.emitEvent('cancelled', updatedTask);
    }

    console.log(`[TaskQueue] Task ${taskId} cancelled`);
    return true;
  }

  /**
   * Subscribe to task events
   */
  onTaskEvent(status: TaskStatus, handler: TaskEventHandler): () => void {
    if (!this.eventHandlers.has(status)) {
      this.eventHandlers.set(status, new Set());
    }
    this.eventHandlers.get(status)!.add(handler);

    return () => {
      const handlers = this.eventHandlers.get(status);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  /**
   * Emit a task event
   */
  private async emitEvent(status: TaskStatus, task: QueuedTask): Promise<void> {
    const handlers = this.eventHandlers.get(status);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(task);
      } catch (error) {
        console.error('[TaskQueue] Event handler error:', error);
      }
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    assigned: number;
    inProgress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  }> {
    const allTasks = await db.taskQueue.toArray();

    const stats = {
      pending: 0,
      assigned: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: allTasks.length,
    };

    for (const task of allTasks) {
      switch (task.status) {
        case 'pending': stats.pending++; break;
        case 'assigned': stats.assigned++; break;
        case 'in_progress': stats.inProgress++; break;
        case 'completed': stats.completed++; break;
        case 'failed': stats.failed++; break;
        case 'cancelled': stats.cancelled++; break;
      }
    }

    return stats;
  }

  /**
   * Cleanup old completed/failed tasks
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;

    const toDelete = await db.taskQueue
      .filter((task) =>
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
        (task.completedAt ?? 0) < cutoff
      )
      .toArray();

    if (toDelete.length > 0) {
      await db.taskQueue.bulkDelete(toDelete.map((t) => t.id));
    }

    return toDelete.length;
  }

  /**
   * Clear all tasks (use with caution)
   */
  async clear(): Promise<void> {
    await db.taskQueue.clear();
    this.processingTasks.clear();
    console.log('[TaskQueue] Cleared all tasks');
  }

  /**
   * Destroy the task queue
   */
  destroy(): void {
    this.stopPolling();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.eventHandlers.clear();
    this.processingTasks.clear();
  }
}

// Singleton instance
let queueInstance: TaskQueue | null = null;

export function getTaskQueue(identity?: AgentIdentity): TaskQueue {
  if (!queueInstance) {
    if (!identity) {
      throw new Error('[TaskQueue] Identity required for initial creation');
    }
    queueInstance = new TaskQueue(identity);
  }
  return queueInstance;
}

export function destroyTaskQueue(): void {
  if (queueInstance) {
    queueInstance.destroy();
    queueInstance = null;
  }
}
