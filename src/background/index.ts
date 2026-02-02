/**
 * Operative Service Worker - Coordinator Agent
 *
 * The service worker acts as the central coordinator for the multi-agent runtime:
 * - Maintains the agent registry
 * - Routes messages between contexts
 * - Handles lifecycle events
 * - Persists state before suspension
 */

import { BroadcastManager } from '../runtime/channels/BroadcastManager';
import {
  AgentIdentity,
  AgentMessage,
  CHANNELS,
  generateAgentId,
  RegistryRegisterPayload,
  RegistryQueryPayload,
  TaskDelegatePayload,
  HeartbeatPongPayload,
  LifecycleSpawnPayload,
  LifecycleTerminatePayload,
} from '../runtime/protocol/types';

// Coordinator identity
const COORDINATOR_IDENTITY: AgentIdentity = {
  id: 'coordinator',
  definitionId: 'system:coordinator',
  contextType: 'service-worker',
};

// Agent registry (in-memory, persisted to IndexedDB on changes)
interface RegisteredAgent {
  identity: AgentIdentity;
  capabilities: string[];
  status: 'idle' | 'busy' | 'error' | 'terminated';
  lastHeartbeat: number;
  currentTaskId?: string;
  registeredAt: number;
}

const agentRegistry: Map<string, RegisteredAgent> = new Map();
const broadcastManager = new BroadcastManager();

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000; // 90 seconds - mark stale after this

// Initialize coordinator
function initializeCoordinator(): void {
  console.log('[Coordinator] Initializing Operative Service Worker');

  // Set coordinator identity
  broadcastManager.setIdentity(COORDINATOR_IDENTITY);

  // Subscribe to system channel for lifecycle events
  broadcastManager.subscribeSystem(handleSystemMessage);

  // Subscribe to task channel for task routing
  broadcastManager.subscribeTasks(handleTaskMessage);

  // Subscribe to memory channel for memory operations
  broadcastManager.subscribeMemory(handleMemoryMessage);

  // Start heartbeat checker
  setInterval(checkAgentHeartbeats, HEARTBEAT_INTERVAL);

  // Load persisted registry from IndexedDB
  loadPersistedRegistry();

  console.log('[Coordinator] Initialized successfully');
}

// Handle system channel messages
async function handleSystemMessage(message: AgentMessage): Promise<void> {
  switch (message.type) {
    case 'registry:register':
      handleAgentRegister(message as AgentMessage<RegistryRegisterPayload>);
      break;

    case 'registry:unregister':
      handleAgentUnregister(message);
      break;

    case 'registry:query':
      handleRegistryQuery(message as AgentMessage<RegistryQueryPayload>);
      break;

    case 'heartbeat:pong':
      handleHeartbeatPong(message as AgentMessage<HeartbeatPongPayload>);
      break;

    case 'lifecycle:spawn':
      handleSpawnRequest(message as AgentMessage<LifecycleSpawnPayload>);
      break;

    case 'lifecycle:ready':
      handleAgentReady(message);
      break;

    case 'lifecycle:terminate':
      handleTerminateRequest(message as AgentMessage<LifecycleTerminatePayload>);
      break;

    case 'lifecycle:terminated':
      handleAgentTerminated(message);
      break;
  }
}

// Handle task channel messages
async function handleTaskMessage(message: AgentMessage): Promise<void> {
  switch (message.type) {
    case 'task:delegate':
      handleTaskDelegate(message as AgentMessage<TaskDelegatePayload>);
      break;

    case 'task:accept':
    case 'task:reject':
    case 'task:progress':
    case 'task:result':
    case 'task:error':
      // Route task messages to the appropriate agent
      routeTaskMessage(message);
      break;
  }
}

// Handle memory channel messages (for logging/routing if needed)
async function handleMemoryMessage(message: AgentMessage): Promise<void> {
  // Memory messages are mostly for notification
  // GlobalMemory handles the actual persistence
  console.debug('[Coordinator] Memory event:', message.type, message.payload);
}

// Register a new agent
function handleAgentRegister(message: AgentMessage<RegistryRegisterPayload>): void {
  const { identity, capabilities, status } = message.payload;

  const registeredAgent: RegisteredAgent = {
    identity,
    capabilities,
    status,
    lastHeartbeat: Date.now(),
    registeredAt: Date.now(),
  };

  agentRegistry.set(identity.id, registeredAgent);
  persistRegistry();

  console.log(`[Coordinator] Agent registered: ${identity.id} (${identity.contextType})`);

  // Broadcast registration to all agents
  broadcastManager.publishSystem(
    'state:update',
    { type: 'broadcast' },
    { event: 'agent:registered', agentId: identity.id }
  );
}

// Unregister an agent
function handleAgentUnregister(message: AgentMessage): void {
  const agentId = message.source.id;
  agentRegistry.delete(agentId);
  persistRegistry();

  console.log(`[Coordinator] Agent unregistered: ${agentId}`);

  // Broadcast unregistration
  broadcastManager.publishSystem(
    'state:update',
    { type: 'broadcast' },
    { event: 'agent:unregistered', agentId }
  );
}

// Handle registry query
function handleRegistryQuery(message: AgentMessage<RegistryQueryPayload>): void {
  const { filter } = message.payload;
  const agents = Array.from(agentRegistry.values())
    .filter((agent) => {
      if (agent.status === 'terminated') return false;
      if (filter?.definitionId && agent.identity.definitionId !== filter.definitionId) return false;
      if (filter?.contextType && agent.identity.contextType !== filter.contextType) return false;
      if (filter?.status && agent.status !== filter.status) return false;
      return true;
    })
    .map((agent) => ({
      identity: agent.identity,
      status: agent.status,
      lastHeartbeat: agent.lastHeartbeat,
    }));

  broadcastManager.publishSystem(
    'registry:response',
    { type: 'agent', agentId: message.source.id },
    { agents },
    { correlationId: message.id }
  );
}

// Handle heartbeat response
function handleHeartbeatPong(message: AgentMessage<HeartbeatPongPayload>): void {
  const agent = agentRegistry.get(message.source.id);
  if (agent) {
    agent.lastHeartbeat = Date.now();
    agent.status = message.payload.status;
    agent.currentTaskId = message.payload.currentTaskId;
  }
}

// Handle spawn request
async function handleSpawnRequest(message: AgentMessage<LifecycleSpawnPayload>): Promise<void> {
  const { definitionId, contextType, config } = message.payload;

  console.log(`[Coordinator] Spawn request: ${definitionId} in ${contextType}`);

  try {
    const newAgentId = generateAgentId();

    switch (contextType) {
      case 'tab':
        // Spawn agent in a new tab
        await spawnInTab(newAgentId, definitionId, config);
        break;

      case 'offscreen':
        // Spawn agent in offscreen document
        await spawnInOffscreen(newAgentId, definitionId, config);
        break;

      case 'content-script':
        // Inject content script into existing tab
        if (config?.tabId) {
          await spawnInExistingTab(newAgentId, definitionId, config.tabId as number, config);
        } else {
          throw new Error('tabId required for content-script context');
        }
        break;

      default:
        throw new Error(`Unsupported context type: ${contextType}`);
    }

    // Notify requester of successful spawn
    broadcastManager.publishSystem(
      'lifecycle:ready',
      { type: 'agent', agentId: message.source.id },
      { capabilities: [] },
      { correlationId: message.id }
    );
  } catch (error) {
    console.error('[Coordinator] Spawn failed:', error);
    broadcastManager.publishSystem(
      'task:error',
      { type: 'agent', agentId: message.source.id },
      {
        taskId: message.id,
        error: error instanceof Error ? error.message : 'Spawn failed',
        recoverable: false,
      },
      { correlationId: message.id }
    );
  }
}

// Spawn agent in new tab
async function spawnInTab(
  agentId: string,
  definitionId: string,
  config?: Record<string, unknown>
): Promise<void> {
  const url = chrome.runtime.getURL(
    `agent.html?agentId=${agentId}&definitionId=${encodeURIComponent(definitionId)}`
  );

  const tab = await chrome.tabs.create({ url, active: false });

  console.log(`[Coordinator] Spawned agent ${agentId} in tab ${tab.id}`);
}

// Spawn agent in offscreen document
async function spawnInOffscreen(
  agentId: string,
  definitionId: string,
  config?: Record<string, unknown>
): Promise<void> {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length === 0) {
    // Create offscreen document
    await chrome.offscreen.createDocument({
      url: `offscreen.html?agentId=${agentId}&definitionId=${encodeURIComponent(definitionId)}`,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Running background AI agent processing',
    });
  }

  console.log(`[Coordinator] Spawned agent ${agentId} in offscreen document`);
}

// Spawn agent via content script in existing tab
async function spawnInExistingTab(
  agentId: string,
  definitionId: string,
  tabId: number,
  config?: Record<string, unknown>
): Promise<void> {
  // Inject the agent bootstrap script
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/agent-bootstrap.js'],
  });

  // Send initialization message to the injected script
  chrome.tabs.sendMessage(tabId, {
    type: 'agent:init',
    agentId,
    definitionId,
    config,
  });

  console.log(`[Coordinator] Spawned agent ${agentId} in tab ${tabId} via content script`);
}

// Handle agent ready notification
function handleAgentReady(message: AgentMessage): void {
  const agent = agentRegistry.get(message.source.id);
  if (agent) {
    agent.status = 'idle';
    agent.lastHeartbeat = Date.now();
  }
  console.log(`[Coordinator] Agent ready: ${message.source.id}`);
}

// Handle terminate request
async function handleTerminateRequest(
  message: AgentMessage<LifecycleTerminatePayload>
): Promise<void> {
  // Forward terminate message to the target agent
  const targetAgentId = (message.target as { agentId?: string }).agentId;
  if (!targetAgentId) return;

  const agent = agentRegistry.get(targetAgentId);
  if (!agent) return;

  // Mark as terminating
  agent.status = 'terminated';

  // Forward the terminate message
  broadcastManager.publishSystem(
    'lifecycle:terminate',
    { type: 'agent', agentId: targetAgentId },
    message.payload
  );
}

// Handle agent terminated notification
function handleAgentTerminated(message: AgentMessage): void {
  const agentId = message.source.id;
  agentRegistry.delete(agentId);
  persistRegistry();

  console.log(`[Coordinator] Agent terminated: ${agentId}`);

  // Broadcast termination
  broadcastManager.publishSystem(
    'state:update',
    { type: 'broadcast' },
    { event: 'agent:terminated', agentId }
  );
}

// Handle task delegation
function handleTaskDelegate(message: AgentMessage<TaskDelegatePayload>): void {
  const { taskId, task, priority } = message.payload;

  // Find an idle agent to handle the task
  const idleAgents = Array.from(agentRegistry.values()).filter(
    (agent) => agent.status === 'idle' && agent.identity.contextType !== 'service-worker'
  );

  if (idleAgents.length === 0) {
    // No idle agents, queue the task or return error
    console.log('[Coordinator] No idle agents available for task:', taskId);
    broadcastManager.publishTask(
      'task:error',
      { type: 'agent', agentId: message.source.id },
      {
        taskId,
        error: 'No idle agents available',
        recoverable: true,
      },
      { correlationId: message.id }
    );
    return;
  }

  // Select the first idle agent (could implement smarter selection)
  const selectedAgent = idleAgents[0];
  selectedAgent.status = 'busy';
  selectedAgent.currentTaskId = taskId;

  // Forward task to selected agent
  broadcastManager.publishTask(
    'task:delegate',
    { type: 'agent', agentId: selectedAgent.identity.id },
    message.payload,
    { correlationId: message.id }
  );

  console.log(`[Coordinator] Delegated task ${taskId} to agent ${selectedAgent.identity.id}`);
}

// Route task messages to appropriate agent
function routeTaskMessage(message: AgentMessage): void {
  // Task results/progress should be routed back to the original requester
  // This requires tracking the original requester (stored in correlationId handling)

  // For now, broadcast task updates so interested parties can listen
  // In a more sophisticated implementation, we'd track request origins
}

// Check agent heartbeats and mark stale agents
function checkAgentHeartbeats(): void {
  const now = Date.now();

  for (const [agentId, agent] of agentRegistry) {
    if (agent.status === 'terminated') continue;

    const timeSinceHeartbeat = now - agent.lastHeartbeat;

    if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT) {
      console.warn(`[Coordinator] Agent ${agentId} appears stale (${timeSinceHeartbeat}ms since heartbeat)`);
      agent.status = 'error';
    }
  }

  // Send heartbeat pings to all agents
  broadcastManager.publishSystem(
    'heartbeat:ping',
    { type: 'broadcast' },
    { timestamp: now }
  );
}

// Persist registry to IndexedDB
async function persistRegistry(): Promise<void> {
  try {
    const data = Array.from(agentRegistry.entries());
    // Use chrome.storage.local for service worker persistence
    await chrome.storage.local.set({ agentRegistry: data });
  } catch (error) {
    console.error('[Coordinator] Failed to persist registry:', error);
  }
}

// Load persisted registry from IndexedDB
async function loadPersistedRegistry(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('agentRegistry');
    if (result.agentRegistry) {
      const entries = result.agentRegistry as [string, RegisteredAgent][];
      for (const [id, agent] of entries) {
        // Mark all as needing heartbeat check
        agent.status = 'error'; // Will be updated when agents respond to heartbeat
        agentRegistry.set(id, agent);
      }
      console.log(`[Coordinator] Loaded ${entries.length} agents from storage`);
    }
  } catch (error) {
    console.error('[Coordinator] Failed to load registry:', error);
  }
}

// Setup Chrome side panel behavior
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Coordinator] Side panel error:', error));

// Listen for messages from content scripts and extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'agent:bootstrap') {
    // Content script is requesting bootstrap info
    sendResponse({
      coordinatorId: COORDINATOR_IDENTITY.id,
      channels: CHANNELS,
    });
    return false;
  }

  if (message.type === 'ai:prompt') {
    // Handle AI prompt request from other contexts
    handleAIPrompt(message.prompt, message.systemPrompt)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'ai:check') {
    // Check AI availability
    checkAIAvailability()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ available: false, error: error.message }));
    return true;
  }

  return false;
});

// Handle AI prompt in service worker (where LanguageModel is available)
async function handleAIPrompt(prompt: string, systemPrompt?: string): Promise<string> {
  if (typeof LanguageModel === 'undefined') {
    throw new Error('LanguageModel not available');
  }

  console.log('[Coordinator] Processing AI prompt...');
  const session = await LanguageModel.create(systemPrompt ? { systemPrompt } : undefined);
  const result = await session.prompt(prompt);
  session.destroy();
  console.log('[Coordinator] AI response generated');
  return result;
}

// Check AI availability
async function checkAIAvailability(): Promise<{ available: boolean; status: string }> {
  if (typeof LanguageModel === 'undefined') {
    return { available: false, status: 'not-defined' };
  }

  const status = await LanguageModel.availability();
  return {
    available: status === 'available' || status === 'downloadable',
    status
  };
}

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Coordinator] Extension installed/updated:', details.reason);
  if (details.reason === 'install') {
    // First install - could set up default agents
  }
});

// Handle service worker suspension (beforeunload equivalent)
self.addEventListener('activate', () => {
  console.log('[Coordinator] Service worker activated');
});

// Initialize the coordinator
initializeCoordinator();

// Export for testing
export {
  COORDINATOR_IDENTITY,
  agentRegistry,
  broadcastManager,
};
