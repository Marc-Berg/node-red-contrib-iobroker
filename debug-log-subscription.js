const EventBus = require('./lib/events/event-bus');
const Orchestrator = require('./lib/orchestrator');

console.log('=== Debug Log Subscription ===');

// Monitor all events
const eventBus = EventBus.getInstance();

// Listen to all relevant events
eventBus.on('log:subscribe_request', (data) => {
    console.log('📋 log:subscribe_request received:', data);
});

eventBus.on('websocket:send', (data) => {
    if (data.payload && data.payload[2] === 'subscribeToLogs') {
        console.log('📤 websocket:send subscribeToLogs:', data);
    }
});

eventBus.on('websocket:message', (data) => {
    console.log('📨 websocket:message received for server:', data.serverId);
    try {
        const message = JSON.parse(data.data.toString());
        if (Array.isArray(message) && message[2] === 'subscribeToLogs') {
            console.log('📨 subscribeToLogs response:', message);
        }
    } catch (e) {
        // Ignore parsing errors
    }
});

eventBus.on('log:subscription_confirmed', (data) => {
    console.log('✅ log:subscription_confirmed emitted:', data);
});

eventBus.on('log:message', (data) => {
    console.log('📝 log:message received:', data);
});

eventBus.on('connection:request', (data) => {
    console.log('🔗 connection:request:', data.id);
});

eventBus.on('auth:success', (data) => {
    console.log('✅ auth:success:', data.serverId);
});

eventBus.on('server:ready', (data) => {
    console.log('🚀 server:ready:', data.serverId);
});

// Monitor orchestrator events
Orchestrator.on('server:ready', (data) => {
    console.log('🎯 Orchestrator server:ready:', data.serverId);
});

Orchestrator.on('log:subscription_confirmed', (data) => {
    console.log('🎯 Orchestrator log:subscription_confirmed (generic):', data);
});

console.log('Monitoring started. Deploy a iob-log node to see the events...');
