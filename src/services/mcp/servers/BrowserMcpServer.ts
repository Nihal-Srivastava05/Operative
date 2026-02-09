import { McpTool } from '../interfaces';

export class BrowserMcpServer {
    private attachedDebuggee: chrome.debugger.Debuggee | null = null;
    private networkLog: string[] = [];
    private consoleLog: string[] = [];
    private isAttaching = false;

    constructor() {
        // Listen for detach events to cleanup
        chrome.debugger.onDetach.addListener(this.onDetach.bind(this));
    }

    private onDetach(source: chrome.debugger.Debuggee, reason: string) {
        if (this.attachedDebuggee && source.tabId === this.attachedDebuggee.tabId) {
            console.log("Debugger detached:", reason);
            this.attachedDebuggee = null;
            this.networkLog = [];
            this.consoleLog = [];
        }
    }

    private async attachToActiveTab(): Promise<chrome.debugger.Debuggee> {
        if (this.attachedDebuggee) {
            // Check if still valid (tab might have been closed)
            try {
                const tab = await chrome.tabs.get(this.attachedDebuggee.tabId!);
                if (tab) return this.attachedDebuggee;
            } catch {
                this.attachedDebuggee = null;
            }
        }

        if (this.isAttaching) throw new Error("Already attaching to debugger");

        this.isAttaching = true;
        try {
            // We want the primary tab, not the side panel or other utility windows.
            // When the side panel is active, 'active' tab in 'currentWindow' should be the content tab.
            const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (tabs.length === 0 || !tabs[0].id) {
                // Try fallback to just active in any window
                const allActive = await chrome.tabs.query({ active: true });
                if (allActive.length === 0 || !allActive[0].id) {
                    throw new Error("No active tab found to attach debugger to.");
                }
                tabs[0] = allActive[0];
            }

            const debuggee = { tabId: tabs[0].id };
            console.log(`[BrowserMcp] Attaching to tab ${tabs[0].id}: ${tabs[0].url}`);

            await chrome.debugger.attach(debuggee, "1.3");
            this.attachedDebuggee = debuggee;

            // Enable domains
            await Promise.all([
                chrome.debugger.sendCommand(debuggee, "Network.enable"),
                chrome.debugger.sendCommand(debuggee, "Console.enable"),
                chrome.debugger.sendCommand(debuggee, "DOM.enable"),
                chrome.debugger.sendCommand(debuggee, "Page.enable"),
                chrome.debugger.sendCommand(debuggee, "Runtime.enable")
            ]).catch(e => console.warn("[BrowserMcp] Error enabling domains, continuing anyway:", e));

            // Set up listeners
            chrome.debugger.onEvent.addListener(this.onDebuggerEvent.bind(this));

            return debuggee;
        } catch (e: any) {
            console.error("[BrowserMcp] Attachment failed:", e);
            throw new Error(`Failed to attach to browser tab: ${e.message || String(e)}`);
        } finally {
            this.isAttaching = false;
        }
    }

    private onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params: any) {
        if (this.attachedDebuggee && source.tabId === this.attachedDebuggee.tabId) {
            if (method === "Console.messageAdded") {
                this.consoleLog.push(`[${params.message.level}] ${params.message.text}`);
            } else if (method === "Network.requestWillBeSent") {
                this.networkLog.push(`[REQ] ${params.request.method} ${params.request.url}`);
            } else if (method === "Network.responseReceived") {
                this.networkLog.push(`[RES] ${params.response.status} ${params.response.url}`);
            }
        }
    }

    public async listTools(): Promise<McpTool[]> {
        return [
            {
                name: "get_dom_snapshot",
                description: "Get a simplified snapshot of the current page DOM to understand content and structure.",
                inputSchema: {
                    type: "object",
                    properties: {},
                }
            },
            {
                name: "click_element",
                description: "Click an element on the page using a CSS selector.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of the element to click" }
                    },
                    required: ["selector"]
                }
            },
            {
                name: "type_input",
                description: "Type text into an input element.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of the input element" },
                        text: { type: "string", description: "Text to type" }
                    },
                    required: ["selector", "text"]
                }
            },
            {
                name: "execute_script",
                description: "Execute arbitrary JavaScript in the page context.",
                inputSchema: {
                    type: "object",
                    properties: {
                        script: { type: "string", description: "JavaScript code to execute" }
                    },
                    required: ["script"]
                }
            },
            {
                name: "get_console_logs",
                description: "Get captured console logs from the page.",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "get_network_activity",
                description: "Get captured network activity (requests and responses).",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "navigate",
                description: "Navigate current tab to a new URL",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to navigate to" }
                    },
                    required: ["url"]
                }
            }
        ];
    }

    public async callTool(name: string, args: any): Promise<any> {
        // Special case: Navigate doesn't STRICTLY need the debugger attached to the current tab
        // in fact, if we are on a chrome:// page, we can't attach, but we want to be able to navigate away!
        if (name === "navigate") {
            const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const tabId = tabs[0]?.id;
            if (tabId) {
                console.log(`[BrowserMcp] Navigating tab ${tabId} to: ${args.url}`);
                await chrome.tabs.update(tabId, { url: args.url });
                return { result: "Navigation started to " + args.url };
            } else {
                // Fallback: create new tab
                const newTab = await chrome.tabs.create({ url: args.url });
                return { result: "Created new tab and navigating to " + args.url };
            }
        }

        const debuggee = await this.attachToActiveTab();

        switch (name) {
            case "get_dom_snapshot":
                // Using a script to get a clean simplified DOM
                const snapshotScript = `
                    (function() {
                        function simplify(node) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const val = node.nodeValue.trim();
                                return val ? val : null;
                            }
                            if (node.nodeType !== Node.ELEMENT_NODE) return null;
                            
                            // Skip hidden elements (basic)
                            const style = window.getComputedStyle(node);
                             if (style.display === 'none' || style.visibility === 'hidden') return null;

                            const el = {
                                tag: node.tagName.toLowerCase(),
                                id: node.id || undefined,
                                class: node.className || undefined,
                                text: undefined as string | undefined,
                                children: [] as any[]
                            };
                            
                            // Accessibility / Input interest
                            if (node.tagName === 'A') el['href'] = node.href;
                            if (node.tagName === 'INPUT') {
                                el['type'] = node.type;
                                el['placeholder'] = node.placeholder;
                                el['value'] = node.value;
                            }
                            if (node.tagName === 'BUTTON') el['type'] = node.type || 'button';

                            // Recursion
                            let hasContent = false;
                            for (let child of node.childNodes) {
                                const s = simplify(child);
                                if (s) {
                                    if (typeof s === 'string') {
                                         // rudimentary text collection
                                         if(!el.text) el.text = "";
                                         el.text += s + " ";
                                         hasContent = true;
                                    } else {
                                        el.children.push(s);
                                        hasContent = true;
                                    }
                                }
                            }
                            
                            // Pruning empty containers that aren't inputs/images
                            const isVoid = ['input','img','br','hr'].includes(el.tag);
                            if (!hasContent && !isVoid && !el.id) return null; // basic pruning

                            if (el.text) el.text = el.text.trim();
                            if (el.children.length === 0) delete el.children;
                            
                            return el;
                        }
                        return JSON.stringify(simplify(document.body));
                    })()
                 `;
                const res = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: snapshotScript, returnByValue: true }) as any;
                if (res?.result?.value) {
                    return { dom: JSON.parse(res.result.value) };
                }
                return { error: "Failed to snapshot DOM" };

            case "click_element":
                const clickScript = `
                    (function() {
                        const el = document.querySelector('${args.selector}');
                        if (el) {
                            el.click();
                            return "Clicked " + '${args.selector}';
                        }
                        return "Element not found: " + '${args.selector}';
                    })()
                `;
                const clickRes = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: clickScript, returnByValue: true }) as any;
                return { result: clickRes?.result?.value };

            case "type_input":
                const typeScript = `
                    (function() {
                        const el = document.querySelector('${args.selector}');
                        if (el) {
                            el.value = '${args.text}';
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                             return "Typed into " + '${args.selector}';
                        }
                         return "Element not found: " + '${args.selector}';
                    })()
                `;
                const typeRes = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: typeScript, returnByValue: true }) as any;
                return { result: typeRes?.result?.value };

            case "execute_script":
                const execRes = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: args.script, returnByValue: true }) as any;
                return { result: execRes?.result?.value, serialization: execRes?.result };

            case "get_console_logs":
                const logs = [...this.consoleLog];
                // Optional: clear after reading? Or keep history? Let's keep for now, or maybe clear to avoid duplicates if polled.
                // For this MVP, let's just return all.
                return { logs };

            case "get_network_activity":
                return { network: this.networkLog };

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
}
