import React, { useState, useEffect } from 'react';
import { db } from '../store/db';
import { Orchestrator } from '../services/orchestrator/Orchestrator';
import { Trash2, Plus, RefreshCw } from 'lucide-react';

const DEFAULT_MAX_SUBTASKS = 10;
const DEFAULT_TASK_TIMEOUT_SEC = 60;

export function Settings() {
    const [servers, setServers] = useState<string[]>([]);
    const [newUrl, setNewUrl] = useState('');
    const [taskDecompositionEnabled, setTaskDecompositionEnabled] = useState(true);
    const [maxSubtasks, setMaxSubtasks] = useState(DEFAULT_MAX_SUBTASKS);
    const [taskTimeoutSec, setTaskTimeoutSec] = useState(DEFAULT_TASK_TIMEOUT_SEC);
    const [autoRetryFailed, setAutoRetryFailed] = useState(false);
    const [watchLaterAutosave, setWatchLaterAutosave] = useState(true);

    const loadServers = async () => {
        const record = await db.settings.get('mcp_servers');
        if (record) {
            setServers(record.value);
        }
    };

    const loadTaskDecompositionSettings = async () => {
        const enabled = await db.settings.get('task_decomposition_enabled');
        const max = await db.settings.get('task_decomposition_max_subtasks');
        const timeout = await db.settings.get('task_decomposition_task_timeout');
        const retry = await db.settings.get('task_decomposition_auto_retry');
        if (enabled?.value !== undefined) setTaskDecompositionEnabled(Boolean(enabled.value));
        if (typeof max?.value === 'number') setMaxSubtasks(max.value);
        if (typeof timeout?.value === 'number') setTaskTimeoutSec(timeout.value);
        if (retry?.value !== undefined) setAutoRetryFailed(Boolean(retry.value));
    };

    const loadWatchLaterSettings = async () => {
        const result = await chrome.storage.local.get('watchlater_autosave_enabled');
        // Default to true if not set
        setWatchLaterAutosave(result.watchlater_autosave_enabled !== false);
    };

    useEffect(() => {
        loadServers();
        loadTaskDecompositionSettings();
        loadWatchLaterSettings();
    }, []);

    const addServer = async () => {
        if (!newUrl) return;
        const updated = [...servers, newUrl];
        await db.settings.put({ key: 'mcp_servers', value: updated });
        setServers(updated);
        setNewUrl('');

        // Attempt connect
        try {
            // Orchestrator keeps a map, we might need to signal it or it should load on startup
            // For now, just try to connect
            await Orchestrator.getInstance().registerMcpServer(newUrl, newUrl);
        } catch (e) {
            alert('Failed to connect to server');
        }
    };

    const removeServer = async (url: string) => {
        const updated = servers.filter(s => s !== url);
        await db.settings.put({ key: 'mcp_servers', value: updated });
        setServers(updated);
    };

    return (
        <div className="flex flex-col h-full p-4">
            <h2 className="text-xl font-bold mb-4">Settings</h2>

            <div className="mb-6">
                <h3 className="text-md font-semibold text-slate-300 mb-2">MCP Servers (SSE)</h3>
                <div className="flex gap-2 mb-2">
                    <input
                        value={newUrl}
                        onChange={e => setNewUrl(e.target.value)}
                        placeholder="http://localhost:3000/sse"
                        className="flex-1 bg-slate-800 border border-slate-700 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button onClick={addServer} className="bg-indigo-600 hover:bg-indigo-700 text-white p-2 rounded">
                        <Plus className="w-5 h-5" />
                    </button>
                </div>

                <div className="space-y-2">
                    {servers.map(url => (
                        <div key={url} className="flex justify-between items-center bg-slate-800 p-2 rounded border border-slate-700">
                            <span className="text-sm truncate">{url}</span>
                            <div className="flex gap-1">
                                <button className="p-1 text-slate-400 hover:text-white" title="Reconnect">
                                    <RefreshCw className="w-4 h-4" />
                                </button>
                                <button onClick={() => removeServer(url)} className="p-1 text-red-400 hover:text-red-300">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))}
                    {servers.length === 0 && <p className="text-xs text-slate-500">No servers connected.</p>}
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-md font-semibold text-slate-300 mb-2">Task decomposition</h3>
                <p className="text-xs text-slate-500 mb-3">
                    Split complex requests into subtasks and run them in sequence with the right agents.
                </p>
                <div className="space-y-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={taskDecompositionEnabled}
                            onChange={async e => {
                                const v = e.target.checked;
                                setTaskDecompositionEnabled(v);
                                await db.settings.put({ key: 'task_decomposition_enabled', value: v });
                            }}
                            className="rounded border-slate-600 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm">Enable task decomposition</span>
                    </label>
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Max subtasks</label>
                        <input
                            type="number"
                            min={2}
                            max={20}
                            value={maxSubtasks}
                            onChange={e => setMaxSubtasks(Number(e.target.value))}
                            onBlur={async () => {
                                const v = Math.max(2, Math.min(20, maxSubtasks));
                                setMaxSubtasks(v);
                                await db.settings.put({ key: 'task_decomposition_max_subtasks', value: v });
                            }}
                            className="w-20 bg-slate-800 border border-slate-700 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                    </div>
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Task timeout (seconds)</label>
                        <input
                            type="number"
                            min={10}
                            max={300}
                            value={taskTimeoutSec}
                            onChange={e => setTaskTimeoutSec(Number(e.target.value))}
                            onBlur={async () => {
                                const v = Math.max(10, Math.min(300, taskTimeoutSec));
                                setTaskTimeoutSec(v);
                                await db.settings.put({ key: 'task_decomposition_task_timeout', value: v });
                            }}
                            className="w-20 bg-slate-800 border border-slate-700 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoRetryFailed}
                            onChange={async e => {
                                const v = e.target.checked;
                                setAutoRetryFailed(v);
                                await db.settings.put({ key: 'task_decomposition_auto_retry', value: v });
                            }}
                            className="rounded border-slate-600 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm">Auto-retry failed tasks</span>
                    </label>
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-md font-semibold text-slate-300 mb-2">Watch Later</h3>
                <p className="text-xs text-slate-500 mb-3">
                    When enabled, a banner appears on each YouTube video asking whether to save it. Disable to stop all auto-save prompts.
                </p>
                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={watchLaterAutosave}
                        onChange={async e => {
                            const v = e.target.checked;
                            setWatchLaterAutosave(v);
                            await chrome.storage.local.set({ watchlater_autosave_enabled: v });
                        }}
                        className="rounded border-slate-600 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm">Show save banner on YouTube videos</span>
                </label>
            </div>

            <div className="mt-auto">
                <p className="text-xs text-slate-500">
                    Note: Ensure local servers allow CORS from the extension origin.
                </p>
            </div>
        </div>
    );
}
