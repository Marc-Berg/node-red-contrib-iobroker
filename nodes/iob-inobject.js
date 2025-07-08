const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function (RED) {
    function iobinobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
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

        // Log pattern type for debugging
        node.log(`Object subscription pattern: ${objectPattern} (${isWildcardPattern ? 'wildcard' : 'single'})`);

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
                    // Object was deleted
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

            // Custom status texts for object subscription
            const statusTexts = {
                ready: isWildcardPattern
                    ? `Pattern ready: ${node.objectPattern}`
                    : "Ready",
                disconnected: "Disconnected"
            };

            // Use helper for subscription event handling
            const baseCallback = NodeHelpers.createSubscriptionEventCallback(
                node, 
                setStatus,
                () => { 
                    node.log("Object subscription successful");
                    node.isSubscribed = true; 
                },
                statusTexts
            );

            // Merge the callbacks
            Object.assign(callback, baseCallback);

            // Object subscriptions don't typically have initial values
            callback.wantsInitialValue = false;

            return callback;
        }

        async function initialize() {
            // Check if we're already subscribed and connection is ready
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected && status.ready) {
                node.log("Already subscribed and connected, skipping initialization");
                return;
            }

            try {
                setStatus("yellow", "ring", "Connecting...");

                // Handle config changes using helper
                await NodeHelpers.handleConfigChange(node, config, RED, settings);

                const callback = createCallback();

                // Use the new subscribeObjects method
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

                node.log(`Successfully subscribed to ${patternInfo} via WebSocket`);

                setStatus("green", "dot", isWildcardPattern ? `Pattern: ${objectPattern}` : "Ready");
                node.isInitialized = true;

            } catch (error) {
                const errorMsg = error.message || 'Unknown error';

                // The centralized manager handles retry logic, so we just log the error
                node.log(`Connection attempt failed: ${errorMsg} - Manager will handle recovery`);

                // Set appropriate status based on error type
                if (errorMsg.includes('auth_failed') || errorMsg.includes('Authentication failed')) {
                    // Permanent authentication failure
                    setStatus("red", "ring", "Auth failed");
                } else if (errorMsg.includes('not possible in state')) {
                    // Connection is in a state where retry isn't possible 
                    setStatus("red", "ring", "Connection failed");
                } else {
                    // Other errors - manager will handle recovery
                    setStatus("yellow", "ring", "Retrying...");
                }

                node.isSubscribed = false;
            }
        }

        node.on("close", async function (removed, done) {
            node.log("Object subscription node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;

            try {
                await connectionManager.unsubscribeObjects(
                    settings.nodeId,
                    settings.serverId,
                    objectPattern
                );

                node.status({});

                const patternInfo = isWildcardPattern
                    ? `wildcard pattern ${objectPattern}`
                    : `single object ${objectPattern}`;

                node.log(`Successfully unsubscribed from ${patternInfo}`);

            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));

        // Initialize the node
        initialize();
    }

    RED.nodes.registerType("iobinobject", iobinobject);
};