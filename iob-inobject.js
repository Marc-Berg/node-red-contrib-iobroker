const connectionManager = require('./lib/manager/websocket-manager');

module.exports = function (RED) {
    function iobinobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        function setError(message, statusText) {
            node.error(message);
            setStatus("red", "ring", statusText);
        }

        function setStatus(fill, shape, text) {
            try {
                node.status({ fill, shape, text });
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        }

        // Get server configuration
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        const objectPattern = config.objectPattern?.trim();
        if (!objectPattern) {
            return setError("Object Pattern missing", "Pattern missing");
        }

        const isWildcardPattern = objectPattern.includes('*');

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id,
            useWildcard: isWildcardPattern
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
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

            // Object subscriptions don't typically have initial values
            callback.wantsInitialValue = false;

            // Status update callback - called by the centralized manager
            callback.updateStatus = function (status) {
                switch (status) {
                    case 'ready':
                        const statusText = isWildcardPattern
                            ? `Pattern ready: ${node.objectPattern}`
                            : "Ready";
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        node.isSubscribed = false;
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        node.isSubscribed = false;
                        break;
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };

            callback.onReconnect = function () {
                node.log("Reconnection detected - resubscribing to objects");
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
            };

            callback.onDisconnect = function () {
                node.log("Disconnection detected by object subscription node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };

            callback.onSubscribed = function () {
                node.log("Object subscription successful");
                node.isSubscribed = true;
            };

            return callback;
        }

        function hasConfigChanged() {
            const currentGlobalConfig = RED.nodes.getNode(config.server);
            if (!currentGlobalConfig) return false;

            const configChanged = (
                node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
                node.currentConfig.iobport !== currentGlobalConfig.iobport ||
                node.currentConfig.user !== currentGlobalConfig.user ||
                node.currentConfig.password !== currentGlobalConfig.password ||
                node.currentConfig.usessl !== currentGlobalConfig.usessl
            );

            if (configChanged) {
                node.log(`Configuration change detected`);
                node.isSubscribed = false;
            }

            return configChanged;
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

                // Handle configuration changes
                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    const oldServerId = settings.serverId;

                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport,
                        user: newGlobalConfig.user,
                        password: newGlobalConfig.password,
                        usessl: newGlobalConfig.usessl
                    };

                    const newServerId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    settings.serverId = newServerId;

                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }

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

        node.on("error", function (error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
            node.isSubscribed = false;
        });

        // Initialize the node
        initialize();
    }

    RED.nodes.registerType("iobinobject", iobinobject);
};