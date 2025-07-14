const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers, NodePatterns } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.lastValue = undefined;
        node.hasRetrievedValue = false;

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

        function updateStatusWithValue() {
            if (node.hasRetrievedValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                setStatus("green", "dot", formattedValue);
            } else {
                setStatus("green", "dot", "Ready");
            }
        }

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus
        );

        node.on('input', async function(msg, send, done) {
            try {
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
                
                const valueToSet = state?.val !== undefined ? state.val : state;
                msg[settings.outputProperty] = valueToSet;
                msg.state = state;
                msg.timestamp = Date.now();
                
                node.lastValue = valueToSet;
                node.hasRetrievedValue = true;
                updateStatusWithValue();
                
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