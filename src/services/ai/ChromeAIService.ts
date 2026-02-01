export class ChromeAIService {
    private static instance: ChromeAIService;
    private session: AILanguageModel | null = null;

    private constructor() { }

    public static getInstance(): ChromeAIService {
        if (!ChromeAIService.instance) {
            ChromeAIService.instance = new ChromeAIService();
        }
        return ChromeAIService.instance;
    }

    private getFactory(): AILanguageModelFactory {
        if (typeof LanguageModel !== 'undefined') {
            return LanguageModel;
        }
        if (window.ai && window.ai.languageModel) {
            return window.ai.languageModel;
        }
        throw new Error("LanguageModel API not supported in this browser");
    }

    public async isAvailable(): Promise<{ available: boolean, status: 'readily' | 'after-download' | 'no' }> {
        try {
            const factory = this.getFactory();
            const caps = await factory.capabilities();
            return {
                available: caps.available !== 'no',
                status: caps.available
            };
        } catch (e) {
            console.error("Error checking LanguageModel availability", e);
            return { available: false, status: 'no' };
        }
    }

    public async createSession(options?: AILanguageModelCreateOptions): Promise<AILanguageModel> {
        try {
            const factory = this.getFactory();
            // Merge default language with provided options
            const sessionOptions: AILanguageModelCreateOptions = {
                language: 'en', // Default to English
                ...options
            };
            const session = await factory.create(sessionOptions);
            return session;
        } catch (e) {
            console.error("Failed to create LanguageModel session", e);
            throw e;
        }
    }

    public async generate(prompt: string, session?: AILanguageModel): Promise<string> {
        const currentSession = session || this.session;
        if (!currentSession) {
            // Try to create a default session if none exists
            if (!session && !this.session) {
                this.session = await this.createSession();
                return await this.session.prompt(prompt);
            }
            throw new Error("No active session.");
        }
        return await currentSession.prompt(prompt);
    }

    public async *generateStream(prompt: string, session?: AILanguageModel): AsyncGenerator<string> {
        const currentSession = session || this.session;
        if (!currentSession) {
            // Try to create a default session if none exists
            if (!session && !this.session) {
                this.session = await this.createSession();
                // Recursively call with the new session
                // return this.generateStream(prompt, this.session);
                // Generators are tricky to recurse, let's just use the flow
            } else {
                throw new Error("No active session");
            }
        }

        // Re-check session in case we just created it
        const sesh = session || this.session!;

        const stream = sesh.promptStreaming(prompt);
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
    }
}
