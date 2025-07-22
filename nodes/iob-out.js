const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers } = require('../lib/utils/status-helpers');
const { NodeRegistrationHelpers } = require('../lib/utils/node-registration-helpers');
const { OutputHelpers } = require('../lib/utils/output-helpers');

module.exports = function(RED) {
    function IoBrokerOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.inputProperty = config.inputProperty?.trim() || "payload";
        node.setMode = config.setMode || "value";
        node.autoCreate = config.autoCreate || false;
        node.configState = config.state?.trim();
        
        // Auto-create object settings
        node.stateName = config.stateName?.trim() || "";
        node.stateRole = config.stateRole?.trim() || "";
        node.payloadType = config.payloadType?.trim() || "";
        node.stateReadonly = config.stateReadonly?.trim() || "";
        node.stateUnit = config.stateUnit?.trim() || "";
        node.stateMin = config.stateMin !== "" ? parseFloat(config.stateMin) : undefined;
        node.stateMax = config.stateMax !== "" ? parseFloat(config.stateMax) : undefined;
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Initialize output node specific functionality
        OutputHelpers.initializeOutputNode(node);

        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'ready', 'Ready');
                OutputHelpers.updateStatusWithValue(node, node.autoCreate);
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

        // Setup output-specific event handlers using OutputHelpers
        const outputCleanupHandlers = OutputHelpers.setupOutputEventHandlers(node, (fill, shape, text) => {
            StatusHelpers.updateConnectionStatus(node, fill === 'red' ? 'error' : 'setting', text);
        });

        // --- Node Input Handler ---

        node.on('input', async function(msg, send, done) {
            try {
                // Check if orchestrator is ready
                if (!node.isRegistered) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Node not registered');
                    if (done) done(new Error('Node not registered with orchestrator'));
                    return;
                }

                // Get state ID from config or message topic
                const stateId = node.configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Missing state ID');
                    if (done) done(new Error('State ID is required'));
                    return;
                }

                // Get value from message
                const value = msg[node.inputProperty];
                if (value === undefined) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Input missing');
                    node.error(`Input property "${node.inputProperty}" not found in message`);
                    if (done) done(new Error(`Input property "${node.inputProperty}" not found in message`));
                    return;
                }

                // Check/create object if auto-create is enabled
                if (node.autoCreate) {
                    StatusHelpers.updateConnectionStatus(node, 'checking', 'Checking object...');
                    try {
                        await OutputHelpers.ensureObjectExists(node, stateId, msg, value);
                    } catch (error) {
                        StatusHelpers.updateConnectionStatus(node, 'error', 'Object creation failed');
                        node.error(`Object creation failed for ${stateId}: ${error.message}`);
                        if (done) done(error);
                        return;
                    }
                }

                // Set the state
                const ack = node.setMode === "value";
                StatusHelpers.updateConnectionStatus(node, 'setting', 'Setting...');
                
                const operationId = ++node.operationCounter;
                node.pendingOperations.set(operationId, {
                    operation: 'setState',
                    stateId: stateId,
                    value: value,
                    done: done
                });
                
                Orchestrator.setState(node.id, stateId, value, ack);
                
            } catch (error) {
                StatusHelpers.updateConnectionStatus(node, 'error', 'Error');
                node.error(`Failed to process input: ${error.message}`);
                if (done) done(error);
            }
        });

        // --- Node Lifecycle ---

        const eventHandlers = {
            onServerReady,
            onDisconnected,
            onRetrying,
            onPermanentFailure
        };

        // Use NodeRegistrationHelpers for registration and cleanup
        NodeRegistrationHelpers.setupDelayedRegistrationWithListeners(node, eventHandlers, 300);

        const cleanupCallbacks = [
            () => OutputHelpers.cleanup(node),
            outputCleanupHandlers
        ];

        NodeRegistrationHelpers.setupCloseHandler(node, eventHandlers, cleanupCallbacks);

        // Initial status
        const initialStatusText = node.autoCreate ? "Waiting for server... (auto-create)" : "Waiting for server...";
        StatusHelpers.updateConnectionStatus(node, 'waiting', initialStatusText);
    }

    RED.nodes.registerType("iobout", IoBrokerOutNode);
};
