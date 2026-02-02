/**
 * AIProxy - Proxy AI requests to service worker
 *
 * Since LanguageModel API is only available in service worker context,
 * this proxy allows other contexts (tabs, side panel, etc.) to use AI
 * by sending messages to the service worker.
 */

export class AIProxy {
    private static instance: AIProxy;

    private constructor() {}

    public static getInstance(): AIProxy {
        if (!AIProxy.instance) {
            AIProxy.instance = new AIProxy();
        }
        return AIProxy.instance;
    }

    /**
     * Check if AI is available (via service worker)
     */
    public async isAvailable(): Promise<{ available: boolean; status: string }> {
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

    /**
     * Generate a response using AI (via service worker)
     */
    public async prompt(prompt: string, systemPrompt?: string): Promise<string> {
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

/**
 * Simple function to prompt AI from any context
 */
export async function promptAI(prompt: string, systemPrompt?: string): Promise<string> {
    return AIProxy.getInstance().prompt(prompt, systemPrompt);
}

/**
 * Check AI availability from any context
 */
export async function checkAI(): Promise<{ available: boolean; status: string }> {
    return AIProxy.getInstance().isAvailable();
}
