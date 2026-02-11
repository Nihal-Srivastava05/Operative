export class EmbeddingService {
    private static instance: EmbeddingService;

    private constructor() { }

    public static getInstance(): EmbeddingService {
        if (!EmbeddingService.instance) {
            EmbeddingService.instance = new EmbeddingService();
        }
        return EmbeddingService.instance;
    }

    private getFactory(): any {
        if (typeof window !== 'undefined' && (window as any).ai && (window as any).ai.writer) {
            // Currently Chrome's AI APIs are evolving. The embedding API is often window.ai.textEmbedding
        }
        return (window as any).ai?.languageModel;
    }

    public async getEmbedding(text: string): Promise<number[]> {
        try {
            // Check for the specific feature flag enabled API
            const ai = (window as any).ai;
            if (ai && ai.textEmbedding) {
                const embedder = await ai.textEmbedding.create();
                const result = await embedder.embed(text);
                return Array.from(result[0].embedding);
            }

            // Fallback: If no native embedding, we could use a very simple hash-based vector 
            // for demonstration, but let's assume the user has the flags enabled as they asked for "robust".
            // If it's missing, we'll throw a clear error.
            throw new Error("Chrome Text Embedding API not found. Please enable 'Prompt API for Gemini Nano' and 'Text Embedding API' flags in chrome://flags.");
        } catch (e) {
            console.error("Embedding failed", e);
            throw e;
        }
    }
}
