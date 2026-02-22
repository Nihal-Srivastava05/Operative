import { WatchLaterService } from '../services/watchlater/WatchLaterService';

console.log('Operative Service Worker Running');

// Tab-video tracking is stored in chrome.storage.session (not an in-memory Map)
// because the MV3 service worker sleeps between events and loses all module-level state.
// chrome.storage.session persists across SW sleep/wake cycles for the browser session.
const TAB_KEY = (id: number) => `wl_tab_${id}`;

// Setup Chrome side panel behavior
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// ── Internal message listener (from content scripts) ─────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[Operative/BG] message received:', message.type);
    if (message.type === 'YOUTUBE_VIDEO_LOADED') {
        const svc = WatchLaterService.getInstance();
        const p = message.payload;
        // Persist which video is live in this tab — survives SW sleep/wake
        if (_sender.tab?.id != null) {
            chrome.storage.session.set({
                [TAB_KEY(_sender.tab.id)]: { videoId: p.videoId, title: p.title }
            });
        }
        svc.addVideo({
            url: p.url,
            videoId: p.videoId,
            title: p.title,
            channel: p.channel,
            thumbnail: p.thumbnail,
            tags: [],
            durationSeconds: svc.parseDuration(p.durationRaw)
        }).then(id => sendResponse({ success: true, id }))
          .catch(err => sendResponse({ success: false, error: String(err) }));
        return true; // keep message channel open for async response
    }

    if (message.type === 'YOUTUBE_IS_SAVED') {
        const svc = WatchLaterService.getInstance();
        svc.getByVideoId(message.payload.videoId)
            .then(item => sendResponse({ saved: !!item }))
            .catch(() => sendResponse({ saved: false }));
        return true;
    }

    if (message.type === 'YOUTUBE_VIDEO_COMPLETED') {
        const svc = WatchLaterService.getInstance();
        const { videoId } = message.payload;
        svc.getByVideoId(videoId).then(async item => {
            if (item && !item.watchedAt) {
                await svc.markWatched(item.id);
                console.log(`[WatchLater] Auto-marked watched: ${videoId}`);
            }
            sendResponse({ success: true });
        }).catch(err => sendResponse({ success: false, error: String(err) }));
        return true;
    }
});

// ── Tab-close → "Remove from Watch Later?" prompt in side panel ──────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const key = TAB_KEY(tabId);
    const result = await chrome.storage.session.get(key);
    const info = result[key] as { videoId: string; title: string } | undefined;
    if (!info) return;
    await chrome.storage.session.remove(key);

    const svc = WatchLaterService.getInstance();
    const item = await svc.getByVideoId(info.videoId);
    if (!item || item.watchedAt) return;

    const prompt = { videoId: info.videoId, title: info.title };

    // Persist so the panel can pick it up even if it was closed when the tab closed.
    await chrome.storage.session.set({ wl_pending_prompt: prompt });

    // Also push live if the panel is already open.
    chrome.runtime.sendMessage({ type: 'WATCHLATER_PROMPT_REMOVE', payload: prompt })
        .catch(() => { /* panel not open — prompt will appear on next open */ });
});

// ── Handlers for Remove / Dismiss actions sent from the Chat UI ───────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'WATCHLATER_DO_REMOVE') {
        WatchLaterService.getInstance()
            .removeByVideoId(message.payload.videoId)
            .then(async () => {
                await chrome.storage.session.remove('wl_pending_prompt');
                console.log('[WatchLater] Removed on tab close:', message.payload.videoId);
                sendResponse({ success: true });
            })
            .catch(err => sendResponse({ success: false, error: String(err) }));
        return true;
    }
    if (message.type === 'WATCHLATER_PROMPT_DISMISS') {
        chrome.storage.session.remove('wl_pending_prompt')
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: true }));
        return true;
    }
});

// ── Extension-to-Extension API ────────────────────────────────────────────────
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    const svc = WatchLaterService.getInstance();

    switch (message.action) {
        case 'addWatchLater': {
            const d = message.data;
            if (!d || !d.videoId || !d.url || !d.title) {
                sendResponse({ success: false, error: 'Missing required fields: videoId, url, title' });
                return;
            }
            svc.addVideo({
                url: d.url,
                videoId: d.videoId,
                title: d.title,
                channel: d.channel ?? '',
                thumbnail: d.thumbnail ?? `https://i.ytimg.com/vi/${d.videoId}/mqdefault.jpg`,
                tags: d.tags ?? [],
                durationSeconds: svc.parseDuration(d.durationRaw ?? '')
            }).then(id => sendResponse({ success: true, id }))
              .catch(err => sendResponse({ success: false, error: String(err) }));
            return true;
        }

        case 'addNote': {
            const d = message.data;
            if (!d || !d.content) {
                sendResponse({ success: false, error: 'Missing required field: content' });
                return;
            }
            svc.addNote(d.content, d.title, d.tags, d.source)
               .then(id => sendResponse({ success: true, id }))
               .catch(err => sendResponse({ success: false, error: String(err) }));
            return true;
        }

        case 'getWatchLater': {
            svc.listUnwatched()
               .then(items => sendResponse({ success: true, items }))
               .catch(err => sendResponse({ success: false, error: String(err) }));
            return true;
        }

        case 'getNotes': {
            svc.listNotes()
               .then(notes => sendResponse({ success: true, notes }))
               .catch(err => sendResponse({ success: false, error: String(err) }));
            return true;
        }

        default:
            sendResponse({ success: false, error: 'Unknown action' });
    }
});
