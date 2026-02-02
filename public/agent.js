// =====================================================================
// Operative Agent - Standalone Script
// =====================================================================

const CHANNELS = {
    SYSTEM: 'operative:system',
    TASKS: 'operative:tasks',
};

let agentId = '';
let definitionId = '';
let agentName = 'Unknown';
let systemPrompt = 'You are a helpful assistant.';
let status = 'initializing';

// DOM Elements
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const agentIdEl = document.getElementById('agent-id');
const definitionIdEl = document.getElementById('definition-id');
const aiStatusEl = document.getElementById('ai-status');
const currentTaskEl = document.getElementById('current-task');
const logEl = document.getElementById('log');

// =====================================================================
// Utilities
// =====================================================================

function log(message, type = 'info') {
    console.log(`[Agent] ${message}`);
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

function updateStatus(newStatus) {
    status = newStatus;
    statusEl.className = `status ${newStatus}`;
    statusTextEl.textContent = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
}

function parseParams() {
    const params = new URLSearchParams(window.location.search);
    const aid = params.get('agentId');
    const did = params.get('definitionId');
    log(`URL params: agentId=${aid ? aid.substring(0, 15) + '...' : 'none'}`);
    return {
        agentId: aid || `agent_${Date.now()}`,
        definitionId: did || '',
    };
}

function createIdentity() {
    return {
        id: agentId,
        definitionId: definitionId,
        contextType: 'tab',
    };
}

function createMessage(type, target, payload, correlationId) {
    return {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        correlationId,
        type,
        source: createIdentity(),
        target,
        payload,
        timestamp: Date.now(),
    };
}

// =====================================================================
// BroadcastChannel Setup
// =====================================================================

let systemChannel, tasksChannel;

try {
    systemChannel = new BroadcastChannel(CHANNELS.SYSTEM);
    tasksChannel = new BroadcastChannel(CHANNELS.TASKS);
    log('BroadcastChannels created', 'success');
} catch (e) {
    log(`BroadcastChannel error: ${e.message}`, 'error');
}

if (systemChannel) {
    systemChannel.onmessage = (event) => {
        const message = event.data;
        if (!message || message.source?.id === agentId) return;

        if (message.type === 'heartbeat:ping') {
            const pong = createMessage('heartbeat:pong', { type: 'coordinator' }, {
                timestamp: Date.now(),
                originalTimestamp: message.payload?.timestamp,
                status: status,
            }, message.id);
            systemChannel.postMessage(pong);
        }

        if (message.type === 'lifecycle:terminate' && message.target?.agentId === agentId) {
            log('Termination requested', 'warn');
            updateStatus('error');
        }
    };
}

if (tasksChannel) {
    tasksChannel.onmessage = async (event) => {
        const message = event.data;
        if (!message || message.source?.id === agentId) return;

        const target = message.target;
        const isForUs = target?.type === 'broadcast' ||
                       (target?.type === 'agent' && target?.agentId === agentId) ||
                       (target?.type === 'definition' && target?.definitionId === definitionId);

        if (!isForUs) return;

        if (message.type === 'task:delegate') {
            await handleTask(message);
        }
    };
}

// =====================================================================
// Task Handler
// =====================================================================

async function handleTask(message) {
    const payload = message.payload;
    log(`Task received: ${payload.task.substring(0, 50)}...`);

    if (status !== 'idle') {
        const reject = createMessage('task:reject', { type: 'agent', agentId: message.source.id }, {
            taskId: payload.taskId,
            reason: `Agent is ${status}`,
        }, message.id);
        tasksChannel.postMessage(reject);
        return;
    }

    updateStatus('busy');
    currentTaskEl.textContent = payload.task.substring(0, 40) + '...';

    const accept = createMessage('task:accept', { type: 'agent', agentId: message.source.id }, {
        taskId: payload.taskId,
    }, message.id);
    tasksChannel.postMessage(accept);

    try {
        log('Calling AI via service worker...');
        const result = await promptAI(payload.task, systemPrompt);
        log(`Response received (${result.length} chars)`, 'success');

        const resultMsg = createMessage('task:result', { type: 'agent', agentId: message.source.id }, {
            taskId: payload.taskId,
            result: result,
        }, message.id);
        tasksChannel.postMessage(resultMsg);
        log('Result sent back', 'success');

    } catch (error) {
        log(`Error: ${error.message}`, 'error');
        const errorMsg = createMessage('task:error', { type: 'agent', agentId: message.source.id }, {
            taskId: payload.taskId,
            error: error.message,
            recoverable: false,
        }, message.id);
        tasksChannel.postMessage(errorMsg);
    }

    updateStatus('idle');
    currentTaskEl.textContent = 'None';
}

// =====================================================================
// AI Functions (via Service Worker)
// =====================================================================

function checkAI() {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: 'ai:check' }, (response) => {
                if (chrome.runtime.lastError) {
                    log(`AI check error: ${chrome.runtime.lastError.message}`, 'warn');
                    resolve({ available: false, status: 'error' });
                } else {
                    resolve(response || { available: false, status: 'unknown' });
                }
            });
        } catch (e) {
            log(`AI check exception: ${e.message}`, 'error');
            resolve({ available: false, status: 'exception' });
        }
    });
}

function promptAI(prompt, sysPrompt) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(
                { type: 'ai:prompt', prompt, systemPrompt: sysPrompt },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response?.success) {
                        resolve(response.result);
                    } else {
                        reject(new Error(response?.error || 'AI request failed'));
                    }
                }
            );
        } catch (e) {
            reject(e);
        }
    });
}

// =====================================================================
// IndexedDB - Load Agent Definition
// =====================================================================

function loadAgentDefinition(defId) {
    return new Promise((resolve, reject) => {
        log(`Loading definition: ${defId.substring(0, 15)}...`);

        const request = indexedDB.open('OperativeDB');

        request.onerror = (e) => {
            log(`DB error: ${e.target.error}`, 'error');
            reject(new Error('Failed to open database'));
        };

        request.onsuccess = (event) => {
            const db = event.target.result;

            try {
                const transaction = db.transaction(['agents'], 'readonly');
                const store = transaction.objectStore('agents');
                const getRequest = store.get(defId);

                getRequest.onsuccess = () => {
                    if (getRequest.result) {
                        log(`Found: ${getRequest.result.name}`, 'success');
                        resolve(getRequest.result);
                    } else {
                        log(`Not found: ${defId}`, 'warn');
                        reject(new Error('Agent not found'));
                    }
                };

                getRequest.onerror = (e) => {
                    reject(new Error('DB get failed'));
                };
            } catch (e) {
                log(`Transaction error: ${e.message}`, 'error');
                reject(e);
            }
        };
    });
}

// =====================================================================
// Initialization
// =====================================================================

async function init() {
    log('=== Agent Init ===');

    try {
        // Parse URL parameters
        const params = parseParams();
        agentId = params.agentId;
        definitionId = params.definitionId;

        agentIdEl.textContent = agentId;
        definitionIdEl.textContent = definitionId.substring(0, 25) + '...';

        if (!definitionId) {
            log('No definition ID!', 'error');
            updateStatus('error');
            return;
        }

        // Check AI
        log('Checking AI...');
        const aiStatus = await checkAI();
        aiStatusEl.textContent = aiStatus.status || 'unknown';
        log(`AI: ${aiStatus.status}`, aiStatus.available ? 'success' : 'warn');

        // Load definition
        try {
            const definition = await loadAgentDefinition(definitionId);
            agentName = definition.name || 'Unknown';
            systemPrompt = definition.systemPrompt || 'You are a helpful assistant.';
        } catch (e) {
            log(`Using defaults: ${e.message}`, 'warn');
        }

        // Register
        if (systemChannel) {
            systemChannel.postMessage(createMessage('registry:register', { type: 'coordinator' }, {
                identity: createIdentity(),
                capabilities: [],
                status: 'idle',
            }));

            systemChannel.postMessage(createMessage('lifecycle:ready', { type: 'coordinator' }, {
                capabilities: [],
            }));
            log('Registered', 'success');
        }

        updateStatus('idle');
        log('=== Ready ===', 'success');

    } catch (e) {
        log(`Init failed: ${e.message}`, 'error');
        updateStatus('error');
    }
}

// Cleanup
window.addEventListener('beforeunload', () => {
    if (systemChannel) {
        systemChannel.postMessage(createMessage('lifecycle:terminated', { type: 'coordinator' }, {}));
        systemChannel.postMessage(createMessage('registry:unregister', { type: 'coordinator' }, {}));
    }
});

// Start
init();
