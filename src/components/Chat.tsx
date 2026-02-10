import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Orchestrator } from '../services/orchestrator/Orchestrator';
import { TaskQueue } from '../services/orchestrator/TaskQueue';
import { TaskPlanView } from './TaskPlanView';
import type { TaskPlan } from '../services/orchestrator/types';

export function Chat() {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<{ role: 'user' | 'model', content: string, agentName?: string }[]>([]);
    const [loading, setLoading] = useState(false);
    const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const orchestrator = Orchestrator.getInstance();
    const taskQueue = TaskQueue.getInstance();

    // Poll for current task plan while loading (multi-step execution)
    useEffect(() => {
        if (!loading) {
            setTaskPlan(null);
            return;
        }
        let cancelled = false;
        const poll = async () => {
            const plan = await orchestrator.getCurrentTaskPlan();
            if (!cancelled && plan && plan.tasks.length > 0) {
                setTaskPlan(plan);
            }
        };
        poll();
        const interval = setInterval(poll, 800);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [loading, orchestrator]);

    const handleSend = async () => {
        if (!input.trim() || loading) return;

        const userMsg = input;
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setLoading(true);

        try {
            const { response, agentName } = await orchestrator.handleUserMessage(userMsg);
            setMessages(prev => [...prev, { role: 'model', content: response, agentName }]);
        } catch (e) {
            setMessages(prev => [...prev, { role: 'model', content: `Error: ${e}`, agentName: 'System' }]);
        } finally {
            setLoading(false);
        }
    };

    const handleCancelPlan = async () => {
        await taskQueue.cancelPlan();
        setTaskPlan(null);
    };

    useEffect(() => {
        scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {taskPlan && taskPlan.tasks.length > 1 && (
                    <div className="flex justify-start">
                        <div className="max-w-[85%] w-full">
                            <TaskPlanView
                                plan={taskPlan}
                                onCancel={handleCancelPlan}
                                compact={false}
                            />
                        </div>
                    </div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-lg p-3 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                            {m.role === 'model' && m.agentName && (
                                <div className="text-xs font-semibold text-indigo-400 mb-1.5 flex items-center gap-1">
                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                    {m.agentName}
                                </div>
                            )}
                            <div className="whitespace-pre-wrap">
                                {m.content}
                            </div>
                        </div>
                    </div>
                ))}
                <div ref={scrollRef} />
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900">
                <div className="relative">
                    <textarea
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask the agents..."
                        className="w-full bg-slate-800 text-white rounded-md pl-3 pr-10 py-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none h-12 scrollbar-none"
                    />
                    <button
                        onClick={handleSend}
                        disabled={loading}
                        className="absolute right-2 top-2 p-1.5 text-indigo-400 hover:text-white disabled:opacity-50"
                    >
                        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                    </button>
                </div>
            </div>
        </div>
    );
}
