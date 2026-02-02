/**
 * AgentSpec - Agent Specification DSL Types
 *
 * Provides type-safe definitions for agent and workflow specifications.
 */

// ============================================================================
// Agent Specification
// ============================================================================

export interface AgentSpecMetadata {
  /** Unique identifier for this agent spec */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this agent does */
  description?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Version of the spec */
  version?: string;
  /** Author information */
  author?: string;
}

export interface AgentCapabilities {
  /** List of tool names this agent can use */
  tools?: string[];
  /** Memory access permissions */
  memory?: {
    /** Namespaces the agent can read from */
    readScopes?: string[];
    /** Namespaces the agent can write to */
    writeScopes?: string[];
  };
  /** Whether this agent can spawn other agents */
  canSpawnAgents?: boolean;
  /** Whether this agent can access the DOM (content scripts) */
  canAccessDom?: boolean;
  /** Custom capabilities */
  custom?: string[];
}

export interface AgentBehavior {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Temperature for AI inference (0-1) */
  temperature?: number;
  /** Top-K sampling parameter */
  topK?: number;
  /** Maximum tool calls per turn */
  maxToolCalls?: number;
  /** Maximum conversation turns */
  maxTurns?: number;
  /** Response format hint */
  responseFormat?: 'text' | 'json' | 'markdown';
}

export interface AgentRouting {
  /** Patterns that trigger routing to this agent */
  patterns?: string[];
  /** Keywords that match this agent */
  keywords?: string[];
  /** Priority for routing (higher = preferred) */
  priority?: number;
}

export interface AgentSpec {
  /** Spec version (for schema evolution) */
  specVersion: '1.0';
  /** Agent metadata */
  metadata: AgentSpecMetadata;
  /** Agent type */
  type: 'worker' | 'orchestrator';
  /** Agent capabilities */
  capabilities?: AgentCapabilities;
  /** Agent behavior configuration */
  behavior: AgentBehavior;
  /** Routing configuration */
  routing?: AgentRouting;
  /** Preferred execution context */
  preferredContext?: 'tab' | 'offscreen' | 'content-script' | 'side-panel';
}

// ============================================================================
// Workflow Specification
// ============================================================================

export interface WorkflowSpecMetadata {
  /** Unique identifier for this workflow */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this workflow does */
  description?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Version of the spec */
  version?: string;
}

export interface WorkflowStepSpec {
  /** Unique step ID */
  id: string;
  /** Human-readable step name */
  name?: string;
  /** Agent spec ID to execute this step */
  agent: string;
  /** Task prompt template (supports {{variable}} interpolation) */
  task: string;
  /** Step IDs that must complete before this step */
  dependsOn?: string[];
  /** Key to store the output under */
  outputAs?: string;
  /** Input mapping from previous outputs */
  inputMapping?: Record<string, string>;
  /** Timeout for this step in ms */
  timeout?: number;
  /** Whether to continue workflow if this step fails */
  continueOnError?: boolean;
  /** Retry configuration */
  retry?: {
    maxAttempts: number;
    delayMs?: number;
  };
}

export interface WorkflowInput {
  /** Input parameter name */
  name: string;
  /** Parameter type */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Description */
  description?: string;
  /** Whether this input is required */
  required?: boolean;
  /** Default value */
  default?: unknown;
}

export interface WorkflowSpec {
  /** Spec version */
  specVersion: '1.0';
  /** Workflow metadata */
  metadata: WorkflowSpecMetadata;
  /** Required agent specs (by ID) */
  agents: string[];
  /** Input schema */
  inputs?: WorkflowInput[];
  /** Workflow steps */
  steps: WorkflowStepSpec[];
  /** Output configuration */
  output?: {
    /** Step output to use as final output */
    from?: string;
    /** Template for final output */
    template?: string;
  };
}

// ============================================================================
// Agent Collection (for bundling multiple specs)
// ============================================================================

export interface AgentCollection {
  /** Collection version */
  specVersion: '1.0';
  /** Collection metadata */
  metadata: {
    name: string;
    description?: string;
    version?: string;
  };
  /** Agent specifications */
  agents: AgentSpec[];
  /** Workflow specifications */
  workflows?: WorkflowSpec[];
}

// ============================================================================
// Built-in Agent Templates
// ============================================================================

export const AGENT_TEMPLATES: Record<string, Partial<AgentSpec>> = {
  basic: {
    specVersion: '1.0',
    type: 'worker',
    behavior: {
      systemPrompt: 'You are a helpful assistant.',
      temperature: 0.7,
      maxToolCalls: 5,
    },
  },
  researcher: {
    specVersion: '1.0',
    type: 'worker',
    capabilities: {
      tools: ['web_search', 'web_fetch'],
      memory: {
        readScopes: ['shared', 'research'],
        writeScopes: ['research'],
      },
    },
    behavior: {
      systemPrompt: `You are a research assistant. Your job is to:
1. Search for relevant information
2. Analyze and synthesize findings
3. Provide well-sourced summaries

Always cite your sources and be thorough in your research.`,
      temperature: 0.5,
      maxToolCalls: 10,
    },
    routing: {
      patterns: ['research', 'find information', 'look up'],
      keywords: ['search', 'research', 'investigate', 'find'],
      priority: 5,
    },
  },
  coder: {
    specVersion: '1.0',
    type: 'worker',
    capabilities: {
      tools: ['file_read', 'file_write', 'run_code'],
      memory: {
        readScopes: ['shared', 'code'],
        writeScopes: ['code'],
      },
    },
    behavior: {
      systemPrompt: `You are a coding assistant. Your job is to:
1. Write clean, well-documented code
2. Debug and fix issues
3. Explain code concepts clearly

Follow best practices and coding standards.`,
      temperature: 0.3,
      maxToolCalls: 15,
      responseFormat: 'markdown',
    },
    routing: {
      patterns: ['write code', 'fix bug', 'implement'],
      keywords: ['code', 'program', 'function', 'debug', 'implement'],
      priority: 5,
    },
  },
  summarizer: {
    specVersion: '1.0',
    type: 'worker',
    behavior: {
      systemPrompt: `You are a summarization expert. Your job is to:
1. Extract key points from content
2. Create concise, accurate summaries
3. Maintain important context

Be concise but complete.`,
      temperature: 0.4,
      responseFormat: 'markdown',
    },
    routing: {
      patterns: ['summarize', 'tldr', 'key points'],
      keywords: ['summary', 'summarize', 'brief', 'overview'],
      priority: 3,
    },
  },
};

// ============================================================================
// Workflow Templates
// ============================================================================

export const WORKFLOW_TEMPLATES: Record<string, Partial<WorkflowSpec>> = {
  researchAndSummarize: {
    specVersion: '1.0',
    metadata: {
      id: 'research-and-summarize',
      name: 'Research and Summarize',
      description: 'Research a topic and provide a summary',
    },
    agents: ['researcher', 'summarizer'],
    inputs: [
      { name: 'topic', type: 'string', required: true, description: 'Topic to research' },
    ],
    steps: [
      {
        id: 'research',
        agent: 'researcher',
        task: 'Research the following topic thoroughly: {{topic}}',
        outputAs: 'research_results',
      },
      {
        id: 'summarize',
        agent: 'summarizer',
        task: 'Summarize the following research findings: {{research}}',
        dependsOn: ['research'],
        inputMapping: { research: 'research_results' },
        outputAs: 'summary',
      },
    ],
    output: {
      from: 'summary',
    },
  },
};
