/**
 * ChromeAIService - Chrome Built-in AI (Gemini Nano) wrapper
 *
 * Uses LanguageModel API when available (service worker),
 * falls back to chrome.runtime.sendMessage for other contexts.
 */

export class ChromeAIService {
    private static instance: ChromeAIService;
    private isServiceWorker: boolean;

    private constructor() {
        // Check if we're in a service worker context
        this.isServiceWorker = typeof LanguageModel !== 'undefined';
        console.log(`[ChromeAI] Context: ${this.isServiceWorker ? 'Service Worker (direct API)' : 'Extension Page (via proxy)'}`);
    }

    public static getInstance(): ChromeAIService {
        if (!ChromeAIService.instance) {
            ChromeAIService.instance = new ChromeAIService();
        }
        return ChromeAIService.instance;
    }

    /**
     * Check if AI is available
     */
    public async isAvailable(): Promise<{ available: boolean; status: string }> {
        if (this.isServiceWorker) {
            // Direct API access
            try {
                const status = await LanguageModel!.availability();
                return {
                    available: status === 'available' || status === 'downloadable',
                    status
                };
            } catch (e) {
                return { available: false, status: 'error' };
            }
        } else {
            // Via service worker
            return new Promise((resolve) => {
                chrome.runtime.sendMessage({ type: 'ai:check' }, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve({ available: false, status: 'error' });
                    } else {
                        resolve(response || { available: false, status: 'unknown' });
                    }
                });
            });
        }
    }

    /**
     * Create a session (only works in service worker)
     */
    public async createSession(options?: { systemPrompt?: string }): Promise<LanguageModelSession | null> {
        if (!this.isServiceWorker) {
            console.log('[ChromeAI] createSession called from non-service-worker context, returning null');
            return null;
        }

        return await LanguageModel!.create(options);
    }

    /**
     * Generate a response
     */
    public async generate(prompt: string, session?: any): Promise<string> {
        if (this.isServiceWorker && session) {
            // Direct API with existing session
            return await session.prompt(prompt);
        }

        if (this.isServiceWorker) {
            // Direct API, create temp session
            const tempSession = await LanguageModel!.create();
            const result = await tempSession.prompt(prompt);
            tempSession.destroy();
            return result;
        }

        // Via service worker proxy
        return this.promptViaProxy(prompt);
    }

    /**
     * Generate with system prompt
     */
    public async generateWithSystem(prompt: string, systemPrompt: string): Promise<string> {
        if (this.isServiceWorker) {
            const session = await LanguageModel!.create({ systemPrompt });
            const result = await session.prompt(prompt);
            session.destroy();
            return result;
        }

        // Via service worker proxy
        return this.promptViaProxy(prompt, systemPrompt);
    }

    /**
     * Prompt AI via service worker
     */
    private promptViaProxy(prompt: string, systemPrompt?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'ai:prompt', prompt, systemPrompt },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response?.success) {
                        resolve(response.result);
                    } else {
                        reject(new Error(response?.error || 'AI request failed'));
                    }
                }
            );
        });
    }
}
