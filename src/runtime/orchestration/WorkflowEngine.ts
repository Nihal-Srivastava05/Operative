/**
 * WorkflowEngine - Multi-step workflow execution
 *
 * Provides:
 * - Sequential, parallel, or graph-based step ordering
 * - Input/output mapping between steps
 * - Execution state tracking
 * - Cancel support
 */

import { db, WorkflowExecution, WorkflowStatus } from '../../store/db';
import { AgentIdentity } from '../protocol/types';
import { getTaskQueue, TaskQueue, CreateTaskOptions } from './TaskQueue';

export interface WorkflowStep {
  /** Unique step ID */
  id: string;
  /** Agent definition to execute this step */
  agentDefinitionId?: string;
  /** Task prompt for this step */
  task: string;
  /** Steps that must complete before this one */
  dependsOn?: string[];
  /** Key to store output under (for use by other steps) */
  outputAs?: string;
  /** Input mapping from other step outputs */
  inputMapping?: Record<string, string>; // { paramName: 'stepId.outputKey' }
  /** Task options */
  options?: Partial<CreateTaskOptions>;
}

export interface WorkflowDefinition {
  /** Unique workflow ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Required agent definitions */
  requiredAgents?: string[];
  /** Workflow steps */
  steps: WorkflowStep[];
  /** Global input schema */
  inputSchema?: Record<string, unknown>;
}

export interface WorkflowExecutionContext {
  /** Workflow input */
  input: unknown;
  /** Step outputs indexed by outputAs key */
  outputs: Record<string, unknown>;
  /** Execution ID */
  executionId: string;
}

export interface WorkflowResult {
  executionId: string;
  status: WorkflowStatus;
  outputs: Record<string, unknown>;
  finalOutput?: unknown;
  error?: string;
  duration?: number;
}

type WorkflowEventHandler = (execution: WorkflowExecution) => void | Promise<void>;

/**
 * WorkflowEngine executes multi-step workflows
 */
export class WorkflowEngine {
  private identity: AgentIdentity;
  private taskQueue: TaskQueue;
  private runningWorkflows: Map<string, {
    definition: WorkflowDefinition;
    context: WorkflowExecutionContext;
    pendingSteps: Set<string>;
    completedSteps: Set<string>;
    cancelled: boolean;
  }> = new Map();
  private eventHandlers: Map<WorkflowStatus, Set<WorkflowEventHandler>> = new Map();

  constructor(identity: AgentIdentity) {
    this.identity = identity;
    this.taskQueue = getTaskQueue(identity);
  }

  /**
   * Execute a workflow
   */
  async execute(
    definition: WorkflowDefinition,
    input?: unknown
  ): Promise<WorkflowResult> {
    const executionId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Create execution record
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: definition.id,
      status: 'pending',
      stepOutputs: {},
      input,
      createdAt: Date.now(),
    };

    await db.workflowExecutions.add(execution);

    // Initialize context
    const context: WorkflowExecutionContext = {
      input,
      outputs: {},
      executionId,
    };

    // Track running state
    this.runningWorkflows.set(executionId, {
      definition,
      context,
      pendingSteps: new Set(definition.steps.map((s) => s.id)),
      completedSteps: new Set(),
      cancelled: false,
    });

    console.log(`[WorkflowEngine] Starting workflow ${definition.name} (${executionId})`);

    // Update status to running
    await this.updateExecution(executionId, { status: 'running', startedAt: Date.now() });
    await this.emitEvent('running', await this.getExecution(executionId));

    try {
      // Execute the workflow
      await this.executeSteps(executionId);

      // Check if cancelled
      const state = this.runningWorkflows.get(executionId);
      if (state?.cancelled) {
        await this.updateExecution(executionId, { status: 'cancelled', completedAt: Date.now() });
        await this.emitEvent('cancelled', await this.getExecution(executionId));

        return {
          executionId,
          status: 'cancelled',
          outputs: context.outputs,
        };
      }

      // Mark as completed
      await this.updateExecution(executionId, {
        status: 'completed',
        output: context.outputs,
        completedAt: Date.now(),
      });
      await this.emitEvent('completed', await this.getExecution(executionId));

      const finalExecution = await this.getExecution(executionId);

      return {
        executionId,
        status: 'completed',
        outputs: context.outputs,
        finalOutput: this.getFinalOutput(definition, context.outputs),
        duration: (finalExecution?.completedAt ?? Date.now()) - (finalExecution?.startedAt ?? Date.now()),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await this.updateExecution(executionId, {
        status: 'failed',
        error: errorMessage,
        completedAt: Date.now(),
      });
      await this.emitEvent('failed', await this.getExecution(executionId));

      return {
        executionId,
        status: 'failed',
        outputs: context.outputs,
        error: errorMessage,
      };
    } finally {
      this.runningWorkflows.delete(executionId);
    }
  }

  /**
   * Execute workflow steps respecting dependencies
   */
  private async executeSteps(executionId: string): Promise<void> {
    const state = this.runningWorkflows.get(executionId);
    if (!state) throw new Error(`Workflow ${executionId} not found`);

    const { definition, context, pendingSteps, completedSteps, cancelled } = state;

    while (pendingSteps.size > 0 && !cancelled) {
      // Find ready steps (dependencies satisfied)
      const readySteps = definition.steps.filter((step) => {
        if (!pendingSteps.has(step.id)) return false;
        if (!step.dependsOn || step.dependsOn.length === 0) return true;
        return step.dependsOn.every((dep) => completedSteps.has(dep));
      });

      if (readySteps.length === 0) {
        // No ready steps but pending steps exist - circular dependency or error
        throw new Error('Workflow deadlock: no ready steps but pending steps remain');
      }

      // Execute ready steps in parallel
      await Promise.all(
        readySteps.map((step) => this.executeStep(executionId, step))
      );

      // Check for cancellation after each batch
      if (state.cancelled) break;
    }
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(executionId: string, step: WorkflowStep): Promise<void> {
    const state = this.runningWorkflows.get(executionId);
    if (!state) throw new Error(`Workflow ${executionId} not found`);

    const { context, pendingSteps, completedSteps } = state;

    console.log(`[WorkflowEngine] Executing step ${step.id} in workflow ${executionId}`);

    // Update execution with current step
    await this.updateExecution(executionId, { currentStep: step.id });

    // Resolve input mapping
    const resolvedContext = this.resolveInputMapping(step, context);

    // Build task prompt with context
    let taskPrompt = step.task;
    if (Object.keys(resolvedContext).length > 0) {
      taskPrompt += `\n\nContext:\n${JSON.stringify(resolvedContext, null, 2)}`;
    }

    // Create and wait for task
    const task = await this.taskQueue.createTask({
      task: taskPrompt,
      targetDefinitionId: step.agentDefinitionId,
      context: resolvedContext,
      ...step.options,
    });

    // Wait for task completion
    const result = await this.waitForTask(task.id);

    if (result.status === 'failed') {
      throw new Error(`Step ${step.id} failed: ${result.error}`);
    }

    // Store output
    if (step.outputAs) {
      context.outputs[step.outputAs] = result.result;
    }

    // Update step outputs in execution
    await this.updateExecution(executionId, {
      stepOutputs: { ...context.outputs },
    });

    // Mark step as completed
    pendingSteps.delete(step.id);
    completedSteps.add(step.id);

    console.log(`[WorkflowEngine] Step ${step.id} completed`);
  }

  /**
   * Resolve input mapping from previous step outputs
   */
  private resolveInputMapping(
    step: WorkflowStep,
    context: WorkflowExecutionContext
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    // Add workflow input
    if (context.input) {
      resolved['input'] = context.input;
    }

    // Apply input mapping
    if (step.inputMapping) {
      for (const [paramName, source] of Object.entries(step.inputMapping)) {
        const value = this.resolveOutputPath(source, context.outputs);
        if (value !== undefined) {
          resolved[paramName] = value;
        }
      }
    }

    return resolved;
  }

  /**
   * Resolve a dotted path from outputs (e.g., 'stepId.key.nested')
   */
  private resolveOutputPath(path: string, outputs: Record<string, unknown>): unknown {
    const parts = path.split('.');
    let current: unknown = outputs;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Wait for a task to complete
   */
  private waitForTask(taskId: string): Promise<{ status: string; result?: unknown; error?: string }> {
    return new Promise((resolve) => {
      const checkTask = async () => {
        const task = await this.taskQueue.getTask(taskId);
        if (!task) {
          resolve({ status: 'failed', error: 'Task not found' });
          return;
        }

        if (task.status === 'completed') {
          resolve({ status: 'completed', result: task.result });
        } else if (task.status === 'failed') {
          resolve({ status: 'failed', error: task.error });
        } else if (task.status === 'cancelled') {
          resolve({ status: 'cancelled' });
        } else {
          // Still pending/in progress - check again
          setTimeout(checkTask, 1000);
        }
      };

      checkTask();
    });
  }

  /**
   * Get final output from workflow (last step's output or specific output key)
   */
  private getFinalOutput(
    definition: WorkflowDefinition,
    outputs: Record<string, unknown>
  ): unknown {
    // Return the last step's output if it has an outputAs
    const lastStep = definition.steps[definition.steps.length - 1];
    if (lastStep?.outputAs) {
      return outputs[lastStep.outputAs];
    }

    // Otherwise return all outputs
    return outputs;
  }

  /**
   * Cancel a running workflow
   */
  async cancel(executionId: string): Promise<boolean> {
    const state = this.runningWorkflows.get(executionId);
    if (!state) {
      // Check if it exists but isn't running
      const execution = await this.getExecution(executionId);
      if (execution && execution.status === 'pending') {
        await this.updateExecution(executionId, { status: 'cancelled', completedAt: Date.now() });
        return true;
      }
      return false;
    }

    state.cancelled = true;
    console.log(`[WorkflowEngine] Cancelling workflow ${executionId}`);
    return true;
  }

  /**
   * Get workflow execution
   */
  async getExecution(executionId: string): Promise<WorkflowExecution | undefined> {
    return db.workflowExecutions.get(executionId);
  }

  /**
   * Get all executions for a workflow
   */
  async getExecutions(workflowId: string): Promise<WorkflowExecution[]> {
    return db.workflowExecutions.where('workflowId').equals(workflowId).toArray();
  }

  /**
   * Update execution record
   */
  private async updateExecution(
    executionId: string,
    updates: Partial<WorkflowExecution>
  ): Promise<void> {
    await db.workflowExecutions.update(executionId, updates);
  }

  /**
   * Subscribe to workflow events
   */
  onEvent(status: WorkflowStatus, handler: WorkflowEventHandler): () => void {
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
   * Emit workflow event
   */
  private async emitEvent(status: WorkflowStatus, execution: WorkflowExecution | undefined): Promise<void> {
    if (!execution) return;

    const handlers = this.eventHandlers.get(status);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(execution);
      } catch (error) {
        console.error('[WorkflowEngine] Event handler error:', error);
      }
    }
  }

  /**
   * Cleanup old executions
   */
  async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;

    const toDelete = await db.workflowExecutions
      .filter((execution) =>
        (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') &&
        (execution.completedAt ?? 0) < cutoff
      )
      .toArray();

    if (toDelete.length > 0) {
      await db.workflowExecutions.bulkDelete(toDelete.map((e) => e.id));
    }

    return toDelete.length;
  }

  /**
   * Destroy the engine
   */
  destroy(): void {
    // Cancel all running workflows
    for (const [executionId, state] of this.runningWorkflows) {
      state.cancelled = true;
    }
    this.runningWorkflows.clear();
    this.eventHandlers.clear();
  }
}

// Singleton instance
let engineInstance: WorkflowEngine | null = null;

export function getWorkflowEngine(identity?: AgentIdentity): WorkflowEngine {
  if (!engineInstance) {
    if (!identity) {
      throw new Error('[WorkflowEngine] Identity required for initial creation');
    }
    engineInstance = new WorkflowEngine(identity);
  }
  return engineInstance;
}

export function destroyWorkflowEngine(): void {
  if (engineInstance) {
    engineInstance.destroy();
    engineInstance = null;
  }
}
