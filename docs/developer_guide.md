# Developer Guide

This guide helps you set up the development environment and contribute to Operative.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Start Development Server**:
    Since this is a Chrome Extension, you typically build it rather than run a dev server for the extension part, but for UI development (if detached) you might use:
    ```bash
    npm run dev
    ```
    However, the primary workflow involves loading the built extension into Chrome.

3.  **Build Watch Mode**:
    To automatically rebuild on changes:
    ```bash
    npm run build -- --watch
    ```
    (Note: You may need to modify `package.json` to add a watch script if `vite build --watch` is supported by your config, or simply run `npm run build` manually).

## Running the MCP Demo Server

Operative includes a test server to demonstrate tool usage.

1.  **Start the Server**:
    ```bash
    npm run mcp:demo-server
    ```
    This starts a server at `http://127.0.0.1:3333`.

2.  **Server Capabilities**:
    - **SSE Endpoint**: `http://127.0.0.1:3333/sse`
    - **POST Endpoint**: `http://127.0.0.1:3333/message`
    - **Tools**:
        - `echo`: Returns the input text.
        - `get_time`: Returns the current ISO timestamp.

## Creating a New Agent

Agents are currently created dynamically via the UI and stored in IndexedDB.

### Steps to Create an Agent via UI

1.  Open the extension.
2.  Navigate to the **Agents** tab.
3.  Click the **+** (New Agent) button.
4.  **Name**: Give your agent a descriptive name (e.g., "Summarizer").
5.  **System Prompt**: Define the agent's persona and instructions.
    - Example: "You are a helpful assistant that summarizes text concisely."
6.  **Assigned Tool**: Select a tool if needed (requires a connected MCP server).
7.  Click **Save**.

### Programmatic Agent Definition (Future)

Currently, agents are user-defined. To add "builtin" agents, you would modify `src/store/db.ts` to seed the database or `src/services/orchestrator/Orchestrator.ts` to include default fallback agents.

## Debugging

- **Extension Console**: Right-click the extension popup > Inspect to view the console. This is where `console.log` from UI components and services (Orchestrator, McpClient) will appear.
- **Background Script**: Go to `chrome://extensions` > Operative > "service worker" to inspect the background script (if applicable, though this project currently seems to run logic in the popup context for the prototype).
- **MCP Server**: Check the terminal running `npm run mcp:demo-server` to see incoming requests and logs.

## Project Structure

- `src/components`: React UI components.
- `src/services`: Core business logic (AI, MCP, Orchestration).
- `src/store`: Database definition.
- `scripts`: Utility scripts (e.g., demo server).

## Adding New Tools

To add new tools, you need to extend the MCP server (or create a new one).

### Example: Adding a "Reverse String" Tool to `scripts/mcp-demo-server.mjs`

1.  Define the tool in the `tools` array:
    ```javascript
    {
      name: 'reverse_string',
      description: 'Reverses the provided string.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    ```

2.  Handle the tool call in the `tools/call` block:
    ```javascript
    if (name === 'reverse_string') {
      const reversed = (args?.text ?? '').split('').reverse().join('');
      broadcastMessage(
        jsonRpcResult(id, {
          result: reversed,
        }),
      )
      return
    }
    ```

3.  Restart the demo server.
