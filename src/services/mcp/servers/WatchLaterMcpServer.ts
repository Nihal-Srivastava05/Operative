import { McpTool } from '../interfaces';
import { WatchLaterService } from '../../watchlater/WatchLaterService';

function formatDuration(seconds: number): string {
    if (seconds === 0) return 'unknown';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export class WatchLaterMcpServer {
    private svc: WatchLaterService;

    constructor() {
        this.svc = WatchLaterService.getInstance();
    }

    public async listTools(): Promise<McpTool[]> {
        return [
            {
                name: 'add_watch_later',
                description: 'Save a YouTube video to Watch Later.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url:         { type: 'string', description: 'Full YouTube watch URL' },
                        videoId:     { type: 'string', description: '11-character YouTube video ID' },
                        title:       { type: 'string', description: 'Video title' },
                        channel:     { type: 'string', description: 'Channel name' },
                        durationRaw: { type: 'string', description: 'Duration string e.g. "10:23" or "PT10M23S"' },
                        thumbnail:   { type: 'string', description: 'Thumbnail URL (optional)' },
                        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional tags' }
                    },
                    required: ['url', 'videoId', 'title', 'channel', 'durationRaw']
                }
            },
            {
                name: 'get_watch_later',
                description: 'List all unwatched Watch Later videos.',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'recommend_video',
                description: 'Semantically recommend a Watch Later video matching available time and interest.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        availableMinutes: { type: 'number', description: 'How many minutes the user has available' },
                        query: { type: 'string', description: 'Optional topic or mood to match against' }
                    },
                    required: ['availableMinutes']
                }
            },
            {
                name: 'mark_watched',
                description: 'Mark a Watch Later video as watched.',
                inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Video item ID' } },
                    required: ['id']
                }
            },
            {
                name: 'remove_watch_later',
                description: 'Remove a video from Watch Later. Provide id, videoId, or url — at least one is required.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id:      { type: 'string', description: 'Internal item UUID' },
                        videoId: { type: 'string', description: '11-character YouTube video ID' },
                        url:     { type: 'string', description: 'Full YouTube watch URL (v= param extracted automatically)' }
                    }
                }
            },
            {
                name: 'set_autosave',
                description: 'Enable or disable Watch Later auto-save. When disabled, the save banner will not appear on YouTube videos.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'true to enable auto-save banner, false to disable it' }
                    },
                    required: ['enabled']
                }
            },
            {
                name: 'add_note',
                description: 'Save a note or task to the personal notes store.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: 'The note body' },
                        title:   { type: 'string', description: 'Optional title' },
                        tags:    { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
                        source:  { type: 'string', description: 'Optional source URL or extension ID' }
                    },
                    required: ['content']
                }
            },
            {
                name: 'search_notes',
                description: 'Semantically search notes by topic or keyword.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        limit: { type: 'number', description: 'Max results (default 5)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'list_notes',
                description: 'List all notes, newest first.',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'delete_note',
                description: 'Delete a note by ID.',
                inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Note ID' } },
                    required: ['id']
                }
            }
        ];
    }

    public async callTool(name: string, args: any): Promise<any> {
        switch (name) {
            case 'add_watch_later': {
                const durationSeconds = this.svc.parseDuration(args.durationRaw);
                const id = await this.svc.addVideo({
                    url: args.url,
                    videoId: args.videoId,
                    title: args.title,
                    channel: args.channel,
                    durationSeconds,
                    thumbnail: args.thumbnail ?? `https://i.ytimg.com/vi/${args.videoId}/mqdefault.jpg`,
                    tags: args.tags ?? []
                });
                return { success: true, id, message: `Saved "${args.title}" to Watch Later.` };
            }

            case 'get_watch_later': {
                const items = await this.svc.listUnwatched();
                return {
                    count: items.length,
                    items: items.map(v => ({
                        id: v.id,
                        title: v.title,
                        channel: v.channel,
                        url: v.url,
                        durationFormatted: formatDuration(v.durationSeconds)
                    }))
                };
            }

            case 'recommend_video': {
                const maxSeconds = Math.round((args.availableMinutes as number) * 60);
                const query = args.query ?? 'something interesting';
                const results = await this.svc.semanticRecommend(query, maxSeconds);
                if (results.length === 0) {
                    const searchQuery = encodeURIComponent(query);
                    const searchUrl = `https://www.youtube.com/results?search_query=${searchQuery}&sp=EgIYAw%3D%3D`;
                    return {
                        found: false,
                        fallbackSearchUrl: searchUrl,
                        message: `No saved videos match. Here is a YouTube search for "${query}": ${searchUrl}`
                    };
                }
                const top = results[0];
                const dur = formatDuration(top.durationSeconds);
                return {
                    found: true,
                    recommendation: {
                        id: top.id,
                        title: top.title,
                        channel: top.channel,
                        url: top.url,
                        durationFormatted: dur
                    },
                    message: `I recommend "${top.title}" by ${top.channel} (${dur}). URL: ${top.url} — Want me to play it?`
                };
            }

            case 'mark_watched': {
                await this.svc.markWatched(args.id);
                return { success: true };
            }

            case 'remove_watch_later': {
                let removed = false;
                if (args.id) {
                    await this.svc.removeVideo(args.id);
                    removed = true;
                } else if (args.videoId) {
                    removed = await this.svc.removeByVideoId(args.videoId);
                } else if (args.url) {
                    try {
                        const vid = new URL(args.url).searchParams.get('v');
                        if (vid) removed = await this.svc.removeByVideoId(vid);
                    } catch {
                        return { success: false, message: 'Invalid URL provided.' };
                    }
                } else {
                    return { success: false, message: 'Provide id, videoId, or url.' };
                }
                return { success: removed, message: removed ? 'Removed.' : 'Video not found in Watch Later.' };
            }

            case 'set_autosave': {
                await chrome.storage.local.set({ watchlater_autosave_enabled: args.enabled });
                return {
                    success: true,
                    message: `Watch Later auto-save ${args.enabled ? 'enabled' : 'disabled'}.`
                };
            }

            case 'add_note': {
                const id = await this.svc.addNote(args.content, args.title, args.tags, args.source);
                return { success: true, id };
            }

            case 'search_notes': {
                const notes = await this.svc.searchNotes(args.query, args.limit ?? 5);
                return {
                    count: notes.length,
                    notes: notes.map(n => ({
                        id: n.id,
                        title: n.title,
                        content: n.content,
                        tags: n.tags,
                        createdAt: new Date(n.createdAt).toISOString()
                    }))
                };
            }

            case 'list_notes': {
                const notes = await this.svc.listNotes();
                return {
                    count: notes.length,
                    notes: notes.map(n => ({
                        id: n.id,
                        title: n.title,
                        content: n.content,
                        tags: n.tags,
                        createdAt: new Date(n.createdAt).toISOString()
                    }))
                };
            }

            case 'delete_note': {
                await this.svc.deleteNote(args.id);
                return { success: true };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
}
