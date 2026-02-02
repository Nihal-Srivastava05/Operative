/**
 * Spec module exports
 */

export {
  AGENT_TEMPLATES,
  WORKFLOW_TEMPLATES,
} from './AgentSpec';

export type {
  AgentSpec,
  AgentSpecMetadata,
  AgentCapabilities,
  AgentBehavior,
  AgentRouting,
  WorkflowSpec,
  WorkflowSpecMetadata,
  WorkflowStepSpec,
  WorkflowInput,
  AgentCollection,
} from './AgentSpec';

export {
  SpecParser,
  getSpecParser,
} from './SpecParser';

export type {
  ParseResult,
  ValidationError,
} from './SpecParser';
