import { IMcpClient, McpTool } from './interfaces';

type McpClientOptions = {
    protocolVersion?: string;
    clientInfo?: { name: string; version: string };
    capabilities?: Record<string, any>;
    /** Timeout waiting for server to send the SSE `endpoint` event. */
    connectTimeoutMs?: number;
    /** Timeout for each JSON-RPC request (response delivered over SSE). */
    requestTimeoutMs?: number;
};

export class McpClient implements IMcpClient {
    private eventSource: EventSource | null = null;
    private postEndpoint: string | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

    private initialized = false;
    private options: Required<Pick<McpClientOptions, 'protocolVersion' | 'clientInfo' | 'capabilities' | 'connectTimeoutMs' | 'requestTimeoutMs'>>;

    constructor(private sseUrl: string, options?: McpClientOptions) {
        this.options = {
            protocolVersion: options?.protocolVersion ?? '2024-11-05',
            clientInfo: options?.clientInfo ?? { name: 'Operative', version: '1.0.0' },
            capabilities: options?.capabilities ?? {},
            connectTimeoutMs: options?.connectTimeoutMs ?? 10_000,
            requestTimeoutMs: options?.requestTimeoutMs ?? 20_000
        };
    }

    public async connect(): Promise<void> {
        if (this.eventSource) return;

        return new Promise((resolve, reject) => {
            const connectTimeout = globalThis.setTimeout(() => {
                try {
                    this.eventSource?.close();
                } catch { /* ignore */ }
                this.eventSource = null;
                reject(new Error(`Timed out waiting for MCP SSE endpoint event from ${this.sseUrl}. This is commonly caused by CORS/Origin restrictions on the server.`));
            }, this.options.connectTimeoutMs);

            this.eventSource = new EventSource(this.sseUrl);

            this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
                this.postEndpoint = event.data;
                // Depending on implementation, endpoint might be relative or absolute.
                // If relative, resolve against sseUrl
                try {
                    const url = new URL(this.postEndpoint!, this.sseUrl);
                    this.postEndpoint = url.toString();
                } catch (e) { /* ignore */ }

                console.log("MCP Endpoint received:", this.postEndpoint);
                globalThis.clearTimeout(connectTimeout);

                // Perform required MCP lifecycle handshake.
                this.initialize()
                    .then(() => resolve())
                    .catch(reject);
            });

            this.eventSource.addEventListener('message', (event: MessageEvent) => {
                try {
                    const data = JSON.parse(event.data);

                    // Some implementations might (incorrectly) send endpoint info as a message.
                    // Be tolerant.
                    if (!this.postEndpoint && typeof data?.endpoint === 'string') {
                        this.postEndpoint = data.endpoint;
                        try {
                            const url = new URL(this.postEndpoint!, this.sseUrl);
                            this.postEndpoint = url.toString();
                        } catch { /* ignore */ }
                        console.log("MCP Endpoint received (message fallback):", this.postEndpoint);
                        globalThis.clearTimeout(connectTimeout);
                        this.initialize().then(() => resolve()).catch(reject);
                        return;
                    }

                    this.handleMessage(data);
                } catch (e) {
                    console.warn("Failed to parse MCP SSE message event as JSON:", event.data);
                }
            });

            this.eventSource.onerror = (err) => {
                console.error("MCP Connection Error", err);
                // If we haven't resolved yet, reject
                if (!this.postEndpoint) {
                    globalThis.clearTimeout(connectTimeout);
                    reject(new Error(`Failed to connect to MCP SSE endpoint at ${this.sseUrl}. If this is running locally, ensure the server validates Origin correctly and allows your extension/page origin via CORS.`));
                }
            };

            // Timeout fallback?
        });
    }

    private async initialize(): Promise<void> {
        if (!this.postEndpoint) throw new Error("Not connected");
        if (this.initialized) return;

        const initParams = {
            protocolVersion: this.options.protocolVersion,
            capabilities: this.options.capabilities,
            clientInfo: this.options.clientInfo
        };

        const res = await this.send("initialize", initParams, { allowBeforeInitialized: true });
        // Basic sanity: accept any result, but track negotiated protocol version.
        if (res?.protocolVersion && typeof res.protocolVersion === 'string') {
            // If server responds with a version we don't support, caller should disconnect.
            if (res.protocolVersion !== this.options.protocolVersion) {
                console.warn(`MCP server negotiated protocolVersion=${res.protocolVersion} (client requested ${this.options.protocolVersion})`);
            }
        }

        // Required notification after successful initialization
        await this.notify("notifications/initialized");
        this.initialized = true;
    }

    private handleMessage(data: any) {
        if (data.id !== undefined && this.pendingRequests.has(data.id)) {
            const { resolve, reject } = this.pendingRequests.get(data.id)!;
            if (data.error) {
                reject(data.error);
            } else {
                resolve(data.result);
            }
            this.pendingRequests.delete(data.id);
        }
        // Handle notifications if needed
    }

    private async notify(method: string, params?: any): Promise<void> {
        if (!this.postEndpoint) throw new Error("Not connected");

        const jsonRpc = {
            jsonrpc: "2.0",
            method,
            params
        };

        const res = await fetch(this.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jsonRpc)
        });

        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`MCP notify failed: HTTP ${res.status}${txt ? `: ${txt}` : ""}`);
        }
    }

    private async send(method: string, params?: any, opts?: { allowBeforeInitialized?: boolean }): Promise<any> {
        if (!this.postEndpoint) throw new Error("Not connected");
        if (!this.initialized && !opts?.allowBeforeInitialized && method !== "ping") {
            throw new Error(`MCP client not initialized yet; refusing to send '${method}'.`);
        }

        const id = this.requestId++;
        const jsonRpc = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const p = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            timeoutHandle = globalThis.setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`MCP request timed out after ${this.options.requestTimeoutMs}ms: ${method}`));
                }
            }, this.options.requestTimeoutMs);
        }).finally(() => {
            if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
        });

        try {
            const res = await fetch(this.postEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonRpc)
            });

            if (!res.ok) {
                const txt = await res.text().catch(() => "");
                throw new Error(`MCP request failed: HTTP ${res.status}${txt ? `: ${txt}` : ""}`);
            }
        } catch (e) {
            this.pendingRequests.delete(id);
            if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
            throw e;
        }

        return p;
    }

    public async listTools(): Promise<McpTool[]> {
        const res = await this.send("tools/list");
        return res.tools || [];
    }

    public async callTool(name: string, args: any): Promise<any> {
        const res = await this.send("tools/call", {
            name,
            arguments: args
        });
        return res;
    }

    public disconnect() {
        this.eventSource?.close();
        this.eventSource = null;
        this.postEndpoint = null;
        this.initialized = false;
        this.pendingRequests.clear();
    }
}
