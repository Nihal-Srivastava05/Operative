export { };

declare global {
    interface Window {
        ai: {
            languageModel: AILanguageModelFactory;
        };
    }

    // Global LanguageModel interface
    var LanguageModel: AILanguageModelFactory;

    interface AILanguageModelFactory {
        capabilities(): Promise<AICapabilities>;
        create(options?: AILanguageModelCreateOptions): Promise<AILanguageModel>;
    }

    interface AICapabilities {
        available: 'readily' | 'after-download' | 'no';
        defaultTopK: number;
        maxTopK: number;
        defaultTemperature: number;
    }

    interface AILanguageModelCreateOptions {
        systemPrompt?: string;
        temperature?: number;
        topK?: number;
        monitor?: (monitor: AILanguageModelMonitor) => void;
        signal?: AbortSignal;
    }

    interface AILanguageModelMonitor extends EventTarget {
        addEventListener(
            type: 'downloadprogress',
            listener: (event: CustomEvent) => void
        ): void;
    }

    interface AILanguageModel {
        prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
        promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
        countPromptTokens(input: string): Promise<number>;
        destroy(): void;
        clone(): Promise<AILanguageModel>;

        // Potential properties
        tokensSoFar: number;
        maxTokens: number;
        tokensLeft: number;
    }
}
