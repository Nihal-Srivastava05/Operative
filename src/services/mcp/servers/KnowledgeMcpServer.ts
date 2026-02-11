import { McpTool } from '../interfaces';
import { KnowledgeService } from '../../knowledge/KnowledgeService';

export class KnowledgeMcpServer {
    private knowledgeService: KnowledgeService;

    constructor() {
        this.knowledgeService = KnowledgeService.getInstance();
    }

    public async listTools(): Promise<McpTool[]> {
        return [
            {
                name: "store_knowledge",
                description: "Save information to the long-term knowledge base. Use this for facts, user preferences, or important context you want to remember forever.",
                inputSchema: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "The information to remember" },
                        category: { type: "string", description: "Optional category to group info" }
                    },
                    required: ["content"]
                }
            },
            {
                name: "recall_knowledge",
                description: "Search and retrieve relevant information from the knowledge base using semantic vector search.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query or question" },
                        limit: { type: "number", description: "Number of relevant results to return (default 5)" }
                    },
                    required: ["query"]
                }
            }
        ];
    }

    public async callTool(name: string, args: any): Promise<any> {
        switch (name) {
            case "store_knowledge":
                const id = await this.knowledgeService.store(args.content, { category: args.category });
                return { success: true, id, message: "Information securely stored in long-term memory." };

            case "recall_knowledge":
                const results = await this.knowledgeService.search(args.query, args.limit || 5);
                if (results.length === 0) {
                    return { results: [], message: "No relevant information found in knowledge base." };
                }
                const formatted = results.map((r: any) => ({
                    content: r.content,
                    similarity: Math.round(r.similarity! * 100) / 100,
                    storedAt: new Date(r.createdAt).toISOString()
                }));
                return { results: formatted };

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
}
