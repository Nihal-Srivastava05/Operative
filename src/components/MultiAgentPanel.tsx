import React, { useState, useEffect, useRef } from 'react';
import { Play, Users, Zap, Trash2, ExternalLink } from 'lucide-react';
import { db, Agent } from '../store/db';

interface SpawnedAgent {
  id: string;
  definitionId: string;
  name: string;
  status: 'spawning' | 'ready' | 'busy' | 'error';
  tabId?: number;
}

const CHANNELS = {
  SYSTEM: 'operative:system',
  TASKS: 'operative:tasks',
};

export function MultiAgentPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [spawnedAgents, setSpawnedAgents] = useState<SpawnedAgent[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [taskInput, setTaskInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const systemChannelRef = useRef<BroadcastChannel | null>(null);
  const tasksChannelRef = useRef<BroadcastChannel | null>(null);
  const panelId = useRef(`panel_${Date.now()}`);

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

    // Listen for system messages
    systemChannelRef.current.onmessage = (event) => {
      const message = event.data;
      if (!message) return;

      // Ignore our own messages
      if (message.source?.id === panelId.current) return;

      const sourceId = message.source?.id || 'unknown';
      const shortId = sourceId.substring(0, 12);

      if (message.type === 'lifecycle:ready') {
        addLog(`[lifecycle:ready] Agent ${shortId} is ready`);
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'ready' } : a
          )
        );
      }

      if (message.type === 'registry:register') {
        addLog(`[registry:register] Agent ${shortId} registered`);
      }

      if (message.type === 'heartbeat:ping') {
        addLog(`[heartbeat:ping] from ${shortId}`);
      }

      if (message.type === 'lifecycle:terminated') {
        addLog(`[lifecycle:terminated] Agent ${shortId}`);
        setSpawnedAgents(prev => prev.filter(a => a.id !== message.source?.id));
      }
    };

    // Listen for task messages
    tasksChannelRef.current.onmessage = (event) => {
      const message = event.data;
      if (!message || message.source?.id === panelId.current) return;

      const sourceId = message.source?.id || 'unknown';
      const shortId = sourceId.substring(0, 12);

      if (message.type === 'task:accept') {
        addLog(`[task:accept] Agent ${shortId} accepted task`);
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'busy' } : a
          )
        );
      }

      if (message.type === 'task:result') {
        const result = message.payload?.result;
        const preview = typeof result === 'string' ? result.substring(0, 60) : JSON.stringify(result).substring(0, 60);
        addLog(`[task:result] ${shortId}: ${preview}...`);
        setSpawnedAgents(prev =>
          prev.map(a =>
            a.id === message.source?.id ? { ...a, status: 'ready' } : a
          )
        );
      }

      if (message.type === 'task:error') {
        addLog(`[task:error] ${shortId}: ${message.payload?.error}`);
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

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-29), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const createMessage = (type: string, target: any, payload: any) => {
    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type,
      source: {
        id: panelId.current,
        definitionId: 'system:panel',
        contextType: 'side-panel',
      },
      target,
      payload,
      timestamp: Date.now(),
    };
  };

  const spawnAgent = async () => {
    if (!selectedAgent) return;

    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;

    const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    addLog(`Spawning ${agent.name} in new tab...`);

    const newSpawned: SpawnedAgent = {
      id: agentId,
      definitionId: agent.id,
      name: agent.name,
      status: 'spawning',
    };

    setSpawnedAgents(prev => [...prev, newSpawned]);

    try {
      const url = chrome.runtime.getURL(
        `agent.html?agentId=${agentId}&definitionId=${encodeURIComponent(agent.id)}`
      );

      const tab = await chrome.tabs.create({ url, active: false });

      setSpawnedAgents(prev =>
        prev.map(a =>
          a.id === agentId ? { ...a, tabId: tab.id } : a
        )
      );

      addLog(`Tab ${tab.id} created for ${agent.name}`);
    } catch (error: any) {
      addLog(`Error: ${error.message}`);
      setSpawnedAgents(prev =>
        prev.map(a =>
          a.id === agentId ? { ...a, status: 'error' } : a
        )
      );
    }
  };

  const sendTaskToAgent = async (targetAgentId: string) => {
    if (!taskInput.trim() || !tasksChannelRef.current) return;

    const taskId = `task_${Date.now()}`;
    addLog(`Sending task to agent...`);

    const message = createMessage('task:delegate', { type: 'agent', agentId: targetAgentId }, {
      taskId,
      task: taskInput,
      priority: 'normal',
    });

    tasksChannelRef.current.postMessage(message);
    addLog(`Task sent: "${taskInput.substring(0, 40)}..."`);
    setTaskInput('');
  };

  const terminateAgent = async (agentId: string, tabId?: number) => {
    addLog(`Terminating agent...`);

    if (systemChannelRef.current) {
      const message = createMessage('lifecycle:terminate', { type: 'agent', agentId }, {
        reason: 'requested',
        graceful: true,
      });
      systemChannelRef.current.postMessage(message);
    }

    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        // Tab might already be closed
      }
    }

    setSpawnedAgents(prev => prev.filter(a => a.id !== agentId));
    addLog(`Agent terminated`);
  };

  // Store results for chained workflow
  const workflowResultsRef = useRef<Map<string, string>>(new Map());

  const runWorkflowDemo = async () => {
    const readyAgents = spawnedAgents.filter(a => a.status === 'ready');
    if (readyAgents.length < 2 || !tasksChannelRef.current) {
      addLog('Need at least 2 ready agents for workflow demo');
      return;
    }

    setIsRunning(true);
    workflowResultsRef.current.clear();
    addLog('🔗 Starting CHAINED workflow (Agent1 → Agent2)...');
    addLog(`Step 1: ${readyAgents[0].name} will write content`);
    addLog(`Step 2: ${readyAgents[1].name} will review/improve it`);

    const task1Id = `chain_${Date.now()}_step1`;

    // Listen for task1 result to chain to task2
    const handleChainResult = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'task:result') return;

      const taskId = message.payload?.taskId;
      const result = message.payload?.result;

      if (taskId === task1Id && result) {
        addLog(`✅ Step 1 complete! Output: "${result.substring(0, 50)}..."`);
        workflowResultsRef.current.set('step1', result);

        // NOW send to Agent 2 with Agent 1's output
        addLog(`🔗 Passing output to ${readyAgents[1].name} for review...`);

        const task2Id = `chain_${Date.now()}_step2`;
        const chainedTask = `Review and improve this content. Add any missing facts or corrections:\n\n"${result}"`;

        const msg2 = createMessage('task:delegate', { type: 'agent', agentId: readyAgents[1].id }, {
          taskId: task2Id,
          task: chainedTask,
          priority: 'normal',
          context: { previousOutput: result, step: 2 }
        });
        tasksChannelRef.current?.postMessage(msg2);
        addLog(`📤 Step 2 task sent with Step 1 output`);
      }

      // Check for step 2 completion
      if (taskId?.includes('step2') && result) {
        addLog(`✅ Step 2 complete! Final output: "${result.substring(0, 60)}..."`);
        addLog('🎉 WORKFLOW COMPLETE: Agent1 → Agent2 chain finished!');
        setIsRunning(false);
        tasksChannelRef.current?.removeEventListener('message', handleChainResult as any);
      }
    };

    tasksChannelRef.current.addEventListener('message', handleChainResult as any);

    // Start the chain with Agent 1
    const msg1 = createMessage('task:delegate', { type: 'agent', agentId: readyAgents[0].id }, {
      taskId: task1Id,
      task: 'Write 2-3 sentences about the benefits of exercise for mental health.',
      priority: 'normal',
      context: { step: 1 }
    });
    tasksChannelRef.current.postMessage(msg1);
    addLog(`📤 Step 1 task sent to ${readyAgents[0].name}`);

    // Timeout safety
    setTimeout(() => {
      if (isRunning) {
        setIsRunning(false);
        addLog('⚠️ Workflow timeout');
      }
    }, 60000);
  };

  const readyCount = spawnedAgents.filter(a => a.status === 'ready').length;

  return (
    <div className="h-full flex flex-col p-4 overflow-hidden">
      <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
        <Users className="w-5 h-5 text-indigo-400" />
        Multi-Agent Control Panel
      </h2>

      {/* Spawn Section */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3">
        <h3 className="text-sm font-medium text-slate-400 mb-2">Spawn Agent in Tab</h3>
        <div className="flex gap-2">
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="flex-1 bg-slate-700 border border-slate-600 rounded p-2 text-sm"
          >
            {agents.length === 0 && <option value="">No agents available</option>}
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            onClick={spawnAgent}
            disabled={!selectedAgent}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 rounded flex items-center gap-1 text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            Spawn
          </button>
        </div>
      </div>

      {/* Active Agents */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3 flex-1 overflow-auto min-h-[120px]">
        <h3 className="text-sm font-medium text-slate-400 mb-2">
          Active Agents ({spawnedAgents.length}) - Ready: {readyCount}
        </h3>
        {spawnedAgents.length === 0 ? (
          <p className="text-slate-500 text-sm">No agents spawned yet.</p>
        ) : (
          <div className="space-y-2">
            {spawnedAgents.map(agent => (
              <div
                key={agent.id}
                className="bg-slate-700 rounded p-2 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    agent.status === 'ready' ? 'bg-green-500' :
                    agent.status === 'busy' ? 'bg-yellow-500 animate-pulse' :
                    agent.status === 'error' ? 'bg-red-500' :
                    'bg-blue-500 animate-pulse'
                  }`} />
                  <span className="text-sm font-medium">{agent.name}</span>
                  <span className="text-xs text-slate-400">({agent.status})</span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => sendTaskToAgent(agent.id)}
                    disabled={agent.status !== 'ready' || !taskInput.trim()}
                    className="p-1.5 hover:bg-slate-600 rounded disabled:opacity-30"
                    title="Send task"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => terminateAgent(agent.id, agent.tabId)}
                    className="p-1.5 hover:bg-slate-600 rounded text-red-400"
                    title="Terminate"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Input */}
      <div className="bg-slate-800 rounded-lg p-3 mb-3">
        <h3 className="text-sm font-medium text-slate-400 mb-2">Send Task</h3>
        <input
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          placeholder="Enter task for selected agent..."
          className="w-full bg-slate-700 border border-slate-600 rounded p-2 text-sm mb-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && readyCount > 0 && taskInput.trim()) {
              const readyAgent = spawnedAgents.find(a => a.status === 'ready');
              if (readyAgent) sendTaskToAgent(readyAgent.id);
            }
          }}
        />
        <button
          onClick={runWorkflowDemo}
          disabled={isRunning || readyCount < 2}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 px-4 py-2 rounded flex items-center justify-center gap-2 text-sm"
        >
          <Zap className="w-4 h-4" />
          {isRunning ? 'Running...' : 'Run Chained Workflow (A→B)'}
        </button>
      </div>

      {/* Logs */}
      <div className="bg-slate-900 rounded-lg p-3 max-h-36 overflow-auto">
        <h3 className="text-sm font-medium text-slate-400 mb-2">Activity Log</h3>
        <div className="font-mono text-xs space-y-0.5">
          {logs.length === 0 ? (
            <p className="text-slate-500">No activity yet...</p>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="text-slate-400 leading-tight">{log}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
