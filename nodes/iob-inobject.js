const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobinobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);

        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const objectPattern = config.objectPattern?.trim();
        if (!objectPattern) {
            return setError("Object Pattern missing", "Pattern missing");
        }

        const isWildcardPattern = objectPattern.includes('*');

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId,
            nodeId: node.id,
            useWildcard: isWildcardPattern
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.isSubscribed = false;
        node.objectPattern = objectPattern;

        function createMessage(objectId, objectData, operation = 'update') {
            const message = {
                topic: objectId,
                object: objectData,
                operation: operation,
                timestamp: Date.now()
            };

            if (isWildcardPattern) {
                message.pattern = node.objectPattern;
            }

            message[settings.outputProperty] = objectData;
            return message;
        }

        function onObjectChange(objectId, objectData, operation) {
            try {
                if (!objectData) {
                    
                    operation = 'delete';
                    objectData = { _id: objectId, deleted: true };
                }

                const message = createMessage(objectId, objectData, operation);
                node.send(message);

                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false });
                const statusText = isWildcardPattern
                    ? `Pattern active - Last: ${timestamp}`
                    : `Last: ${timestamp}`;
                setStatus("green", "dot", statusText);

            } catch (error) {
                node.error(`Object change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }

        function createCallback() {
            const callback = onObjectChange;

            
            const statusTexts = {
                ready: isWildcardPattern
                    ? `Pattern ready: ${node.objectPattern}`
                    : "Ready",
                disconnected: "Disconnected"
            };

            
            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node,
                setStatus,
                () => {
                    node.isSubscribed = true;
                },
                statusTexts
            );

            
            Object.assign(callback, baseCallback);

            
            callback.wantsInitialValue = false;

            return callback;
        }

        async function initialize() {
            
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");

                
                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                const callback = createCallback();

                
                await connectionManager.subscribeObjects(
                    settings.nodeId,
                    settings.serverId,
                    objectPattern,
                    callback,
                    globalConfig
                );

                node.isSubscribed = true;

                const patternInfo = isWildcardPattern
                    ? `wildcard pattern: ${objectPattern}`
                    : `single object: ${objectPattern}`;


                setStatus("green", "dot", isWildcardPattern ? `Pattern: ${objectPattern}` : "Ready");
                node.isInitialized = true;

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';

                if (errorMsg.includes('auth_failed') || errorMsg.includes('Authentication failed')) {
                    
                    setStatus("red", "ring", "Auth failed");
                } else if (errorMsg.includes('not possible in state')) {
                    
                    setStatus("red", "ring", "Connection failed");
                } else {
                    
                    setStatus("yellow", "ring", "Retrying...");
                }

                node.isSubscribed = false;
            }
        }

        node.on("close", async function (removed, done) {
            node.isInitialized = false;
            node.isSubscribed = false;

            try {
                await NodeHelpers.handleNodeClose(node, settings, 'object-subscription');
                await connectionManager.unsubscribeObjects(
                    settings.nodeId,
                    settings.serverId,
                    objectPattern
                );
            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));

        
        initialize();
    }

    RED.nodes.registerType("iobinobject", iobinobject);
};