import { WatchLaterService } from '../services/watchlater/WatchLaterService';

// Placeholder for background services
console.log('Operative Service Worker Running');

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
