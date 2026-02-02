/**
 * Lifecycle module exports
 */

export {
  AgentSpawner,
  getAgentSpawner,
  destroyAgentSpawner,
} from './AgentSpawner';

export type {
  SpawnOptions,
  SpawnInTabOptions,
  SpawnInExistingTabOptions,
  SpawnInOffscreenOptions,
  SpawnResult,
} from './AgentSpawner';

export {
  AgentContext,
  createAgentContext,
  parseAgentParams,
} from './AgentContext';

export type {
  AgentContextConfig,
  TaskHandler,
} from './AgentContext';
