# Architecture Overview

This document describes the high-level architecture of Operative.

## Core Components

### 1. Orchestrator (`src/services/orchestrator/Orchestrator.ts`)
The `Orchestrator` is the central component responsible for managing the lifecycle of agents and routing user requests.

- **Role**: Coordinates interactions between users, AI agents, and tools.
- **Responsibilities**:
    - **Agent Management**: Retrieves and filters active agents from the database (`src/store/db.ts`).
    - **Intelligent Routing**: Uses the AI model to analyze the user's message and select the most appropriate agent based on their system prompt and capabilities. It also implements keyword and fuzzy matching fallbacks.
    - **Tool Discovery**: Manages connections to Model Context Protocol (MCP) servers and exposes available tools.

### 2. Agent Runner (`src/services/orchestrator/AgentRunner.ts`)
The `AgentRunner` executes the logic for a specific agent once it has been selected by the Orchestrator.

- **Role**: Executes the agent's task loop.
- **Process**:
    1.  Constructs a system prompt that includes the agent's specific instructions and available tools.
    2.  Prompts the AI model with the user's task.
    3.  **Tool Execution Loop**: Detects if the model wants to call a tool (via JSON output), executes the tool via `McpClient`, feeds the result back to the model, and repeats until a final answer is generated or a turn limit is reached.

### 3. MCP Client (`src/services/mcp/McpClient.ts`)
The `McpClient` handles communication with external tools using the Model Context Protocol.

- **Role**: Client-side implementation of MCP over Server-Sent Events (SSE).
- **Features**:
    - **SSE Connection**: Establishes a persistent connection to receive server-sent events.
    - **JSON-RPC**: Sends requests (like `tools/list` or `tools/call`) via HTTP POST and receives responses asynchronously.
    - **Lifecycle Management**: Handles initialization and capabilities negotiation with the MCP server.

### 4. Chrome AI Service (`src/services/ai/ChromeAIService.ts`)
The `ChromeAIService` provides an abstraction layer over the browser's built-in AI capabilities.

- **Role**: Interface to `window.ai.languageModel`.
- **Features**:
    - **Session Management**: Creates and manages AI sessions with specific configuration (temperature, topK).
    - **Availability Check**: Verifies if the browser supports the necessary AI APIs.
    - **Prompting**: Handles both standard and streaming generation requests.

### 5. Storage (`src/store/db.ts`)
Operative uses `Dexie.js` (a wrapper for IndexedDB) to persist agent configurations and settings locally within the browser extension.

## Data Flow

1.  **User Input**: The user enters a message in the Chat interface.
2.  **Orchestrator Routing**: The Orchestrator evaluates the message against available agents.
3.  **Agent Selection**: The best-matching agent is selected (e.g., "Timekeeper" for time-related queries).
4.  **Tool Execution (Optional)**: If the agent needs external data (e.g., current time), it requests a tool execution. The `AgentRunner` facilitates this via the `McpClient`.
5.  **Response Generation**: The agent processes the tool output (if any) and generates a final response for the user.
