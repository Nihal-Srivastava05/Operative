/**
 * Attempts to extract and parse JSON from a string.
 * Handles markdown code blocks, surrounding text, and some common JSON errors.
 */
export function extractJson(text: string): any {
    if (!text || typeof text !== 'string') {
        return null;
    }

    // Trim whitespace
    text = text.trim();

    try {
        // 1. Try simple strict parse first
        return JSON.parse(text);
    } catch (e) {
        // Continue to heuristics
    }

    // 2. Remove markdown code blocks
    let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    try {
        return JSON.parse(cleaned.trim());
    } catch (e) {
        // Continue
    }

    // 3. Extract content between first { and last }
    const firstOpen = cleaned.indexOf('{');
    const lastClose = cleaned.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
        const potentialJson = cleaned.substring(firstOpen, lastClose + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            // Failed to parse extracted block
        }
    }

    // 4. Try to find JSON in multiline text (look for lines starting with {)
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
            // Try to parse from this line onwards
            const remaining = lines.slice(i).join('\n');
            const openBrace = remaining.indexOf('{');
            const closeBrace = remaining.lastIndexOf('}');
            if (openBrace !== -1 && closeBrace !== -1 && closeBrace > openBrace) {
                try {
                    return JSON.parse(remaining.substring(openBrace, closeBrace + 1));
                } catch (e) {
                    // Continue
                }
            }
        }
    }

    // 5. Fallback: Return null to indicate failure
    console.warn('Failed to extract JSON from text:', text.substring(0, 100));
    return null;
}
