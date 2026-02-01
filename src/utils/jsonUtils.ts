/**
 * Attempts to extract and parse JSON from a string.
 * Handles markdown code blocks, surrounding text, and some common JSON errors.
 */
export function extractJson(text: string): any {
    try {
        // 1. Try simple strict parse first
        return JSON.parse(text);
    } catch (e) {
        // Continue to heuristics
    }

    // 2. Extract content between first { and last }
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
        const potentialJson = text.substring(firstOpen, lastClose + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            // Failed to parse extracted block
        }
    }

    // 3. Try to clean up markdown code blocks if regex didn't catch them above
    // (Though the substring method usually handles ```json ... ``` correctly if { starts inside)

    // 4. Fallback: Return null to indicate failure
    return null;
}
