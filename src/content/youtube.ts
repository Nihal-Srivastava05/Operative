/**
 * YouTube Watch Later content script.
 * Runs on *://*.youtube.com/watch* at document_idle.
 * Shows a banner asking the user whether to save the current video.
 * If the user chose "Yes, always this session", saves silently for the rest of the session.
 */

// Module-level flag — persists across SPA navigations within the same tab.
// Replaces chrome.storage.session which throws silently in content script context.
let sessionAutosave = false;

// Prevents checkAndPrompt being called twice for the same videoId
// (yt-navigate-finish can fire on initial page load in addition to the script-init call).
let lastPromptedVideoId: string | null = null;

function getVideoId(): string | null {
    return new URLSearchParams(location.search).get('v');
}

function getTitle(): string {
    const el = document.querySelector<HTMLElement>(
        'h1.ytd-video-primary-info-renderer yt-formatted-string, h1.style-scope.ytd-watch-metadata yt-formatted-string'
    );
    return el?.textContent?.trim() || document.title.replace(' - YouTube', '').trim();
}

/**
 * Poll until the page title matches the current videoId (i.e. the DOM has updated
 * after a SPA navigation), then prompt. Falls back after 3 seconds.
 */
function waitForTitleThenCapture(expectedVideoId: string): void {
    const start = Date.now();
    const check = setInterval(() => {
        const domTitle = document.querySelector<HTMLElement>(
            'h1.ytd-video-primary-info-renderer yt-formatted-string, h1.style-scope.ytd-watch-metadata yt-formatted-string'
        )?.textContent?.trim();
        const docTitle = document.title;
        const elapsed = Date.now() - start;

        // Consider title updated when it's non-empty and document.title no longer says the old page
        const titleReady = domTitle && domTitle.length > 0 && !docTitle.includes('YouTube') === false;
        if (titleReady || elapsed > 3000) {
            clearInterval(check);
            if (getVideoId() === expectedVideoId) {
                checkAndPrompt(expectedVideoId);
            }
        }
    }, 300);
}

function getChannel(): string {
    const el =
        document.querySelector<HTMLAnchorElement>('ytd-video-owner-renderer #channel-name a') ??
        document.querySelector<HTMLAnchorElement>('#owner #text a');
    return el?.textContent?.trim() || '';
}

/** Poll for the player duration up to maxAttempts×interval ms. Resolves to "" on timeout. */
function getDurationAsync(maxAttempts = 10, interval = 500): Promise<string> {
    return new Promise(resolve => {
        let attempts = 0;
        const poll = setInterval(() => {
            const el = document.querySelector<HTMLElement>('.ytp-time-duration');
            if (el?.textContent) {
                clearInterval(poll);
                resolve(el.textContent.trim());
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(poll);
                resolve('');
            }
        }, interval);
    });
}

async function captureAndSend(): Promise<void> {
    const videoId = getVideoId();
    if (!videoId) { console.warn('[Operative/WL] captureAndSend: no videoId'); return; }

    console.log('[Operative/WL] captureAndSend: collecting metadata for', videoId);
    const title    = getTitle();
    const channel  = getChannel();
    const durationRaw = await getDurationAsync();
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const url = location.href;

    console.log('[Operative/WL] captureAndSend: sending YOUTUBE_VIDEO_LOADED');
    try {
        await chrome.runtime.sendMessage({
            type: 'YOUTUBE_VIDEO_LOADED',
            payload: { videoId, title, channel, durationRaw, thumbnail, url }
        });
    } catch (err) {
        console.error('[Operative/WL] captureAndSend: sendMessage failed', err);
    }

    attachCompletionListener(videoId);
}

/**
 * Check session and persistent settings, then either save silently or show banner.
 */
async function checkAndPrompt(videoId: string): Promise<void> {
    if (lastPromptedVideoId === videoId) {
        console.log('[Operative/WL] checkAndPrompt: already prompted for', videoId, '— skipping');
        return;
    }
    lastPromptedVideoId = videoId;
    console.log('[Operative/WL] checkAndPrompt', videoId);

    // 1. Check persistent disable flag (set via Settings UI or MCP set_autosave tool)
    const local = await chrome.storage.local.get('watchlater_autosave_enabled');
    if (local.watchlater_autosave_enabled === false) {
        console.log('[Operative/WL] auto-save disabled by setting');
        return;
    }

    // 2. Check in-memory session flag (set when user clicks "Yes, always this session")
    if (sessionAutosave) {
        console.log('[Operative/WL] session auto-save on — saving silently');
        captureAndSend();
        return;
    }

    // 3. Ask SW if this video is already saved — skip banner if so
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'YOUTUBE_IS_SAVED',
            payload: { videoId }
        });
        if (response?.saved) {
            console.log('[Operative/WL] video already saved — skipping banner');
            attachCompletionListener(videoId);
            return;
        }
    } catch { /* SW not ready yet — fall through to banner */ }

    console.log('[Operative/WL] showing banner');
    showBanner(videoId);
}

function showBanner(videoId: string): void {
    // Remove any existing banner
    document.getElementById('operative-wl-banner')?.remove();

    const banner = document.createElement('div');
    banner.id = 'operative-wl-banner';
    banner.style.cssText = `
        position:fixed; top:70px; right:20px; z-index:9999;
        background:#1a1a2e; color:#fff; border-radius:10px;
        padding:12px 16px; font-family:sans-serif; font-size:13px;
        box-shadow:0 4px 20px rgba(0,0,0,.5); display:flex;
        align-items:center; gap:10px; border:1px solid #333;
    `;
    banner.innerHTML = `
        <span>\u{1F4BE} Add to Watch Later?</span>
        <button id="op-wl-yes">Yes</button>
        <button id="op-wl-no">No</button>
        <button id="op-wl-session">Yes, always this session</button>
    `;
    banner.querySelectorAll('button').forEach(b => {
        (b as HTMLElement).style.cssText =
            'cursor:pointer;padding:4px 10px;border-radius:6px;border:none;background:#6366f1;color:#fff;font-size:12px';
    });
    document.body.appendChild(banner);

    const dismiss = () => banner.remove();

    // Use banner.querySelector (not document.getElementById) to avoid any
    // accidental collision with YouTube's own DOM elements.
    banner.querySelector<HTMLButtonElement>('#op-wl-yes')!.addEventListener('click', () => {
        console.log('[Operative/WL] banner: Yes clicked');
        captureAndSend();
        dismiss();
    });
    banner.querySelector<HTMLButtonElement>('#op-wl-no')!.addEventListener('click', () => dismiss());
    banner.querySelector<HTMLButtonElement>('#op-wl-session')!.addEventListener('click', () => {
        console.log('[Operative/WL] banner: "always this session" clicked');
        sessionAutosave = true;
        captureAndSend();
        dismiss();
    });

    // Auto-dismiss after 12s if user ignores it
    setTimeout(dismiss, 12000);
}

/**
 * Attach a completion listener to the <video> element.
 * Sends YOUTUBE_VIDEO_COMPLETED when the video ends or reaches 90% watched.
 */
function attachCompletionListener(videoId: string): void {
    let sent = false;

    const sendCompleted = () => {
        if (sent) return;
        if (getVideoId() !== videoId) return;
        sent = true;
        chrome.runtime.sendMessage({ type: 'YOUTUBE_VIDEO_COMPLETED', payload: { videoId } });
    };

    const poll = setInterval(() => {
        const video = document.querySelector<HTMLVideoElement>('video');
        if (!video) return;
        clearInterval(poll);

        // 'ended' fires when video reaches the end naturally
        video.addEventListener('ended', sendCompleted, { once: true });

        // 90% threshold — more reliable for autoplay scenarios
        video.addEventListener('timeupdate', function onTimeUpdate() {
            if (video.duration > 0 && video.currentTime / video.duration >= 0.9) {
                video.removeEventListener('timeupdate', onTimeUpdate);
                sendCompleted();
            }
        });
    }, 500);
}

// Initial prompt on script load
console.log('[Operative/WL] content script loaded');
const initialVideoId = getVideoId();
if (initialVideoId) {
    checkAndPrompt(initialVideoId);
}

// Handle YouTube SPA navigation (next video click, autoplay, etc.)
// yt-navigate-finish fires before the new page's title DOM is updated,
// so we poll until the title reflects the new videoId.
window.addEventListener('yt-navigate-finish', () => {
    if (location.pathname === '/watch') {
        const videoId = getVideoId();
        if (videoId) waitForTitleThenCapture(videoId);
    }
});
