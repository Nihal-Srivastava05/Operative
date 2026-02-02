/**
 * Operative Runtime - Multi-Agent Browser Runtime
 *
 * A fully local, browser-native multi-agent runtime where each browser context
 * (tab, window, worker) can host an independent AI agent communicating via
 * native browser primitives.
 *
 * Architecture:
 * - Service Worker = Coordinator Agent (registry, routing, task queue)
 * - Tabs/Windows = Spawnable Agent Contexts
 * - BroadcastChannel = Inter-agent pub/sub
 * - Local Cache = Agent working memory (ephemeral)
 * - IndexedDB = Global shared memory (persistent)
 */

// ============================================================================
// Protocol
// ============================================================================
export * from './protocol/types';

// ============================================================================
// Channels
// ============================================================================
export * from './channels';

// ============================================================================
// Memory
// ============================================================================
export * from './memory';

// ============================================================================
// Registry
// ============================================================================
export * from './registry';

// ============================================================================
// Lifecycle
// ============================================================================
export * from './lifecycle';

// ============================================================================
// Orchestration
// ============================================================================
export * from './orchestration';

// ============================================================================
// Specification DSL
// ============================================================================
export * from './spec';

// ============================================================================
// Convenience Re-exports
// ============================================================================
export {
  // Identity & Messages
  generateAgentId,
  generateMessageId,
  createMessage,
  isMessageExpired,
  CHANNELS,
} from './protocol/types';

export {
  // Communication
  getBroadcastManager,
  destroyBroadcastManager,
  BroadcastManager,
  DirectChannel,
  DirectChannelManager,
} from './channels';

export {
  // Memory
  GlobalMemory,
  createSharedMemory,
  LocalMemory,
  createLocalMemory,
  restoreLocalMemory,
} from './memory';

export {
  // Registry
  AgentRegistry,
  getAgentRegistry,
  destroyAgentRegistry,
} from './registry';

export {
  // Lifecycle
  AgentSpawner,
  getAgentSpawner,
  destroyAgentSpawner,
  AgentContext,
  createAgentContext,
  parseAgentParams,
} from './lifecycle';

export {
  // Orchestration
  TaskQueue,
  getTaskQueue,
  destroyTaskQueue,
  WorkflowEngine,
  getWorkflowEngine,
  destroyWorkflowEngine,
} from './orchestration';

export {
  // Specs
  SpecParser,
  getSpecParser,
  AGENT_TEMPLATES,
  WORKFLOW_TEMPLATES,
} from './spec';
