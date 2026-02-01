import React, { useState, useEffect } from 'react';
import { Bot, Layers, Zap, MessageSquare, Plus, Settings as SettingsIcon } from 'lucide-react';
import { AgentList } from './components/AgentList';
import { AgentEditor } from './components/AgentEditor';
import { Chat } from './components/Chat';
import { Settings } from './components/Settings';
import { Agent } from './store/db';
import { Orchestrator } from './services/orchestrator/Orchestrator';

type View = 'chat' | 'agents' | 'settings';

function App() {
    const [view, setView] = useState<View>('chat');
    const [editingAgent, setEditingAgent] = useState<Agent | null | undefined>(undefined); // undefined means not editing

    const handleEditAgent = (agent: Agent) => {
        setEditingAgent(agent);
    };

    const handleCreateAgent = () => {
        setEditingAgent(null);
    };

    const closeEditor = () => {
        setEditingAgent(undefined);
    };

    useEffect(() => {
        Orchestrator.getInstance().initialize();
    }, []);

    return (
        <div className="flex flex-col h-screen w-full bg-slate-950 text-slate-200 font-sans">
            {/* Header */}
            <header className="h-14 px-4 border-b border-slate-800 flex items-center justify-between bg-slate-900 shrink-0">
                <div className="flex items-center space-x-2">
                    <Layers className="w-5 h-5 text-indigo-400" />
                    <h1 className="font-bold text-lg tracking-tight">Operative</h1>
                </div>
                <div className="flex space-x-1 bg-slate-800 p-1 rounded-lg">
                    <button
                        onClick={() => { setView('chat'); setEditingAgent(undefined); }}
                        className={`p-1.5 rounded-md transition ${view === 'chat' && !editingAgent ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                        title="Chat"
                    >
                        <MessageSquare className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => { setView('agents'); setEditingAgent(undefined); }}
                        className={`p-1.5 rounded-md transition ${view === 'agents' || editingAgent !== undefined ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                        title="Agents"
                    >
                        <Bot className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => { setView('settings'); setEditingAgent(undefined); }}
                        className={`p-1.5 rounded-md transition ${view === 'settings' && !editingAgent ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                        title="Settings"
                    >
                        <SettingsIcon className="w-4 h-4" />
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 overflow-hidden relative">
                {editingAgent !== undefined ? (
                    <AgentEditor agent={editingAgent} onClose={closeEditor} />
                ) : view === 'agents' ? (
                    <div className="h-full p-4">
                        <AgentList onEdit={handleEditAgent} onCreate={handleCreateAgent} />
                    </div>
                ) : view === 'settings' ? (
                    <Settings />
                ) : (
                    <Chat />
                )}
            </main>

            {/* Footer Status */}
            <footer className="h-8 px-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500 bg-slate-900 shrink-0">
                <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                    <span>Gemini Nano Ready</span>
                </div>
                <span>v1.0.0</span>
            </footer>
        </div>
    );
}

export default App;
