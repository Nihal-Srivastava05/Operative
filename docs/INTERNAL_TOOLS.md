# Internal Browser Tools Documentation

The Operative extension provides a set of built-in internal tools that agents can use to interact with the browser. These tools are powered by the Chrome Debugger API and allow for truly agentic behavior on any website.

## Overview

When you assign the **Internal Browser** tool source to an agent, it gains access to the following capabilities. Use these tools in your agent's system prompt or allow the orchestrator to route relevant tasks to them.

---

### 🌐 Navigation & DOM

#### `get_dom_snapshot`
- **Description**: Captures a simplified, JSON-serializable snapshot of the current page's DOM. 
- **Use Case**: Use this to help the agent "see" the content of the page, find links, buttons, or specific text.
- **Inputs**: None.

#### `navigate`
- **Description**: Navigates the current active tab to a specified URL.
- **Inputs**:
  - `url` (string, required): The destination URL (e.g., `https://google.com`).

---

### 🖱️ Interaction

#### `click_element`
- **Description**: Performs a mouse click on an element identified by a CSS selector.
- **Inputs**:
  - `selector` (string, required): The CSS selector of the element to click (e.g., `button#submit`, `.login-link`).

#### `type_input`
- **Description**: Types text into an input or textarea element. It also triggers `input` and `change` events to ensure website logic (like form validation) recognizes the entry.
- **Inputs**:
  - `selector` (string, required): The CSS selector of the input element.
  - `text` (string, required): The text to type into the field.

#### `execute_script`
- **Description**: Executes arbitrary JavaScript code within the context of the current page.
- **Use Case**: Advanced interactions, extracting specific data points not covered by the DOM snapshot, or triggering complex UI behaviors.
- **Inputs**:
  - `script` (string, required): The JavaScript code snippet to run.

---

### 🔍 Debugging & Monitoring

#### `get_console_logs`
- **Description**: Retrieves all console messages (logs, warnings, errors) captured since the agent attached to the page.
- **Use Case**: Checking for JavaScript errors, debugging site behavior, or reading debug logs printed by the site.
- **Inputs**: None.

#### `get_network_activity`
- **Description**: Retrieves a log of network requests and responses (URLs, methods, and status codes).
- **Use Case**: Monitoring API calls, checking if certain resources loaded successfully, or verifying web socket initiations.
- **Inputs**: None.

---

## Technical Note: The Debugger Bar
When an agent uses these tools, Chrome will display a notification bar at the top of the tab stating: `"Operative" is debugging this tab`. This is a security requirement of the Chrome Debugger API and is expected behavior.
