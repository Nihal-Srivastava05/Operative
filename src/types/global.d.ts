export { };

declare global {
    // Chrome 146+ LanguageModel API (only available in service worker)
    var LanguageModel: {
        availability(): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
        create(options?: {
            systemPrompt?: string;
            temperature?: number;
            topK?: number;
        }): Promise<LanguageModelSession>;
    } | undefined;

    interface LanguageModelSession {
        prompt(input: string): Promise<string>;
        promptStreaming(input: string): AsyncIterable<string>;
        destroy(): void;
    }

    // Legacy API support (some Chrome versions)
    interface Window {
        ai?: {
            languageModel?: {
                capabilities(): Promise<{ available: 'readily' | 'after-download' | 'no' }>;
                create(options?: any): Promise<any>;
            };
        };
    }
}
