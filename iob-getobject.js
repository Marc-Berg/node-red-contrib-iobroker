const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobgetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get server configuration
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        // Configuration with defaults
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport };
        node.currentStatus = { fill: "", shape: "", text: "" };
        node.isInitialized = false;

        // Helper functions
        function setError(message, statusText) {
            node.error(message);
            setStatus("red", "ring", statusText);
        }

        function setStatus(fill, shape, text) {
            try {
                const statusObj = { fill, shape, text };
                node.status(statusObj);
                node.currentStatus = statusObj;
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        }

        // Create callback for event notifications
        function createEventCallback() {
            const callback = function() {};

            callback.updateStatus = function(status) {
                // Use Node-RED compatible timestamp format
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [debug] [Node ${settings.nodeId}] Status update received: ${status}`);
                switch (status) {
                    case 'connected':
                        if (!node.isInitialized) {
                            setStatus("green", "dot", "Connected");
                            node.isInitialized = true;
                        } else {
                            // Update status even for already initialized nodes
                            setStatus("green", "dot", "Connected");
                        }
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false; // Reset on disconnection
                        break;
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
                        break;
                }
            };

            callback.onReconnect = function() {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [debug] [Node ${settings.nodeId}] Reconnection event received`);
                node.log("Reconnection detected by get object node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by get object node");
                setStatus("red", "ring", "Disconnected");
            };

            return callback;
        }

        // Check if configuration has changed
        function hasConfigChanged() {
            const currentGlobalConfig = RED.nodes.getNode(config.server);
            if (!currentGlobalConfig) return false;
            
            return (
                node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
                node.currentConfig.iobport !== currentGlobalConfig.iobport
            );
        }

        // Initialize connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport
                    };
                    settings.serverId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    
                    await connectionManager.resetConnection(settings.serverId, newGlobalConfig);
                    node.log(`Configuration changed, connection reset for ${settings.serverId}`);
                }

                // Register for events only
                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );
                
                setStatus("green", "dot", "Connected");
                node.isInitialized = true;
                node.log(`Connection established for get object node`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`Connection failed: ${errorMsg}`);
                
                if (errorMsg.includes('timeout') || errorMsg.includes('refused')) {
                    setTimeout(() => {
                        if (node.context) {
                            node.log("Retrying connection...");
                            initializeConnection();
                        }
                    }, 5000);
                }
            }
        }

        // Input handler
        node.on('input', async function(msg, send, done) {
            try {
                if (msg.topic === "status") {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    const statusMsg = {
                        payload: status,
                        topic: "status",
                        timestamp: Date.now()
                    };
                    send(statusMsg);
                    done && done();
                    return;
                }

                const configObjectId = config.objectId?.trim();
                const objectId = configObjectId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!objectId) {
                    setStatus("red", "ring", "Object ID missing");
                    const error = new Error("Object ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                setStatus("blue", "dot", `Reading object ${objectId}...`);

                const objectData = await connectionManager.getObject(settings.serverId, objectId);
                
                if (!objectData) {
                    setStatus("yellow", "ring", "Object not found");
                    node.warn(`Object not found: ${objectId}`);
                    
                    // Send message with null payload but include object ID for reference
                    msg[settings.outputProperty] = null;
                    msg.object = null;
                    msg.objectId = objectId;
                    msg.timestamp = Date.now();
                    msg.error = "Object not found";
                    
                    send(msg);
                    done && done();
                    return;
                }
                
                // Prepare output message
                msg[settings.outputProperty] = objectData;
                msg.object = objectData;
                msg.objectId = objectId;
                msg.timestamp = Date.now();
                
                // Add some useful metadata
                if (objectData.common) {
                    msg.objectType = objectData.type || 'unknown';
                    msg.objectName = objectData.common.name || objectId;
                    msg.objectRole = objectData.common.role || 'unknown';
                }
                
                setStatus("green", "dot", "OK");
                send(msg);
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                
                // Send error message with details
                msg.error = error.message;
                msg[settings.outputProperty] = null;
                msg.object = null;
                msg.timestamp = Date.now();
                
                send(msg);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            node.log("Get object node closing...");
            
            // Unregister from events
            connectionManager.unregisterFromEvents(settings.nodeId);

            try {
                node.status({});
                node.currentStatus = { fill: "", shape: "", text: "" };
            } catch (statusError) {
                // Ignore status errors during cleanup
            }

            done();
        });

        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initialize the node
        initializeConnection();
    }

    RED.nodes.registerType("iobgetobject", iobgetobject);
};