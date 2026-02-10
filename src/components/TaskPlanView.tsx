import React from 'react';
import { CheckCircle2, Circle, Loader2, XCircle, ListTodo } from 'lucide-react';
import type { TaskPlan } from '../services/orchestrator/types';

export interface TaskPlanViewProps {
    plan: TaskPlan;
    onCancel?: () => void;
    compact?: boolean;
}

function TaskStatusIcon({ status }: { status: string }) {
    switch (status) {
        case 'completed':
            return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />;
        case 'in_progress':
            return <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />;
        case 'failed':
            return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
        default:
            return <Circle className="w-4 h-4 text-slate-500 shrink-0" />;
    }
}

export function TaskPlanView({ plan, onCancel, compact }: TaskPlanViewProps) {
    const isExecuting = plan.status === 'executing';
    const taskCount = plan.tasks.length;

    return (
        <div className="rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm">
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 text-slate-300">
                    <ListTodo className="w-4 h-4 text-indigo-400" />
                    <span className="font-medium">
                        Task plan ({taskCount} step{taskCount !== 1 ? 's' : ''})
                    </span>
                    {isExecuting && (
                        <span className="text-xs text-indigo-400">Running…</span>
                    )}
                </div>
                {isExecuting && onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-xs text-slate-400 hover:text-red-400 transition"
                    >
                        Cancel
                    </button>
                )}
            </div>
            <ul className="space-y-1.5">
                {plan.tasks.map((task, idx) => (
                    <li
                        key={task.id}
                        className="flex items-start gap-2 text-slate-300"
                    >
                        <TaskStatusIcon status={task.status} />
                        <div className="min-w-0 flex-1">
                            <span className="text-slate-400 text-xs">
                                {idx + 1}. {task.targetAgentName ?? 'Agent'}
                            </span>
                            <p className="text-slate-200 truncate" title={task.description}>
                                {task.description}
                            </p>
                            {!compact && task.status === 'completed' && plan.results[task.id] && (
                                <p className="mt-1 text-xs text-slate-500 line-clamp-2">
                                    {plan.results[task.id]}
                                </p>
                            )}
                            {!compact && task.status === 'failed' && task.error && (
                                <p className="mt-1 text-xs text-red-400">{task.error}</p>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
