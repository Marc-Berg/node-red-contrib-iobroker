const path = require('path');
const fs = require('fs');

// Simple test to check if the log subscription works
console.log('=== iob-log Test Script ===');

// Load the orchestrator
const Orchestrator = require('./lib/orchestrator');

// Mock a simple node
const mockNode = {
    id: 'test-log-node-123',
    server: { 
        id: 'test-server-456',
        host: 'localhost',
        port: 8084,
        secure: false
    },
    logLevel: 'info',
    log: console.log,
    warn: console.warn,
    error: console.error,
    status: (status) => console.log('Status:', status)
};

console.log('Mock node created:', mockNode.id);

// Listen for the events that the real node would listen for
Orchestrator.on('server:ready', ({ serverId }) => {
    if (serverId === mockNode.server.id) {
        console.log('✅ Server ready event received for:', serverId);
        console.log('🔄 Calling subscribeToLogs...');
        Orchestrator.subscribeToLogs(mockNode.id, mockNode.logLevel);
    }
});

Orchestrator.on(`log:subscription_confirmed:${mockNode.id}`, ({ serverId, nodeId }) => {
    console.log('✅ Log subscription confirmed for node:', nodeId, 'on server:', serverId);
});

Orchestrator.on(`log:message:${mockNode.id}`, ({ serverId, nodeId, logData }) => {
    console.log('📝 Log message received for node:', nodeId, 'message:', logData.message);
});

console.log('Event listeners set up');

// Register the mock node
console.log('📋 Registering mock node...');
Orchestrator.registerNode(mockNode.id, mockNode.server);

console.log('Test script completed. Check the console output for events...');
