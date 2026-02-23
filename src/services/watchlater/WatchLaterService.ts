import { db, WatchLaterItem, Note } from '../../store/db';
import { EmbeddingService } from '../ai/EmbeddingService';
import { v4 as uuidv4 } from 'uuid';

export class WatchLaterService {
    private static instance: WatchLaterService;
    private embeddingService: EmbeddingService;

    private constructor() {
        this.embeddingService = EmbeddingService.getInstance();
    }

    public static getInstance(): WatchLaterService {
        if (!WatchLaterService.instance) {
            WatchLaterService.instance = new WatchLaterService();
        }
        return WatchLaterService.instance;
    }

    /** Parse "10:23", "1:10:23", or ISO 8601 "PT10M23S" into total seconds. Returns 0 on failure. */
    public parseDuration(raw: string | number): number {
        if (raw === undefined || raw === null || raw === '') return 0;
        const str = String(raw);

        // ISO 8601 duration: PT1H10M23S
        const iso = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
        if (iso) {
            const h = parseInt(iso[1] || '0', 10);
            const m = parseInt(iso[2] || '0', 10);
            const s = parseInt(iso[3] || '0', 10);
            return h * 3600 + m * 60 + s;
        }

        // HH:MM:SS or MM:SS
        const parts = str.split(':').map(p => parseInt(p, 10));
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    /** Add a video, deduplicating by videoId. Returns the item's id. */
    public async addVideo(data: Omit<WatchLaterItem, 'id' | 'addedAt' | 'embedding'>): Promise<string> {
        const existing = await db.watchLater.where('videoId').equals(data.videoId).first();
        if (existing) return existing.id;

        const embeddingText = `${data.title} ${data.channel} ${data.tags.join(' ')}`.trim();
        const embedding = await this.embeddingService.getEmbedding(embeddingText);
        const id = uuidv4();

        await db.watchLater.add({
            ...data,
            id,
            addedAt: Date.now(),
            embedding
        });

        return id;
    }

    /** Return all unwatched items (no watchedAt), newest first. */
    public async listUnwatched(): Promise<WatchLaterItem[]> {
        const all = await db.watchLater.toArray();
        return all
            .filter(v => v.watchedAt === undefined)
            .sort((a, b) => b.addedAt - a.addedAt);
    }

    /** Embed query, cosine rank, filter by maxSeconds (0 = no limit), return top 5. */
    public async semanticRecommend(query: string, maxSeconds: number = 0): Promise<WatchLaterItem[]> {
        const unwatched = await this.listUnwatched();
        if (unwatched.length === 0) return [];

        const queryEmbedding = await this.embeddingService.getEmbedding(query);
        const scored = unwatched.map(item => ({
            item,
            score: this.cosineSimilarity(queryEmbedding, item.embedding)
        }));

        return scored
            .filter(({ item }) => maxSeconds === 0 || item.durationSeconds === 0 || item.durationSeconds <= maxSeconds)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(({ item }) => item);
    }

    /** Mark a video as watched. */
    public async markWatched(id: string): Promise<void> {
        await db.watchLater.update(id, { watchedAt: Date.now() });
    }

    /** Remove a watch-later item. */
    public async removeVideo(id: string): Promise<void> {
        await db.watchLater.delete(id);
    }

    /** Look up a watch-later item by videoId. */
    public async getByVideoId(videoId: string): Promise<WatchLaterItem | undefined> {
        return db.watchLater.where('videoId').equals(videoId).first();
    }

    /** Remove a watch-later item by videoId. Returns true if found and removed. */
    public async removeByVideoId(videoId: string): Promise<boolean> {
        const item = await db.watchLater.where('videoId').equals(videoId).first();
        if (!item) return false;
        await db.watchLater.delete(item.id);
        return true;
    }

    /** Save a note with semantic embedding. Returns the new note's id. */
    public async addNote(content: string, title?: string, tags?: string[], source?: string): Promise<string> {
        const embedding = await this.embeddingService.getEmbedding(`${title ?? ''} ${content} ${(tags ?? []).join(' ')}`.trim());
        const id = uuidv4();
        const now = Date.now();

        await db.notes.add({
            id,
            content,
            title,
            tags: tags ?? [],
            source,
            createdAt: now,
            updatedAt: now,
            embedding
        });

        return id;
    }

    /** Semantic search over notes. */
    public async searchNotes(query: string, limit: number = 5): Promise<Note[]> {
        const queryEmbedding = await this.embeddingService.getEmbedding(query);
        const all = await db.notes.toArray();

        return all
            .map(note => ({ note, score: this.cosineSimilarity(queryEmbedding, note.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ note }) => note);
    }

    /** Return all notes, newest first. */
    public async listNotes(): Promise<Note[]> {
        const all = await db.notes.toArray();
        return all.sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Delete a note by id. */
    public async deleteNote(id: string): Promise<void> {
        await db.notes.delete(id);
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot   += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
}
