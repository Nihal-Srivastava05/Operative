/**
 * SpecParser - Parse and validate agent and workflow specifications
 *
 * Supports:
 * - JSON parsing and validation
 * - Schema validation with helpful error messages
 * - Conversion to database entities
 * - Import/export functionality
 */

import { db, Agent } from '../../store/db';
import {
  AgentSpec,
  WorkflowSpec,
  AgentCollection,
  AgentSpecMetadata,
  WorkflowStepSpec,
  AGENT_TEMPLATES,
} from './AgentSpec';
import { WorkflowDefinition, WorkflowStep } from '../orchestration/WorkflowEngine';

export interface ParseResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
  warnings?: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * SpecParser handles parsing and validation of agent specifications
 */
export class SpecParser {
  /**
   * Parse a JSON string into an AgentSpec
   */
  parseAgentSpec(json: string): ParseResult<AgentSpec> {
    try {
      const data = JSON.parse(json);
      return this.validateAgentSpec(data);
    } catch (error) {
      return {
        success: false,
        errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`],
      };
    }
  }

  /**
   * Validate an AgentSpec object
   */
  validateAgentSpec(data: unknown): ParseResult<AgentSpec> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!data || typeof data !== 'object') {
      return { success: false, errors: ['Spec must be an object'] };
    }

    const spec = data as Record<string, unknown>;

    // Required fields
    if (spec.specVersion !== '1.0') {
      errors.push(`Invalid or missing specVersion. Expected '1.0', got '${spec.specVersion}'`);
    }

    if (!spec.metadata || typeof spec.metadata !== 'object') {
      errors.push('Missing or invalid metadata object');
    } else {
      const metadata = spec.metadata as Record<string, unknown>;
      if (!metadata.id || typeof metadata.id !== 'string') {
        errors.push('metadata.id is required and must be a string');
      }
      if (!metadata.name || typeof metadata.name !== 'string') {
        errors.push('metadata.name is required and must be a string');
      }
    }

    if (!spec.type || !['worker', 'orchestrator'].includes(spec.type as string)) {
      errors.push(`type must be 'worker' or 'orchestrator', got '${spec.type}'`);
    }

    if (!spec.behavior || typeof spec.behavior !== 'object') {
      errors.push('Missing or invalid behavior object');
    } else {
      const behavior = spec.behavior as Record<string, unknown>;
      if (!behavior.systemPrompt || typeof behavior.systemPrompt !== 'string') {
        errors.push('behavior.systemPrompt is required and must be a string');
      }
      if (behavior.temperature !== undefined) {
        const temp = behavior.temperature as number;
        if (typeof temp !== 'number' || temp < 0 || temp > 1) {
          errors.push('behavior.temperature must be a number between 0 and 1');
        }
      }
    }

    // Optional field validation
    if (spec.capabilities && typeof spec.capabilities === 'object') {
      const caps = spec.capabilities as Record<string, unknown>;
      if (caps.tools && !Array.isArray(caps.tools)) {
        errors.push('capabilities.tools must be an array');
      }
      if (caps.memory && typeof caps.memory !== 'object') {
        errors.push('capabilities.memory must be an object');
      }
    }

    if (spec.routing && typeof spec.routing === 'object') {
      const routing = spec.routing as Record<string, unknown>;
      if (routing.patterns && !Array.isArray(routing.patterns)) {
        errors.push('routing.patterns must be an array');
      }
      if (routing.priority !== undefined && typeof routing.priority !== 'number') {
        errors.push('routing.priority must be a number');
      }
    }

    // Warnings for optional improvements
    if (!spec.capabilities) {
      warnings.push('No capabilities defined. Agent will have limited functionality.');
    }

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    return {
      success: true,
      data: spec as unknown as AgentSpec,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Parse a JSON string into a WorkflowSpec
   */
  parseWorkflowSpec(json: string): ParseResult<WorkflowSpec> {
    try {
      const data = JSON.parse(json);
      return this.validateWorkflowSpec(data);
    } catch (error) {
      return {
        success: false,
        errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`],
      };
    }
  }

  /**
   * Validate a WorkflowSpec object
   */
  validateWorkflowSpec(data: unknown): ParseResult<WorkflowSpec> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!data || typeof data !== 'object') {
      return { success: false, errors: ['Spec must be an object'] };
    }

    const spec = data as Record<string, unknown>;

    // Required fields
    if (spec.specVersion !== '1.0') {
      errors.push(`Invalid or missing specVersion. Expected '1.0', got '${spec.specVersion}'`);
    }

    if (!spec.metadata || typeof spec.metadata !== 'object') {
      errors.push('Missing or invalid metadata object');
    } else {
      const metadata = spec.metadata as Record<string, unknown>;
      if (!metadata.id || typeof metadata.id !== 'string') {
        errors.push('metadata.id is required and must be a string');
      }
      if (!metadata.name || typeof metadata.name !== 'string') {
        errors.push('metadata.name is required and must be a string');
      }
    }

    if (!spec.agents || !Array.isArray(spec.agents)) {
      errors.push('agents must be an array of agent spec IDs');
    }

    if (!spec.steps || !Array.isArray(spec.steps)) {
      errors.push('steps must be an array');
    } else {
      const steps = spec.steps as unknown[];
      const stepIds = new Set<string>();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || typeof step !== 'object') {
          errors.push(`steps[${i}] must be an object`);
          continue;
        }

        const s = step as Record<string, unknown>;
        if (!s.id || typeof s.id !== 'string') {
          errors.push(`steps[${i}].id is required and must be a string`);
        } else if (stepIds.has(s.id)) {
          errors.push(`Duplicate step id: ${s.id}`);
        } else {
          stepIds.add(s.id);
        }

        if (!s.agent || typeof s.agent !== 'string') {
          errors.push(`steps[${i}].agent is required and must be a string`);
        }

        if (!s.task || typeof s.task !== 'string') {
          errors.push(`steps[${i}].task is required and must be a string`);
        }

        if (s.dependsOn && !Array.isArray(s.dependsOn)) {
          errors.push(`steps[${i}].dependsOn must be an array`);
        }
      }

      // Validate dependency references
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as Record<string, unknown>;
        if (step.dependsOn && Array.isArray(step.dependsOn)) {
          for (const dep of step.dependsOn) {
            if (!stepIds.has(dep as string)) {
              errors.push(`steps[${i}].dependsOn references unknown step: ${dep}`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    return {
      success: true,
      data: spec as unknown as WorkflowSpec,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Parse an agent collection (multiple specs in one file)
   */
  parseCollection(json: string): ParseResult<AgentCollection> {
    try {
      const data = JSON.parse(json);
      return this.validateCollection(data);
    } catch (error) {
      return {
        success: false,
        errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`],
      };
    }
  }

  /**
   * Validate an agent collection
   */
  validateCollection(data: unknown): ParseResult<AgentCollection> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!data || typeof data !== 'object') {
      return { success: false, errors: ['Collection must be an object'] };
    }

    const collection = data as Record<string, unknown>;

    if (collection.specVersion !== '1.0') {
      errors.push(`Invalid specVersion. Expected '1.0', got '${collection.specVersion}'`);
    }

    if (!collection.metadata || typeof collection.metadata !== 'object') {
      errors.push('Missing metadata');
    }

    if (!collection.agents || !Array.isArray(collection.agents)) {
      errors.push('agents must be an array');
    } else {
      for (let i = 0; i < collection.agents.length; i++) {
        const result = this.validateAgentSpec(collection.agents[i]);
        if (!result.success) {
          result.errors?.forEach((e) => errors.push(`agents[${i}]: ${e}`));
        }
        result.warnings?.forEach((w) => warnings.push(`agents[${i}]: ${w}`));
      }
    }

    if (collection.workflows && Array.isArray(collection.workflows)) {
      for (let i = 0; i < collection.workflows.length; i++) {
        const result = this.validateWorkflowSpec(collection.workflows[i]);
        if (!result.success) {
          result.errors?.forEach((e) => errors.push(`workflows[${i}]: ${e}`));
        }
        result.warnings?.forEach((w) => warnings.push(`workflows[${i}]: ${w}`));
      }
    }

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    return {
      success: true,
      data: collection as unknown as AgentCollection,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Convert AgentSpec to database Agent entity
   */
  agentSpecToEntity(spec: AgentSpec): Agent {
    return {
      id: spec.metadata.id,
      name: spec.metadata.name,
      systemPrompt: spec.behavior.systemPrompt,
      type: spec.type,
      enabled: true,
      createdAt: Date.now(),
      // Note: Tool assignment would need to be handled separately
    };
  }

  /**
   * Convert database Agent entity to AgentSpec
   */
  entityToAgentSpec(entity: Agent): AgentSpec {
    return {
      specVersion: '1.0',
      metadata: {
        id: entity.id,
        name: entity.name,
      },
      type: entity.type,
      behavior: {
        systemPrompt: entity.systemPrompt,
      },
      capabilities: entity.assignedTool
        ? { tools: [entity.assignedTool.toolName] }
        : undefined,
    };
  }

  /**
   * Convert WorkflowSpec to WorkflowDefinition (runtime format)
   */
  workflowSpecToDefinition(spec: WorkflowSpec): WorkflowDefinition {
    const steps: WorkflowStep[] = spec.steps.map((step) => ({
      id: step.id,
      agentDefinitionId: step.agent,
      task: step.task,
      dependsOn: step.dependsOn,
      outputAs: step.outputAs,
      inputMapping: step.inputMapping,
      options: {
        timeout: step.timeout,
        maxRetries: step.retry?.maxAttempts,
      },
    }));

    return {
      id: spec.metadata.id,
      name: spec.metadata.name,
      description: spec.metadata.description,
      requiredAgents: spec.agents,
      steps,
    };
  }

  /**
   * Import an AgentSpec and save to database
   */
  async importAgentSpec(spec: AgentSpec): Promise<string> {
    const entity = this.agentSpecToEntity(spec);
    await db.agents.put(entity);
    return entity.id;
  }

  /**
   * Import multiple agent specs from a collection
   */
  async importCollection(collection: AgentCollection): Promise<{
    agentIds: string[];
    workflowIds: string[];
  }> {
    const agentIds: string[] = [];

    for (const spec of collection.agents) {
      const id = await this.importAgentSpec(spec);
      agentIds.push(id);
    }

    // Workflows don't have direct database storage, return their IDs
    const workflowIds = collection.workflows?.map((w) => w.metadata.id) ?? [];

    return { agentIds, workflowIds };
  }

  /**
   * Export all agents as a collection
   */
  async exportCollection(): Promise<AgentCollection> {
    const entities = await db.agents.toArray();
    const agents = entities.map((e) => this.entityToAgentSpec(e));

    return {
      specVersion: '1.0',
      metadata: {
        name: 'Exported Agents',
        description: 'Exported from Operative',
        version: new Date().toISOString(),
      },
      agents,
    };
  }

  /**
   * Create an AgentSpec from a template
   */
  createFromTemplate(
    templateName: keyof typeof AGENT_TEMPLATES,
    overrides: Partial<AgentSpec>
  ): AgentSpec {
    const template = AGENT_TEMPLATES[templateName];
    if (!template) {
      throw new Error(`Unknown template: ${templateName}`);
    }

    return {
      specVersion: '1.0',
      metadata: {
        id: overrides.metadata?.id || `agent_${Date.now()}`,
        name: overrides.metadata?.name || templateName,
        ...overrides.metadata,
      },
      type: overrides.type || template.type || 'worker',
      capabilities: {
        ...template.capabilities,
        ...overrides.capabilities,
      },
      behavior: {
        ...template.behavior,
        ...overrides.behavior,
        systemPrompt: overrides.behavior?.systemPrompt || template.behavior?.systemPrompt || '',
      },
      routing: {
        ...template.routing,
        ...overrides.routing,
      },
    };
  }

  /**
   * Interpolate variables in a task string
   */
  interpolateTask(template: string, context: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key in context) {
        const value = context[key];
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
      return match; // Keep original if not found
    });
  }
}

// Singleton instance
let parserInstance: SpecParser | null = null;

export function getSpecParser(): SpecParser {
  if (!parserInstance) {
    parserInstance = new SpecParser();
  }
  return parserInstance;
}
