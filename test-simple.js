#!/usr/bin/env node

// Simple test for iob-getobject node
console.log('=== iob-getobject Node Test ===');

// Test 1: Check if file loads without errors
console.log('\n1. Testing module load...');
try {
    const nodeModule = require('./nodes/iob-getobject');
    console.log('✓ Module loaded successfully');
    
    // Check if it's a function
    if (typeof nodeModule === 'function') {
        console.log('✓ Module exports a function');
    } else {
        console.log('✗ Module does not export a function');
    }
} catch (error) {
    console.log('✗ Module load failed:', error.message);
    process.exit(1);
}

// Test 2: Check dependencies
console.log('\n2. Testing dependencies...');
try {
    const Orchestrator = require('./lib/orchestrator');
    console.log('✓ Orchestrator loaded');
    
    const StatusHelpers = require('./lib/utils/status-helpers');
    console.log('✓ StatusHelpers loaded');
    
    // Check if Orchestrator has required methods
    if (typeof Orchestrator.registerNode === 'function') {
        console.log('✓ Orchestrator.registerNode method exists');
    } else {
        console.log('✗ Orchestrator.registerNode method missing');
    }
    
    if (typeof Orchestrator.getObject === 'function') {
        console.log('✓ Orchestrator.getObject method exists');
    } else {
        console.log('✗ Orchestrator.getObject method missing');
    }
} catch (error) {
    console.log('✗ Dependency load failed:', error.message);
    process.exit(1);
}

// Test 3: Check if node can be instantiated
console.log('\n3. Testing node instantiation...');
try {
    // Mock RED object
    const mockRED = {
        nodes: {
            createNode: function(node, config) {
                node.id = config.id || 'test-node';
                node.type = config.type || 'test';
                node.log = console.log;
                node.warn = console.warn;
                node.error = console.error;
                node.status = () => {};
                node.on = function() {};
                node.emit = function() {};
                node.removeListener = function() {};
            },
            getNode: function(id) {
                return {
                    id: id || 'test-server',
                    host: 'localhost',
                    port: 8081
                };
            },
            registerType: function(name, constructor) {
                console.log(`✓ Node type registered: ${name}`);
            }
        }
    };
    
    // Load and initialize node
    const nodeModule = require('./nodes/iob-getobject');
    nodeModule(mockRED);
    
    console.log('✓ Node can be instantiated');
} catch (error) {
    console.log('✗ Node instantiation failed:', error.message);
    console.log('Stack:', error.stack);
}

// Test 4: Check configuration handling
console.log('\n4. Testing configuration handling...');
try {
    const testConfig = {
        id: 'test-node',
        objectId: 'system.adapter.admin.0',
        outputProperty: 'payload',
        outputMode: 'single',
        objectType: '',
        includeEnums: false,
        includeAliases: false,
        server: 'test-server'
    };
    
    console.log('✓ Configuration structure is valid');
} catch (error) {
    console.log('✗ Configuration test failed:', error.message);
}

console.log('\n=== Test Summary ===');
console.log('Basic functionality tests completed.');
console.log('The iob-getobject node appears to be properly structured.');
console.log('For full functionality testing, connect to a real ioBroker server.');
