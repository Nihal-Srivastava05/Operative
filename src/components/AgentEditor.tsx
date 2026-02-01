import React, { useState, useEffect } from 'react';
import { Agent, db } from '../store/db';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft, Save } from 'lucide-react';
import { Orchestrator } from '../services/orchestrator/Orchestrator';

interface AgentEditorProps {
    agent?: Agent | null; // null = create
    onClose: () => void;
}

export function AgentEditor({ agent, onClose }: AgentEditorProps) {
    const [name, setName] = useState(agent?.name || '');
    const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
    const [type, setType] = useState<'orchestrator' | 'worker'>('worker');
    const [assignedTool, setAssignedTool] = useState<{ serverId: string, toolName: string } | null>(agent?.assignedTool || null);

    const [availableTools, setAvailableTools] = useState<{ serverId: string, toolName: string }[]>([]);

    useEffect(() => {
        const loadTools = async () => {
            const tools = await Orchestrator.getInstance().getConnectedTools();
            setAvailableTools(tools);
        };
        loadTools();
    }, []);

    const handleSave = async () => {
        if (!name || !systemPrompt) return; // Basic validation

        const agentData: any = {
            name,
            systemPrompt,
            type,
            assignedTool: assignedTool || undefined,
            enabled: agent ? agent.enabled : true,
        };

        if (agent) {
            await db.agents.update(agent.id, agentData);
        } else {
            await db.agents.add({
                id: uuidv4(),
                ...agentData,
                createdAt: Date.now()
            });
        }
        onClose();
    };

    return (
        <div className="flex flex-col h-full p-4">
            <div className="flex items-center mb-6">
                <button onClick={onClose} className="mr-2 p-1 hover:bg-slate-800 rounded">
                    <ArrowLeft className="w-5 h-5 text-slate-400" />
                </button>
                <h2 className="text-xl font-bold">{agent ? 'Edit Agent' : 'New Agent'}</h2>
            </div>

            <div className="space-y-4 flex-1 overflow-y-auto">
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Name</label>
                    <input
                        value={name}
                        onChange={e => setName(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder="e.g., Coder"
                    />
                </div>

                {/* Type Selection */}
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Type</label>
                    <select
                        value={type}
                        onChange={e => setType(e.target.value as any)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 focus:ring-1 focus:ring-indigo-500 outline-none"
                    >
                        <option value="worker">Worker Agent</option>
                        <option value="orchestrator">Orchestrator</option>
                    </select>
                </div>

                {/* Tool Selection */}
                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Assigned Tool (Optional)</label>
                    <select
                        value={assignedTool ? `${assignedTool.serverId}|${assignedTool.toolName}` : ''}
                        onChange={e => {
                            const val = e.target.value;
                            if (!val) {
                                setAssignedTool(null);
                            } else {
                                const [serverId, toolName] = val.split('|');
                                setAssignedTool({ serverId, toolName });
                            }
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 focus:ring-1 focus:ring-indigo-500 outline-none"
                    >
                        <option value="">None</option>
                        {availableTools.map(t => (
                            <option key={`${t.serverId}|${t.toolName}`} value={`${t.serverId}|${t.toolName}`}>
                                {t.toolName} ({t.serverId})
                            </option>
                        ))}
                    </select>
                    {availableTools.length === 0 && (
                        <p className="text-xs text-slate-500 mt-1">No tools detected. Configure MCP servers in Settings.</p>
                    )}
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">System Prompt</label>
                    <textarea
                        value={systemPrompt}
                        onChange={e => setSystemPrompt(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 h-40 font-mono text-sm focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder="You are a..."
                    />
                </div>

                <div className="pt-4">
                    <button
                        onClick={handleSave}
                        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-2 rounded font-medium flex items-center justify-center gap-2"
                    >
                        <Save className="w-4 h-4" />
                        Save Agent
                    </button>
                </div>
            </div>
        </div>
    );
}
