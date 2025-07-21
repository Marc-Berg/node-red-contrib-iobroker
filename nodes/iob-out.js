/*!
 * ioBroker Output Node - Simplified with Helpers
 * Sends values to ioBroker states
 */

const { NodeHelpers, NodePatterns } = require('../lib/utils/node-helpers');
const { OutputHelpers } = require('../lib/utils/output-helpers');

module.exports = function(RED) {
    function IoBrokerOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Node configuration
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

        // Initialize output node specific functionality
        OutputHelpers.initializeOutputNode(node);

        // Setup status texts
        const statusTexts = {
            ready: node.autoCreate ? "Ready (auto-create)" : "Ready",
            disconnected: "Disconnected"
        };

        // Initialize connection using standard pattern
        NodePatterns.setupOutputNode(node, config, RED, statusTexts)
            .then(result => {
                if (!result) return; // Setup failed, error already handled
                
                const { settings, setStatus, setError } = result;
                
                // Setup output-specific event handlers
                const cleanupOutputHandlers = OutputHelpers.setupOutputEventHandlers(node, setStatus);
                
                // Store cleanup function
                node._outputCleanup = cleanupOutputHandlers;
                
                // Handle server ready event to update status with value
                const originalHandlers = node._eventHandlers;
                const onServerReady = originalHandlers.onServerReady;
                
                // Override server ready to include value status
                node._eventHandlers.onServerReady = ({ serverId }) => {
                    onServerReady({ serverId }); // Call original handler
                    if (serverId === settings.serverId) {
                        OutputHelpers.updateStatusWithValue(node, node.autoCreate);
                    }
                };
                
                // Input handler
                node.on('input', async function(msg, send, done) {
                    // Handle status requests
                    if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                        return;
                    }
                    
                    // Process input using helper
                    await OutputHelpers.processInput(
                        node, msg, send, done, 
                        node.inputProperty, 
                        node.configState, 
                        node.setMode, 
                        setStatus
                    );
                });
                
                // Node cleanup
                node.on('close', function(done) {
                    // Output-specific cleanup
                    OutputHelpers.cleanup(node);
                    if (node._outputCleanup) {
                        node._outputCleanup();
                    }
                    
                    // Standard cleanup
                    NodeHelpers.handleNodeClose(node, settings, 'out')
                        .then(() => done())
                        .catch(error => {
                            node.error(`Cleanup error: ${error.message}`);
                            done();
                        });
                });
            })
            .catch(error => {
                node.error(`Output node setup failed: ${error.message}`);
            });
    }

    RED.nodes.registerType("iobout", IoBrokerOutNode);
};
