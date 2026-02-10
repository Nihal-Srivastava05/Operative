export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
}

export interface IMcpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: any): Promise<any>;
  disconnect(): void;
}
