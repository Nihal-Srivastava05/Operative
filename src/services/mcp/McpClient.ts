import { v4 as uuidv4 } from 'uuid';

export interface McpTool {
    name: string;
    description?: string;
    inputSchema: any;
}

export class McpClient {
    private eventSource: EventSource | null = null;
    private postEndpoint: string | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

    constructor(private sseUrl: string) { }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
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
                resolve();
            });

            this.eventSource.addEventListener('message', (event: MessageEvent) => {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            });

            this.eventSource.onerror = (err) => {
                console.error("MCP Connection Error", err);
                // If we haven't resolved yet, reject
                if (!this.postEndpoint) reject(err);
            };

            // Timeout fallback?
        });
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

    private async send(method: string, params?: any): Promise<any> {
        if (!this.postEndpoint) throw new Error("Not connected");

        const id = this.requestId++;
        const jsonRpc = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };

        const p = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
        });

        try {
            const res = await fetch(this.postEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonRpc)
            });

            if (!res.ok) {
                throw new Error(`HTTP Error ${res.status}`);
            }
        } catch (e) {
            this.pendingRequests.delete(id);
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
    }
}
