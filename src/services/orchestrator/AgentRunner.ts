import { ChromeAIService } from '../ai/ChromeAIService';
import { Agent } from '../../store/db';
import { IMcpClient } from '../mcp/interfaces';
import { extractJson } from '../../utils/jsonUtils';

export class AgentRunner {
    private ai: ChromeAIService;

    constructor() {
        this.ai = ChromeAIService.getInstance();
    }

    private async constructSystemPrompt(agent: Agent, tools: any[]): Promise<string> {
        let prompt = "";

        if (tools.length > 0) {
            const toolNames = tools.map(t => t?.name).filter(Boolean);
            const toolNameLine = toolNames.length > 0 ? toolNames.join(", ") : "(unknown)";

            prompt += "=== TOOL USE POLICY (HIGH PRIORITY) ===\n";
            prompt += "- If the user asks for information and a tool can fetch it, you MUST call the tool.\n";
            prompt += "- Do NOT ask the user to copy/paste data (logs, DOM, network) if a relevant tool exists.\n";
            prompt += "- If you need more context, fetch it with tools first, then answer.\n";
            prompt += "- When you decide to use a tool, output ONLY the tool-call JSON (no other text).\n\n";
            prompt += `You have access to these tool(s): ${toolNameLine}\n`;
            prompt += "If any instruction below conflicts with this TOOL USE POLICY, follow the TOOL USE POLICY.\n\n";
        }

        prompt += "=== AGENT ROLE ===\n";
        prompt += agent.systemPrompt + "\n";

        if (tools.length > 0) {
            // Compact tool listing — full JSON.stringify of many tools overflows Gemini Nano's context.
            prompt += "\n=== AVAILABLE TOOLS ===\n";
            for (const t of tools) {
                const props = t.inputSchema?.properties ?? {};
                const required: string[] = t.inputSchema?.required ?? [];
                const params = Object.entries(props)
                    .map(([k, v]: [string, any]) => {
                        const type = v.type ?? 'any';
                        return required.includes(k) ? `${k}: ${type}` : `${k}?: ${type}`;
                    })
                    .join(', ');
                prompt += `• ${t.name}(${params})\n  ${t.description}\n`;
            }

            prompt += "\n=== HOW TO USE TOOLS ===\n";
            prompt += `Output ONLY this JSON to call a tool: {"tool":"TOOL_NAME","arguments":{...}}\n`;
            prompt += `"tool" must be exactly one of: ${tools.map(t => t.name).join(", ")}\n`;
            prompt += `Required args must be included. Optional args may be omitted.\n`;
            prompt += `Example: {"tool":"navigate","arguments":{"url":"https://youtube.com"}}\n`;
        }

        return prompt;
    }

    private extractToolCall(response: string): { tool: string; args: any } | null {
        // Normal model output is often conversational; avoid spamming warnings here.
        const potentialJson = extractJson(response, { logFailure: false });
        if (!potentialJson || typeof potentialJson !== 'object') return null;

        // Common nested wrapper:
        // { tool_call: { tool_name: "type_input", ... } }
        const wrapper: any = (potentialJson as any).tool_call;
        if (wrapper && typeof wrapper === 'object') {
            const toolName =
                typeof wrapper.tool === 'string'
                    ? wrapper.tool
                    : typeof wrapper.tool_name === 'string'
                        ? wrapper.tool_name
                        : typeof wrapper.toolName === 'string'
                            ? wrapper.toolName
                            : typeof wrapper.name === 'string'
                                ? wrapper.name
                                : null;

            const argsObj = wrapper.arguments ?? wrapper.args ?? wrapper.params ?? wrapper.input ?? null;
            if (toolName) {
                const liftedArgs = argsObj && typeof argsObj === 'object' ? argsObj : {};
                return { tool: toolName, args: liftedArgs };
            }
        }

        // Primary expected shape:
        // { tool: string, arguments?: object }
        // Tolerate some common variants: tool_call / toolCall, and top-level args.
        const tool =
            typeof potentialJson.tool === 'string'
                ? potentialJson.tool
                : typeof (potentialJson as any).tool_call === 'string'
                    ? (potentialJson as any).tool_call
                    : typeof (potentialJson as any).toolCall === 'string'
                        ? (potentialJson as any).toolCall
                : typeof potentialJson.toolName === 'string'
                    ? potentialJson.toolName
                    : typeof potentialJson.name === 'string'
                        ? potentialJson.name
                        : null;

        if (!tool) return null;

        let args =
            potentialJson.arguments ??
            potentialJson.args ??
            potentialJson.params ??
            null;

        // If args weren't nested, lift top-level fields into arguments.
        if (!args || typeof args !== 'object') {
            const copy: any = { ...(potentialJson as any) };
            delete copy.tool;
            delete copy.tool_call;
            delete copy.toolCall;
            delete copy.toolName;
            delete copy.name;
            delete copy.arguments;
            delete copy.args;
            delete copy.params;
            args = copy;
        }

        // Common "browser/action" dialect:
        // { tool: "browser", action: "navigate", url: "..." }
        // Canonicalize to: { tool: "navigate", arguments: { url: "..." } }
        if (typeof tool === 'string' && tool.toLowerCase() === 'browser' && args && typeof (args as any).action === 'string') {
            const action = String((args as any).action);
            delete (args as any).action;
            return { tool: action, args };
        }

        return { tool, args };
    }

    private normalizeToolName(tool: string, allowedToolNames: Set<string>): string {
        if (allowedToolNames.has(tool)) return tool;
        const t = tool.toLowerCase();
        const aliases: Record<string, string> = {
            navigate_to_url: 'navigate',
            navigateToUrl: 'navigate',
            open_url: 'navigate',
            openUrl: 'navigate',
            go_to_url: 'navigate',
            goToUrl: 'navigate'
        };
        const mapped = aliases[t] ?? aliases[tool] ?? null;
        if (mapped && allowedToolNames.has(mapped)) return mapped;
        return tool;
    }

    private normalizeToolArgs(toolName: string, args: any): any {
        const a: any = args && typeof args === 'object' ? { ...args } : {};

        // Generic lifts
        if (a.input && typeof a.input === 'string' && a.text === undefined) {
            a.text = a.input;
            delete a.input;
        }
        if (a.query && typeof a.query === 'string' && a.text === undefined) {
            a.text = a.query;
            delete a.query;
        }
        if (a.value && typeof a.value === 'string' && a.text === undefined) {
            a.text = a.value;
            delete a.value;
        }

        // Tool-specific fixes
        if (toolName === 'type_input') {
            if (!a.selector && a.input && typeof a.input === 'object' && typeof a.input.selector === 'string') {
                a.selector = a.input.selector;
            }
        }

        if (toolName === 'navigate' && typeof a.url === 'string') {
            const u = a.url.trim();
            if (u && !u.startsWith('http://') && !u.startsWith('https://')) {
                a.url = `https://${u}`;
            }
        }

        return a;
    }

    private missingRequiredArgs(toolSchema: any, args: any): string[] {
        const required: string[] = Array.isArray(toolSchema?.inputSchema?.required) ? toolSchema.inputSchema.required : [];
        if (required.length === 0) return [];
        const a: any = args && typeof args === 'object' ? args : {};
        return required.filter(k => a[k] === undefined || a[k] === null || (typeof a[k] === 'string' && a[k].trim() === ''));
    }

    public async run(agent: Agent, task: string, mcpClients: Map<string, IMcpClient>): Promise<string> {
        // 1. Gather tools
        let tools: any[] = [];
        let toolSchema: any | null = null; // used only in single-tool mode for upfront validation
        if (agent.assignedTool) {
            const client = mcpClients.get(agent.assignedTool.serverId);
            if (!client) {
                return `Tool server "${agent.assignedTool.serverId}" is not connected. Please reassign the tool or reconnect the MCP server in Settings.`;
            }
            try {
                const serverTools = await client.listTools();
                if (agent.assignedTool.toolName) {
                    // Single-tool mode
                    const t = serverTools.find(t => t.name === agent.assignedTool!.toolName);
                    if (!t) {
                        const available = serverTools.map(st => st.name).slice(0, 15).join(", ");
                        return `Tool "${agent.assignedTool.toolName}" was not found on server "${agent.assignedTool.serverId}". Available tools: ${available}${serverTools.length > 15 ? ", ..." : ""}`;
                    }
                    tools.push(t);
                    toolSchema = t;
                } else {
                    // All-tools-from-server mode
                    tools = serverTools;
                }
            } catch (e) {
                console.error("Failed to fetch tools", e);
                return `Failed to fetch tools from server "${agent.assignedTool.serverId}". Error: ${String(e)}`;
            }
        }

        // 2. Create Session
        const systemPrompt = await this.constructSystemPrompt(agent, tools);
        const session = await this.ai.createSession(
            tools.length > 0
                ? { systemPrompt, language: 'en', temperature: 0.0, topK: 1 }
                : { systemPrompt, language: 'en' }
        );

        console.log(`[${agent.name}] Starting execution with task: ${task.substring(0, 100)}...`);

        // 3. Prompt
        const initialPrompt =
            tools.length > 0
                ? `User request: ${task}\n\nIf a tool can help, output ONLY the JSON tool call. Otherwise, answer normally.`
                : task;
        let response = await this.ai.generate(initialPrompt, session);
        let maxTurns = 6;
        let currentTurn = 0;
        let nudged = false;

        // 4. Check for Tool Call (Basic JSON detection)
        let lastSuccessfulToolResult: any = null;
        while (currentTurn < maxTurns) {
            try {
                const toolCall = this.extractToolCall(response);
                if (toolCall) {
                    const allowed = new Set(tools.map(t => t.name));
                    const normalizedTool = this.normalizeToolName(toolCall.tool, allowed);
                    console.log(`[${agent.name}] Tool call detected:`, toolCall.tool, normalizedTool !== toolCall.tool ? `(normalized to ${normalizedTool})` : "");

                    if (agent.assignedTool && mcpClients.has(agent.assignedTool.serverId)) {
                        try {
                            const client = mcpClients.get(agent.assignedTool.serverId)!;
                            if (!allowed.has(normalizedTool)) {
                                response = await this.ai.generate(
                                    `Invalid tool name "${toolCall.tool}". You MUST call exactly one of: ${Array.from(allowed).join(", ")}.\n` +
                                    `Output ONLY JSON in the form {"tool":"<EXACT_TOOL_NAME>","arguments":{...}}.\n\n` +
                                    `User request: ${task}\n\nJSON:`,
                                    session
                                );
                                currentTurn++;
                                continue;
                            }

                            const args = this.normalizeToolArgs(normalizedTool, toolCall.args);

                            // Validate required args — look up schema by name so multi-tool mode works too
                            const activeSchema = toolSchema?.name === normalizedTool
                                ? toolSchema
                                : (tools.find(t => t.name === normalizedTool) ?? null);
                            if (activeSchema) {
                                const missing = this.missingRequiredArgs(activeSchema, args);
                                if (missing.length > 0) {
                                    response = await this.ai.generate(
                                        `Your tool call arguments are missing required field(s): ${missing.join(", ")}.\n` +
                                        `Tool: ${normalizedTool}\n` +
                                        `You MUST output ONLY corrected JSON: {"tool":"${normalizedTool}","arguments":{...}}.\n` +
                                        `Reminder: required fields are: ${(activeSchema.inputSchema?.required ?? []).join(", ")}\n\n` +
                                        `User request: ${task}\n\nJSON:`,
                                        session
                                    );
                                    currentTurn++;
                                    continue;
                                }
                            }

                            console.log(`[${agent.name}] Executing tool '${normalizedTool}' with args:`, args);
                            const result = await client.callTool(normalizedTool, args);
                            lastSuccessfulToolResult = result;
                            console.log(`[${agent.name}] Tool output received, generating follow-up...`);

                            // If the tool returned a ready-made user-facing message (e.g. recommend_video,
                            // store_knowledge), use it directly — don't re-prompt the model, which
                            // often causes it to chain another tool call instead of answering.
                            if (typeof result?.message === 'string' && result.message.length > 10) {
                                response = result.message;
                                break;
                            }

                            // Otherwise feed the result back and ask for a plain-English summary.
                            const toolOutput =
                                `Tool '${normalizedTool}' result:\n${JSON.stringify(result, null, 2)}\n\n` +
                                `Write a plain-English response to the user. Include any URL or title from the result. ` +
                                `Do NOT output JSON or call another tool.`;
                            response = await this.ai.generate(toolOutput, session);
                            currentTurn++;
                            continue;
                        } catch (toolError: any) {
                            console.error(`[${agent.name}] Tool execution failed:`, toolError);
                            const errorMsg = toolError?.message || String(toolError);
                            response = await this.ai.generate(`Error executing tool '${normalizedTool}': ${errorMsg}. Please try a different approach or fix the arguments.`, session);
                            currentTurn++;
                            continue;
                        }
                    } else {
                        console.warn(`[${agent.name}] Tool call detected but server not found or mapping missing.`);
                        response += "\nError: Tool execution failed (Tool source not found).";
                        break;
                    }
                }
            } catch (e) {
                console.error("Unexpected error in tool execution loop:", e);
            }

            // If tools are available but the model answered conversationally, nudge once with a stricter reminder.
            if (tools.length > 0 && !nudged) {
                nudged = true;
                response = await this.ai.generate(
                    `Reminder: If the user request requires a tool, you MUST output ONLY the JSON tool call. Do not explain limitations.\n\nUser request: ${task}\n\nJSON:`,
                    session
                );
                currentTurn++;
                continue;
            }
            break;
        }

        if (currentTurn >= maxTurns) {
            // If the model got stuck outputting JSON, surface the last tool result instead.
            const stuckOnJson = this.extractToolCall(response) !== null;
            if (stuckOnJson && typeof lastSuccessfulToolResult?.message === 'string') {
                response = lastSuccessfulToolResult.message;
            } else if (stuckOnJson) {
                response = lastSuccessfulToolResult
                    ? `Task completed. Result: ${JSON.stringify(lastSuccessfulToolResult)}`
                    : "I wasn't able to complete the task — please try again.";
            }
        }

        try {
            session.destroy();
        } catch (e) { /* ignore */ }

        console.log(`[${agent.name}] Completed. Response length: ${response.length} chars`);
        return response;
    }
}
