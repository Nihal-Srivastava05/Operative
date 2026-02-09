import { IMcpClient, McpTool } from './interfaces';
import { BrowserMcpServer } from './servers/BrowserMcpServer';

export class InternalMcpClient implements IMcpClient {
    private server: BrowserMcpServer;

    constructor() {
        this.server = new BrowserMcpServer();
    }

    async connect(): Promise<void> {
        // No-op for internal server, or maybe lazy init
        console.log("InternalMcpClient: connected (virtual)");
    }

    async listTools(): Promise<McpTool[]> {
        return this.server.listTools();
    }

    async callTool(name: string, args: any): Promise<any> {
        return this.server.callTool(name, args);
    }

    disconnect(): void {
        // Cleanup if needed
        console.log("InternalMcpClient: disconnected");
    }
}
