const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers, NodePatterns } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        // Node-specific configuration
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        // Initialize connection using helper
        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus
        );

        node.on('input', async function(msg, send, done) {
            try {
                // Handle status requests using helper
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }
                
                const configState = config.state?.trim();
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!NodeHelpers.validateRequiredInput(stateId, "State ID", setStatus, done)) {
                    return;
                }

                setStatus("blue", "dot", `Reading ${stateId}...`);

                const state = await connectionManager.getState(settings.serverId, stateId);
                
                msg[settings.outputProperty] = state?.val !== undefined ? state.val : state;
                msg.state = state;
                msg.timestamp = Date.now();
                
                setStatus("green", "dot", "Ready");
                send(msg);
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "Get");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobget", iobget);
};