import React, { useState, useEffect } from 'react';
import { db, Settings as SettingsType } from '../store/db';
import { Orchestrator } from '../services/orchestrator/Orchestrator';
import { Trash2, Plus, RefreshCw } from 'lucide-react';

export function Settings() {
    const [servers, setServers] = useState<string[]>([]);
    const [newUrl, setNewUrl] = useState('');

    const loadServers = async () => {
        // We store servers in settings table under key 'mcp_servers'
        const record = await db.settings.get('mcp_servers');
        if (record) {
            setServers(record.value);
        }
    };

    useEffect(() => {
        loadServers();
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

            <div className="mt-auto">
                <p className="text-xs text-slate-500">
                    Note: Ensure local servers allow CORS from the extension origin.
                </p>
            </div>
        </div>
    );
}
