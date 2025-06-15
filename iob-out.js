const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobout(config) {
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
            inputProperty: config.inputProperty?.trim() || "payload",
            setMode: config.setMode || "value",
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id
        };

        const configState = config.state?.trim();
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
                            // Auch bei bereits initialisierten Nodes den Status aktualisieren
                            setStatus("green", "dot", "Connected");
                        }
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false; // Reset bei Disconnection
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
                node.log("Reconnection detected by output node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by output node");
                setStatus("red", "ring", "Disconnected");
            };

            return callback;
        }

        // Initialize connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
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
                node.log(`Connection established for output node`);
                
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

        // Input message handler
        this.on('input', async function(msg, send, done) {
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
                } else if (msg.topic === "reconnect") {
                    node.log("Manual reconnection requested");
                    node.isInitialized = false;
                    await connectionManager.resetConnection(settings.serverId, globalConfig);
                    done && done();
                    return;
                }

                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    done && done("State ID missing (neither configured nor in msg.topic)");
                    return;
                }

                const value = msg[settings.inputProperty];
                if (value === undefined) {
                    node.error(`Input property "${settings.inputProperty}" not found in message`);
                    setStatus("red", "ring", "Input missing");
                    done && done();
                    return;
                }

                const ack = settings.setMode === "value";
                setStatus("blue", "dot", "Setting...");
                
                await connectionManager.setState(settings.serverId, stateId, value, ack);
                
                setStatus("green", "dot", "OK");
                node.log(`Successfully set ${stateId} = ${value} (mode: ${settings.setMode})`);
                
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Failed to set value: ${error.message}`);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function(done) {
            node.log("Output node closing...");
            
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

    RED.nodes.registerType("iobout", iobout);
};