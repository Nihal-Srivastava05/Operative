import { db, Knowledge } from '../../store/db';
import { EmbeddingService } from '../ai/EmbeddingService';
import { v4 as uuidv4 } from 'uuid';

export class KnowledgeService {
    private static instance: KnowledgeService;
    private embeddingService: EmbeddingService;

    private constructor() {
        this.embeddingService = EmbeddingService.getInstance();
    }

    public static getInstance(): KnowledgeService {
        if (!KnowledgeService.instance) {
            KnowledgeService.instance = new KnowledgeService();
        }
        return KnowledgeService.instance;
    }

    public async store(content: string, metadata?: any): Promise<string> {
        const embedding = await this.embeddingService.getEmbedding(content);
        const id = uuidv4();

        await db.knowledge.add({
            id,
            content,
            embedding,
            metadata,
            createdAt: Date.now()
        });

        return id;
    }

    public async search(query: string, limit: number = 5): Promise<Knowledge[]> {
        const queryEmbedding = await this.embeddingService.getEmbedding(query);
        const allKnowledge = await db.knowledge.toArray();

        // Cosine Similarity: (A . B) / (||A|| * ||B||)
        // Since we assume embeddings from Chrome AI are normalized (common for these APIs), 
        // we can just use Dot Product.
        const results = allKnowledge.map(k => {
            const similarity = this.cosineSimilarity(queryEmbedding, k.embedding);
            return { ...k, similarity };
        });

        return results
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
