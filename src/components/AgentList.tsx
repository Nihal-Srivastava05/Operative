import React, { useEffect, useState } from 'react';
import { db, Agent } from '../store/db';
import { Plus, Edit, Trash2, Power } from 'lucide-react';

interface AgentListProps {
    onEdit: (agent: Agent) => void;
    onCreate: () => void;
}

function agentCard(agent: Agent, parentName: string | null, onEdit: (a: Agent) => void, toggleAgent: (a: Agent) => void, deleteAgent: (id: string) => void) {
    const toolLabel = agent.assignedTool ? `${agent.assignedTool.toolName} (${agent.assignedTool.serverId})` : null;
    return (
        <div key={agent.id} className="bg-slate-800 p-3 rounded-lg border border-slate-700 flex flex-col gap-2">
            <div className="flex justify-between items-start">
                <div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${agent.type === 'orchestrator' ? 'bg-purple-900 text-purple-200' : 'bg-blue-900 text-blue-200'}`}>
                        {agent.type}
                    </span>
                    {parentName && (
                        <span className="text-xs text-slate-500 ml-2">under {parentName}</span>
                    )}
                    <h3 className="font-semibold text-white mt-1">{agent.name}</h3>
                    {toolLabel && (
                        <div className="text-xs text-slate-400 mt-1">
                            Tool: <span className="text-slate-300">{toolLabel}</span>
                        </div>
                    )}
                </div>
                <div className="flex space-x-1">
                    <button
                        onClick={() => toggleAgent(agent)}
                        className={`p-1.5 rounded transition ${agent.enabled ? 'text-green-400 bg-green-900/30' : 'text-slate-500 bg-slate-700/50'}`}
                        title="Toggle Enable"
                    >
                        <Power className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onEdit(agent)}
                        className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition"
                    >
                        <Edit className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => deleteAgent(agent.id)}
                        className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>
            <p className="text-xs text-slate-400 line-clamp-2">
                {agent.systemPrompt}
            </p>
        </div>
    );
}

export function AgentList({ onEdit, onCreate }: AgentListProps) {
    const [agents, setAgents] = useState<Agent[]>([]);

    const loadAgents = async () => {
        const list = await db.agents.toArray();
        setAgents(list);
    };

    useEffect(() => {
        loadAgents();
    }, []);

    const toggleAgent = async (agent: Agent) => {
        await db.agents.update(agent.id, { enabled: !agent.enabled });
        loadAgents();
    };

    const deleteAgent = async (id: string) => {
        if (confirm('Are you sure you want to delete this agent?')) {
            await db.agents.delete(id);
            loadAgents();
        }
    };

    const orchestrators = agents.filter(a => a.type === 'orchestrator');
    const workersByParent = new Map<string | null, Agent[]>();
    for (const a of agents.filter(a => a.type === 'worker')) {
        const key = a.parentId ?? null;
        if (!workersByParent.has(key)) workersByParent.set(key, []);
        workersByParent.get(key)!.push(a);
    }
    const topLevelWorkers = workersByParent.get(null) ?? [];

    return (
        <div className="flex flex-col h-full">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-white">Agents</h2>
                <button
                    onClick={onCreate}
                    className="p-2 bg-indigo-600 rounded hover:bg-indigo-500 transition"
                >
                    <Plus className="w-5 h-5" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3">
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-400">
                    <span className="text-indigo-400 font-semibold">Note:</span> The Meta Orchestrator routes requests to Mini Orchestrators or top-level workers; each Mini Orchestrator routes to its child agents.
                </div>

                {orchestrators.length > 0 && (
                    <>
                        <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Orchestrators</h3>
                        {orchestrators.map(o => agentCard(o, null, onEdit, toggleAgent, deleteAgent))}
                    </>
                )}

                {topLevelWorkers.length > 0 && (
                    <>
                        <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Top-level workers</h3>
                        {topLevelWorkers.map(w => agentCard(w, null, onEdit, toggleAgent, deleteAgent))}
                    </>
                )}

                {orchestrators.map((orch) => {
                    const children = workersByParent.get(orch.id) ?? [];
                    if (children.length === 0) return null;
                    return (
                        <div key={orch.id}>
                            <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Under {orch.name}</h3>
                            <div className="space-y-3 mt-2">
                                {children.map(w => agentCard(w, orch.name, onEdit, toggleAgent, deleteAgent))}
                            </div>
                        </div>
                    );
                })}

                {agents.length === 0 && (
                    <div className="text-center text-slate-500 mt-10">
                        <p className="mb-2">No agents yet.</p>
                        <p className="text-xs">Create Orchestrator or Worker agents to get started.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
