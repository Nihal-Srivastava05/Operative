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
        return (globalThis as any).ai?.languageModel;
    }

    public async getEmbedding(text: string): Promise<number[]> {
        try {
            // globalThis works in both browser pages and service workers (unlike window)
            const ai = (globalThis as any).ai;
            if (ai && ai.textEmbedding) {
                const embedder = await ai.textEmbedding.create();
                const result = await embedder.embed(text);
                return Array.from(result[0].embedding);
            }
        } catch (e) {
            console.warn("Chrome Text Embedding API unavailable, using fallback:", e);
        }

        // Fallback: character trigram frequency vector (128 dims).
        // Enables cosine-similarity ranking without the native API.
        // Quality is lower than neural embeddings but keeps the system functional.
        return this.trigramEmbedding(text);
    }

    /** Deterministic 128-dim trigram bag-of-words vector, L2-normalised. */
    private trigramEmbedding(text: string): number[] {
        const dims = 128;
        const vec = new Float32Array(dims);
        const lower = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        const padded = `  ${lower}  `;
        for (let i = 0; i < padded.length - 2; i++) {
            let h = 2166136261;
            for (let j = i; j < i + 3; j++) {
                h ^= padded.charCodeAt(j);
                h = (h * 16777619) >>> 0;
            }
            vec[h % dims] += 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm) || 1;
        return Array.from(vec).map(v => v / norm);
    }
}
