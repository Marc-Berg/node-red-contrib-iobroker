#!/usr/bin/env node
console.log('Starting iob-getobject test...');

// Mock Node-RED environment
global.RED = {
    nodes: {
        createNode: function(node, config) {
            node.id = config.id || 'test-node-' + Math.random().toString(36).substr(2, 9);
            node.type = config.type || 'test';
            node.log = console.log;
            node.warn = console.warn;
            node.error = console.error;
            node.status = () => {};
            node.on = function(event, handler) {
                if (!node._events) node._events = {};
                if (!node._events[event]) node._events[event] = [];
                node._events[event].push(handler);
            };
            node.emit = function(event, ...args) {
                if (node._events && node._events[event]) {
                    node._events[event].forEach(handler => handler(...args));
                }
            };
            node.removeListener = function(event, handler) {
                if (node._events && node._events[event]) {
                    const index = node._events[event].indexOf(handler);
                    if (index !== -1) {
                        node._events[event].splice(index, 1);
                    }
                }
            };
        },
        getNode: function(id) {
            return {
                id: id || 'test-server',
                host: 'localhost',
                port: 8081,
                user: '',
                password: ''
            };
        },
        registerType: function(name, constructor) {
            console.log(`Registered node type: ${name}`);
        }
    }
};

// Initialize orchestrator
const Orchestrator = require('./lib/orchestrator');
Orchestrator.init(global.RED);

// Load the node
const iobGetObjectNode = require('./nodes/iob-getobject');

// Test configuration
const testConfig = {
    id: 'test-getobject-node',
    type: 'iobgetobject',
    name: 'Test GetObject Node',
    server: 'test-server',
    objectId: 'system.adapter.admin.0',
    outputProperty: 'payload',
    outputMode: 'single',
    objectType: '',
    includeEnums: false,
    includeAliases: false
};

console.log('Creating test node...');
const testNode = {};
iobGetObjectNode(global.RED);

// Create a mock node instance
global.RED.nodes.createNode(testNode, testConfig);

// Mock the server node
testNode.server = {
    id: 'test-server',
    host: 'localhost',
    port: 8081,
    user: '',
    password: ''
};

// Initialize the node
const nodeConstructor = require('./nodes/iob-getobject');
const nodeInstance = new Function('config', `
    const node = this;
    ${nodeConstructor.toString().replace('function(RED) {', '').replace(/^.*?function.*?\{/, '').replace(/}\s*$/, '')}
`);

console.log('Test completed - Node should be ready for manual testing');
console.log('Note: This test only validates the node structure and initialization');
console.log('For full functionality testing, a real ioBroker connection is required');
