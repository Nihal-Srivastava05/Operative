# Architecture Overview

This document describes the high-level architecture of Operative, focusing on its advanced agent orchestration capabilities.

## Meta Orchestrator System

Operative implements a multi-level "Meta Orchestrator" system that allows for complex, hierarchical agent interaction and automated task decomposition.

### 1. Orchestrator (`src/services/orchestrator/Orchestrator.ts`)
The `Orchestrator` is the central brain of the system. It manages the lifecycle of agents and routes user requests through a hierarchical structure.

- **Role**: Coordinates interactions between users, AI agents, and tools.
- **Hierarchical Routing**: 
    - Agents can be either **Workers** (execute specific tasks) or **Orchestrators** (route to other agents).
    - The root orchestrator identifies "Root Candidates" (top-level agents).
    - If a task is assigned to an orchestrator agent, that agent recursively routes the task to its own child agents.
- **Tool Discovery**: Manages connections to Model Context Protocol (MCP) servers.

### 2. Task Decomposition (`src/services/orchestrator/TaskDecomposer.ts` & `TaskQueue.ts`)
For complex requests, the system can automatically break down a single user message into a sequence of subtasks.

- **TaskDecomposer**: Uses AI to analyze the complexity of a request. If it requires multiple steps, it generates a "Task Plan" consisting of ordered subtasks.
- **Agent Assignment**: Each subtask in a plan is intelligently assigned to the most appropriate enabled worker.
- **TaskQueue**: Manages the execution of the Task Plan, ensuring tasks are run in the correct order based on dependencies.
- **Result Aggregation**: Once all subtasks in a plan are complete, the Orchestrator aggregates the individual outputs into a single, cohesive response.

### 3. Agent Runner (`src/services/orchestrator/AgentRunner.ts`)
The `AgentRunner` executes the logic for a specific worker agent.

- **Role**: Executes the agent's task loop.
- **Tool Execution Loop**: Detects if the model wants to call a tool, executes it via `McpClient`, and feeds the result back until a final answer is generated.

### 4. MCP Client (`src/services/mcp/McpClient.ts`)
Handles communication with external tools using the Model Context Protocol. Supports standard SSE-based servers and internal browser-native tools.

### 5. Chrome AI Service (`src/services/ai/ChromeAIService.ts`)
Abstraction layer for `window.ai.languageModel`, handling session management, capability detection, and generation.

### 6. Storage (`src/store/db.ts`)
Uses `Dexie.js` (IndexedDB) to persist agent configurations, hierarchy relationships (parentId), and task history.

## Data Flow

1.  **User Input**: User enters a message.
2.  **Complexity Analysis**: `TaskDecomposer` evaluates if the message needs decomposition.
3.  **Path A: Decomposition (Complex Tasks)**:
    - AI generates a plan of subtasks.
    - Each subtask is queued in `TaskQueue`.
    - `Orchestrator` executes each subtask sequentially using the assigned `AgentRunner`.
    - Results are aggregated.
4.  **Path B: Direct Routing (Simple Tasks)**:
    - Root Orchestrator picks a candidate.
    - If it's a Worker, it runs immediately.
    - If it's an Orchestrator, it routes among its children recursively until a Worker is reached.
5.  **Response**: The final answer or aggregated result is displayed to the user.
