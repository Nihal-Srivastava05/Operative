import React, { useState, useEffect, useRef } from 'react';
import { Play, Users, Zap, Trash2, ExternalLink, ArrowRight, CheckCircle, Loader, AlertCircle } from 'lucide-react';
import { db, Agent } from '../store/db';

interface SpawnedAgent {
  id: string;
  definitionId: string;
  name: string;
  status: 'spawning' | 'ready' | 'busy' | 'error';
  tabId?: number;
}

interface WorkflowStep {
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  input?: string;
  output?: string;
  startTime?: number;
  endTime?: number;
}

const CHANNELS = {
  SYSTEM: 'operative:system',
  TASKS: 'operative:tasks',
};

export function MultiAgentPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [spawnedAgents, setSpawnedAgents] = useState<SpawnedAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [userPrompt, setUserPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [finalResult, setFinalResult] = useState<string>('');

  const systemChannelRef = useRef<BroadcastChannel | null>(null);
  const tasksChannelRef = useRef<BroadcastChannel | null>(null);
  const panelId = useRef(`panel_${Date.now()}`);
  const pendingTaskRef = useRef<string>('');
  const currentStepRef = useRef<number>(0);

  // Load agent definitions
  useEffect(() => {
    const loadAgents = async () => {
      const allAgents = await db.agents.toArray();
      const enabledAgents = allAgents.filter(a => a.enabled);
      setAgents(enabledAgents);
      if (enabledAgents.length > 0 && !selectedAgent) {
        setSelectedAgent(enabledAgents[0].id);
      }
    };
    loadAgents();
  }, []);

  // Setup BroadcastChannels
  useEffect(() => {
    systemChannelRef.current = new BroadcastChannel(CHANNELS.SYSTEM);
    tasksChannelRef.current = new BroadcastChannel(CHANNELS.TASKS);

    systemChannelRef.current.onmessage = (event) => {
      const message = event.data;
      if (!message || message.source?.id === panelId.current) return;

      if (message.type === 'lifecycle:ready') {
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'ready' } : a
          )
        );
      }

      if (message.type === 'lifecycle:terminated') {
        setSpawnedAgents(prev => prev.filter(a => a.id !== message.source?.id));
      }
    };

    tasksChannelRef.current.onmessage = (event) => {
      const message = event.data;
      if (!message || message.source?.id === panelId.current) return;

      if (message.type === 'task:accept') {
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'busy' } : a
          )
        );
      }

      if (message.type === 'task:result') {
        const result = message.payload?.result || '';
        handleTaskResult(message.source?.id, result);
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'ready' } : a
          )
        );
      }

      if (message.type === 'task:error') {
        handleTaskError(message.source?.id, message.payload?.error);
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'ready' } : a
          )
        );
      }
    };

    return () => {
      systemChannelRef.current?.close();
      tasksChannelRef.current?.close();
    };
  }, []);

  const handleTaskResult = (agentId: string, result: string) => {
    const stepIndex = currentStepRef.current;

    setWorkflowSteps(prev => {
      const updated = [...prev];
      if (updated[stepIndex]) {
        updated[stepIndex] = {
          ...updated[stepIndex],
          status: 'complete',
          output: result,
          endTime: Date.now()
        };
      }
      return updated;
    });

    // Check if there's a next step
    const nextStepIndex = stepIndex + 1;
    setTimeout(() => {
      setWorkflowSteps(prev => {
        if (nextStepIndex < prev.length) {
          // Run next step with this output as input
          currentStepRef.current = nextStepIndex;
          runWorkflowStep(nextStepIndex, result, prev);
        } else {
          // Workflow complete
          setFinalResult(result);
          setIsRunning(false);
        }
        return prev;
      });
    }, 500);
  };

  const handleTaskError = (agentId: string, error: string) => {
    const stepIndex = currentStepRef.current;
    setWorkflowSteps(prev => {
      const updated = [...prev];
      if (updated[stepIndex]) {
        updated[stepIndex] = {
          ...updated[stepIndex],
          status: 'error',
          output: `Error: ${error}`,
          endTime: Date.now()
        };
      }
      return updated;
    });
    setIsRunning(false);
  };

  const createMessage = (type: string, target: any, payload: any) => ({
    id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    type,
    source: { id: panelId.current, definitionId: 'system:panel', contextType: 'side-panel' },
    target,
    payload,
    timestamp: Date.now(),
  });

  const spawnAgent = async () => {
    if (!selectedAgent) return;
    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;

    const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    setSpawnedAgents(prev => [...prev, {
      id: agentId,
      definitionId: agent.id,
      name: agent.name,
      status: 'spawning',
    }]);

    try {
      const url = chrome.runtime.getURL(`agent.html?agentId=${agentId}&definitionId=${encodeURIComponent(agent.id)}`);
      const tab = await chrome.tabs.create({ url, active: false });
      setSpawnedAgents(prev => prev.map(a => a.id === agentId ? { ...a, tabId: tab.id } : a));
    } catch (error: any) {
      setSpawnedAgents(prev => prev.map(a => a.id === agentId ? { ...a, status: 'error' } : a));
    }
  };

  const terminateAgent = async (agentId: string, tabId?: number) => {
    if (systemChannelRef.current) {
      systemChannelRef.current.postMessage(createMessage('lifecycle:terminate', { type: 'agent', agentId }, { reason: 'requested', graceful: true }));
    }
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
    }
    setSpawnedAgents(prev => prev.filter(a => a.id !== agentId));
  };

  const runWorkflowStep = (stepIndex: number, input: string, steps: WorkflowStep[]) => {
    const step = steps[stepIndex];
    if (!step || !tasksChannelRef.current) return;

    // Build the task with context from previous step
    let taskPrompt = '';
    if (stepIndex === 0) {
      taskPrompt = input; // First step gets user's original prompt
    } else {
      taskPrompt = `Previous agent's output:\n"""${input}"""\n\nYour task: Continue this work. Analyze, improve, fact-check, or expand on the above content based on your expertise.`;
    }

    setWorkflowSteps(prev => {
      const updated = [...prev];
      updated[stepIndex] = { ...updated[stepIndex], status: 'running', input: input, startTime: Date.now() };
      return updated;
    });

    const taskId = `workflow_${Date.now()}_step${stepIndex}`;
    pendingTaskRef.current = taskId;

    const msg = createMessage('task:delegate', { type: 'agent', agentId: step.agentId }, {
      taskId,
      task: taskPrompt,
      priority: 'high',
    });
    tasksChannelRef.current.postMessage(msg);
  };

  const startWorkflow = () => {
    const readyAgents = spawnedAgents.filter(a => a.status === 'ready');
    if (readyAgents.length < 1 || !userPrompt.trim()) return;

    setIsRunning(true);
    setFinalResult('');
    currentStepRef.current = 0;

    // Create workflow steps from all ready agents
    const steps: WorkflowStep[] = readyAgents.map(agent => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'pending' as const,
    }));

    setWorkflowSteps(steps);

    // Start first step after state updates
    setTimeout(() => {
      runWorkflowStep(0, userPrompt, steps);
    }, 100);
  };

  const readyAgents = spawnedAgents.filter(a => a.status === 'ready');

  return (
    <div className="h-full flex flex-col p-4 overflow-hidden">
      <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
        <Users className="w-5 h-5 text-indigo-400" />
        Multi-Agent Workflow
      </h2>

      {/* Spawn Section */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3">
        <div className="flex gap-2">
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="flex-1 bg-slate-700 border border-slate-600 rounded p-2 text-sm"
          >
            {agents.length === 0 && <option value="">No agents</option>}
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button
            onClick={spawnAgent}
            disabled={!selectedAgent}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-2 rounded flex items-center gap-1 text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            Spawn
          </button>
        </div>
      </div>

      {/* Active Agents as Pipeline */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3">
        <h3 className="text-xs font-medium text-slate-400 mb-2">
          Agent Pipeline ({spawnedAgents.length} agents)
        </h3>
        {spawnedAgents.length === 0 ? (
          <p className="text-slate-500 text-sm">Spawn agents to build your workflow pipeline</p>
        ) : (
          <div className="flex items-center gap-1 flex-wrap">
            {spawnedAgents.map((agent, idx) => (
              <React.Fragment key={agent.id}>
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  agent.status === 'ready' ? 'bg-green-900/30 border border-green-700' :
                  agent.status === 'busy' ? 'bg-yellow-900/30 border border-yellow-700' :
                  agent.status === 'error' ? 'bg-red-900/30 border border-red-700' :
                  'bg-slate-700 border border-slate-600'
                }`}>
                  <div className={`w-2 h-2 rounded-full ${
                    agent.status === 'ready' ? 'bg-green-500' :
                    agent.status === 'busy' ? 'bg-yellow-500 animate-pulse' :
                    agent.status === 'error' ? 'bg-red-500' :
                    'bg-blue-500 animate-pulse'
                  }`} />
                  <span className="font-medium">{agent.name}</span>
                  <button
                    onClick={() => terminateAgent(agent.id, agent.tabId)}
                    className="text-red-400 hover:text-red-300 ml-1"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {idx < spawnedAgents.length - 1 && (
                  <ArrowRight className="w-4 h-4 text-indigo-400" />
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Workflow Input */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3">
        <h3 className="text-xs font-medium text-slate-400 mb-2">Your Prompt (flows through all agents)</h3>
        <textarea
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="Enter your request... Each agent will process and pass to the next."
          className="w-full bg-slate-700 border border-slate-600 rounded p-2 text-sm h-20 resize-none"
          disabled={isRunning}
        />
        <button
          onClick={startWorkflow}
          disabled={isRunning || readyAgents.length < 1 || !userPrompt.trim()}
          className="w-full mt-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded flex items-center justify-center gap-2 text-sm font-medium"
        >
          {isRunning ? (
            <><Loader className="w-4 h-4 animate-spin" /> Running Pipeline...</>
          ) : (
            <><Zap className="w-4 h-4" /> Run Through {readyAgents.length} Agent{readyAgents.length !== 1 ? 's' : ''}</>
          )}
        </button>
      </div>

      {/* Workflow Execution Visualization */}
      {workflowSteps.length > 0 && (
        <div className="bg-slate-900 rounded-lg p-3 flex-1 overflow-auto">
          <h3 className="text-xs font-medium text-slate-400 mb-3">Execution Flow</h3>

          <div className="space-y-3">
            {workflowSteps.map((step, idx) => (
              <div key={idx} className={`rounded-lg p-3 ${
                step.status === 'running' ? 'bg-yellow-900/20 border border-yellow-700/50' :
                step.status === 'complete' ? 'bg-green-900/20 border border-green-700/50' :
                step.status === 'error' ? 'bg-red-900/20 border border-red-700/50' :
                'bg-slate-800 border border-slate-700'
              }`}>
                {/* Step Header */}
                <div className="flex items-center gap-2 mb-2">
                  {step.status === 'pending' && <div className="w-5 h-5 rounded-full border-2 border-slate-500" />}
                  {step.status === 'running' && <Loader className="w-5 h-5 text-yellow-400 animate-spin" />}
                  {step.status === 'complete' && <CheckCircle className="w-5 h-5 text-green-400" />}
                  {step.status === 'error' && <AlertCircle className="w-5 h-5 text-red-400" />}

                  <span className="font-medium text-sm">Step {idx + 1}: {step.agentName}</span>

                  {step.endTime && step.startTime && (
                    <span className="text-xs text-slate-500 ml-auto">
                      {((step.endTime - step.startTime) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>

                {/* Input */}
                {step.input && (
                  <div className="mb-2">
                    <div className="text-xs text-slate-500 mb-1">📥 Input:</div>
                    <div className="bg-slate-800 rounded p-2 text-xs text-slate-300 max-h-16 overflow-auto">
                      {step.input.substring(0, 200)}{step.input.length > 200 ? '...' : ''}
                    </div>
                  </div>
                )}

                {/* Output */}
                {step.output && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1">📤 Output:</div>
                    <div className={`rounded p-2 text-xs max-h-24 overflow-auto ${
                      step.status === 'error' ? 'bg-red-900/30 text-red-300' : 'bg-indigo-900/30 text-indigo-200'
                    }`}>
                      {step.output}
                    </div>
                  </div>
                )}

                {/* Arrow to next */}
                {idx < workflowSteps.length - 1 && step.status === 'complete' && (
                  <div className="flex justify-center mt-2">
                    <ArrowRight className="w-4 h-4 text-indigo-400 rotate-90" />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Final Result */}
          {finalResult && (
            <div className="mt-4 p-3 bg-gradient-to-r from-green-900/30 to-indigo-900/30 rounded-lg border border-green-700/50">
              <div className="text-xs text-green-400 font-medium mb-2">🎉 Final Result (after {workflowSteps.length} agents)</div>
              <div className="text-sm text-slate-200">{finalResult}</div>
            </div>
          )}
        </div>
      )}

      {/* Empty State */}
      {workflowSteps.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          <div className="text-center">
            <Users className="w-12 h-12 mx-auto mb-2 opacity-30" />
            <p>Spawn agents, enter a prompt, and watch</p>
            <p>your request flow through each agent!</p>
          </div>
        </div>
      )}
    </div>
  );
}
