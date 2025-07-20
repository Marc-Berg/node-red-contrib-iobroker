const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers, NodeRegistrationHelpers } = require('../lib/utils/node-lifecycle-helpers');

module.exports = function(RED) {
    function IoBrokerGetNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.outputProperty = config.outputProperty?.trim() || "payload";
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Store last retrieved value for status display
        node.lastValue = undefined;
        node.hasRetrievedValue = false;

        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        // Helper function to format values for status display
        function formatValueForStatus(value) {
            let displayValue;
            
            if (value === null) {
                displayValue = "null";
            } else if (value === undefined) {
                displayValue = "undefined";
            } else if (typeof value === 'boolean') {
                displayValue = value ? "true" : "false";
            } else if (typeof value === 'object') {
                try {
                    displayValue = JSON.stringify(value);
                } catch (e) {
                    displayValue = "[Object]";
                }
            } else {
                displayValue = String(value);
            }
            
            if (displayValue.length > 20) {
                return "..." + displayValue.slice(-20);
            }
            
            return displayValue;
        }

        // Helper function to update status with current value
        function updateStatusWithValue() {
            if (node.hasRetrievedValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                node.status({ fill: "green", shape: "dot", text: formattedValue });
            } else {
                node.status({ fill: "green", shape: "dot", text: "Ready" });
            }
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'ready', 'Ready');
                updateStatusWithValue();
            }
        };

        const onGetStateResponse = ({ serverId, stateId, state, nodeId }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                node.log(`Get state response: ${stateId} = ${state?.val}`);
                
                if (node.pendingMessage) {
                    const msg = node.pendingMessage;
                    node.pendingMessage = null;
                    
                    // Set the value
                    const valueToSet = state?.val !== undefined ? state.val : state;
                    msg[node.outputProperty] = valueToSet;
                    msg.state = state;
                    msg.timestamp = Date.now();
                    
                    node.lastValue = valueToSet;
                    node.hasRetrievedValue = true;
                    updateStatusWithValue();
                    
                    // Send the message
                    node.send(msg);
                    
                    // Complete the input processing
                    if (node.pendingDone) {
                        node.pendingDone();
                        node.pendingDone = null;
                    }
                }
            }
        };

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'disconnected', 'Disconnected');
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
        };

        // --- Node Input Handler ---

        node.on('input', function(msg, send, done) {
            try {
                // Check if orchestrator is ready
                if (!node.isRegistered) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Node not registered');
                    if (done) done(new Error('Node not registered with orchestrator'));
                    return;
                }

                // Get state ID from config or message topic
                const configState = config.state?.trim();
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Missing state ID');
                    if (done) done(new Error('State ID is required'));
                    return;
                }

                // Store the message and done callback for async processing
                node.pendingMessage = msg;
                node.pendingDone = done;

                StatusHelpers.updateConnectionStatus(node, 'requesting', `Reading ${stateId}...`);

                // Request the state value through the orchestrator
                Orchestrator.getState(node.id, stateId);
                
            } catch (error) {
                StatusHelpers.updateConnectionStatus(node, 'error', 'Error');
                node.error(`Error processing input: ${error.message}`);
                if (done) done(error);
            }
        });

        // --- Node Lifecycle ---

        const eventHandlers = {
            onServerReady,
            onGetStateResponse,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        };

        NodeRegistrationHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 300);

        node.on('close', function(removed, done) {
            // Clean up any pending operations
            node.pendingMessage = null;
            node.pendingDone = null;
            
            const cleanupCallbacks = [];
            NodeRegistrationHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);
            done();
        });

        // Initial status
        StatusHelpers.updateConnectionStatus(node, 'waiting', 'Waiting for server...');
    }

    RED.nodes.registerType("iobget", IoBrokerGetNode);
};