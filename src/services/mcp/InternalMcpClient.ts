import { IMcpClient, McpTool } from './interfaces';
import { BrowserMcpServer } from './servers/BrowserMcpServer';

export class InternalMcpClient implements IMcpClient {
    private server: any;

    constructor(server: any) {
        this.server = server;
    }

    async connect(): Promise<void> {
        console.log("InternalMcpClient: connected (virtual)");
    }

    async listTools(): Promise<McpTool[]> {
        return this.server.listTools();
    }

    async callTool(name: string, args: any): Promise<any> {
        return this.server.callTool(name, args);
    }

    disconnect(): void {
        console.log("InternalMcpClient: disconnected");
    }
}
