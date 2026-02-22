import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Orchestrator } from '../services/orchestrator/Orchestrator';
import { TaskQueue } from '../services/orchestrator/TaskQueue';
import { TaskPlanView } from './TaskPlanView';
import type { TaskPlan } from '../services/orchestrator/types';

type ChatMessage =
    | { role: 'user' | 'model'; content: string; agentName?: string }
    | { role: 'prompt'; content: string; videoId: string; resolved: boolean };

export function Chat() {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const orchestrator = Orchestrator.getInstance();
    const taskQueue = TaskQueue.getInstance();

    // On mount: check if background stored a pending "remove?" prompt while the panel was closed.
    useEffect(() => {
        chrome.storage.session.get('wl_pending_prompt').then(res => {
            const p = res.wl_pending_prompt as { videoId: string; title: string } | undefined;
            if (p) injectPrompt(p.videoId, p.title);
        });
    }, []);

    // Live listener: panel was open when the tab closed.
    useEffect(() => {
        const listener = (message: any) => {
            if (message.type === 'WATCHLATER_PROMPT_REMOVE') {
                injectPrompt(message.payload.videoId, message.payload.title);
            }
        };
        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
    }, []);

    const injectPrompt = (videoId: string, title: string) => {
        setMessages(prev => {
            // Don't duplicate if we already have an unresolved prompt for this video.
            if (prev.some(m => m.role === 'prompt' && m.videoId === videoId && !m.resolved)) {
                return prev;
            }
            return [...prev, { role: 'prompt', content: title, videoId, resolved: false }];
        });
    };

    const handlePromptRemove = async (videoId: string, idx: number) => {
        setMessages(prev => prev.map((m, i) =>
            i === idx && m.role === 'prompt' ? { ...m, resolved: true } : m
        ));
        await chrome.runtime.sendMessage({ type: 'WATCHLATER_DO_REMOVE', payload: { videoId } });
    };

    const handlePromptKeep = async (idx: number) => {
        setMessages(prev => prev.map((m, i) =>
            i === idx && m.role === 'prompt' ? { ...m, resolved: true } : m
        ));
        await chrome.runtime.sendMessage({ type: 'WATCHLATER_PROMPT_DISMISS' });
    };

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
            // Find the last model message to pass as context for routing
            const lastModel = [...messages].reverse().find(m => m.role === 'model') as { role: 'model'; content: string; agentName?: string } | undefined;

            // If the user sends a short affirmative and the last agent response contained a
            // URL (e.g. "Want me to play it?"), transform the message into an explicit
            // navigate command so the router doesn't have to guess from "yes" alone.
            const isAffirmative = /^(yes|yeah|yep|sure|ok|okay|play\s*it?|do\s*it|go\s*ahead|play|navigate|open\s*it?)[\s!.]*$/i.test(userMsg.trim());
            let resolvedMsg = userMsg;
            if (isAffirmative && lastModel) {
                const urlMatch = lastModel.content.match(/https?:\/\/[^\s)]+/);
                if (urlMatch) {
                    resolvedMsg = `Navigate to ${urlMatch[0]}`;
                }
            }

            const { response, agentName } = await orchestrator.handleUserMessage(resolvedMsg, lastModel?.content);
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
    };

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
                {messages.map((m, i) => {
                    if (m.role === 'prompt') {
                        return (
                            <div key={i} className="flex justify-start">
                                <div className="max-w-[85%] bg-slate-800 rounded-lg p-3 text-sm text-slate-200">
                                    <div className="text-xs font-semibold text-amber-400 mb-2 flex items-center gap-1">
                                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                                        Watch Later
                                    </div>
                                    <p className="mb-3">
                                        You closed <span className="font-medium text-white">"{m.content}"</span> without finishing it. Remove from Watch Later?
                                    </p>
                                    {m.resolved ? (
                                        <p className="text-xs text-slate-500 italic">Dismissed</p>
                                    ) : (
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handlePromptRemove(m.videoId, i)}
                                                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition"
                                            >
                                                Remove
                                            </button>
                                            <button
                                                onClick={() => handlePromptKeep(i)}
                                                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-medium transition"
                                            >
                                                Keep
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    }

                    return (
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
                    );
                })}
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
