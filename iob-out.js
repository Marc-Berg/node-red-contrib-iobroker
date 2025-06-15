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
        let connectionClient = null;

        // Helper function for error handling
        function setError(message, statusText) {
            node.error(message);
            setStatus("red", "ring", statusText);
        }

        // Helper function for status updates
        function setStatus(fill, shape, text) {
            try {
                const statusObj = { fill, shape, text };
                node.status(statusObj);
                node.currentStatus = statusObj;
            } catch (error) {
                node.warn(`Status update error: ${error.message}`);
            }
        }

        // Create enhanced callback for reconnection notifications
        function createEnhancedCallback() {
            const callback = function() {
                // This is a dummy callback since iobout doesn't subscribe to states
                // But we need it for the reconnection events
            };

            // Add status update function to callback
            callback.updateStatus = function(status) {
                switch (status) {
                    case 'connected':
                        if (!node.isInitialized) {
                            setStatus("green", "dot", "Connected");
                            node.isInitialized = true;
                        }
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        break;
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
                        break;
                    default:
                        setStatus("grey", "ring", "Unknown");
                }
            };

            // Add reconnection handler
            callback.onReconnect = function() {
                node.log("Reconnection detected by output node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            // Add disconnection handler
            callback.onDisconnect = function() {
                node.log("Disconnection detected by output node");
                setStatus("red", "ring", "Disconnected");
            };

            return callback;
        }

        // Initialize WebSocket connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                connectionClient = await connectionManager.getConnection(
                    settings.serverId,
                    globalConfig
                );

                // Register dummy subscription to get reconnection events
                const enhancedCallback = createEnhancedCallback();
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    `_dummy_${settings.nodeId}`, // Dummy state ID
                    enhancedCallback,
                    globalConfig
                );
                
                setStatus("green", "dot", "Connected");
                node.isInitialized = true;
                node.log(`WebSocket connection established for output node`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket connection failed: ${errorMsg}`);
                
                if (errorMsg.includes('timeout') || errorMsg.includes('refused')) {
                    setTimeout(() => {
                        if (node.context) {
                            node.log("Retrying WebSocket connection...");
                            initializeConnection();
                        }
                    }, 5000);
                }
            }
        }

        // Set state value via WebSocket
        async function setState(stateId, value, ack) {
            return new Promise((resolve, reject) => {
                if (!connectionClient || !connectionClient.connected) {
                    reject(new Error('WebSocket not connected'));
                    return;
                }

                const timeoutId = setTimeout(() => {
                    reject(new Error(`Set state timeout for ${stateId}`));
                }, 8000);

                try {
                    const stateObject = {
                        val: value,
                        ack: ack,
                        from: 'system.adapter.node-red',
                        ts: Date.now()
                    };

                    connectionClient.emit('setState', stateId, stateObject, (error, result) => {
                        clearTimeout(timeoutId);
                        if (error) {
                            reject(new Error(`setState failed for ${stateId}: ${error}`));
                        } else {
                            resolve(result);
                        }
                    });

                } catch (emitError) {
                    clearTimeout(timeoutId);
                    reject(new Error(`Emit error for ${stateId}: ${emitError.message}`));
                }
            });
        }

        // Input message handler
        this.on('input', async function(msg, send, done) {
            try {
                // Handle command messages
                if (msg.topic === "status") {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    const statusMsg = {
                        payload: {
                            websocket: status,
                            nodeStatus: node.currentStatus,
                            connected: !!connectionClient && connectionClient.connected
                        },
                        topic: "status",
                        timestamp: Date.now()
                    };
                    send(statusMsg);
                    done && done();
                    return;
                } else if (msg.topic === "reconnect") {
                    node.log("Manual reconnection requested");
                    connectionClient = null;
                    node.isInitialized = false;
                    await initializeConnection();
                    done && done();
                    return;
                }

                // Normal operation
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

                if (!connectionClient || !connectionClient.connected) {
                    setStatus("yellow", "ring", "Reconnecting...");
                    await initializeConnection();
                    
                    if (!connectionClient || !connectionClient.connected) {
                        throw new Error('Failed to establish WebSocket connection');
                    }
                }

                const ack = settings.setMode === "value";
                setStatus("blue", "dot", "Setting...");
                
                await setState(stateId, value, ack);
                
                setStatus("green", "dot", "OK");
                node.log(`Successfully set ${stateId} = ${value} via WebSocket (mode: ${settings.setMode})`);
                
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Failed to set value: ${error.message}`);
                done && done(error);
            }
        });

        // Status monitoring
        function startStatusMonitoring() {
            const statusInterval = setInterval(() => {
                if (!node.context) return;
                
                try {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    
                    if (!status.connected) {
                        if (node.currentStatus.fill !== "red") {
                            setStatus("red", "ring", "Disconnected");
                        }
                        connectionClient = null;
                    } else if (status.connected && !connectionClient) {
                        connectionManager.getConnection(settings.serverId, globalConfig)
                            .then(client => {
                                connectionClient = client;
                                if (node.currentStatus.fill !== "green") {
                                    setStatus("green", "dot", "Connected");
                                }
                            })
                            .catch(error => {
                                node.warn(`Failed to reconnect: ${error.message}`);
                            });
                    }
                } catch (error) {
                    node.warn(`Status monitoring error: ${error.message}`);
                }
            }, 10000);

            node.statusInterval = statusInterval;
        }

        // Cleanup on node close
        node.on("close", async function(done) {
            node.log("Output node closing...");
            
            if (node.statusInterval) {
                clearInterval(node.statusInterval);
                node.statusInterval = null;
            }

            // Unsubscribe dummy subscription
            try {
                await connectionManager.unsubscribe(
                    settings.nodeId,
                    settings.serverId,
                    `_dummy_${settings.nodeId}`
                );
            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            }

            try {
                node.status({});
                node.currentStatus = { fill: "", shape: "", text: "" };
            } catch (statusError) {
                // Ignore status errors during cleanup
            }
            
            connectionClient = null;
            done();
        });

        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initialize the node
        initializeConnection();
        startStatusMonitoring();
    }

    RED.nodes.registerType("iobout", iobout);
};