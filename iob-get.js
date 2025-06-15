const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobget(config) {
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
                // This is a dummy callback since iobget doesn't subscribe to states
            };

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

            callback.onReconnect = function() {
                node.log("Reconnection detected by get node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by get node");
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

        // Initialize WebSocket connection
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
                node.log(`Shared WebSocket connection established for get node`);
                
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

        // Get state value via shared WebSocket connection
        async function getState(stateId) {
            return new Promise((resolve, reject) => {
                if (!connectionClient || !connectionClient.connected) {
                    reject(new Error('WebSocket not connected'));
                    return;
                }

                const timeoutId = setTimeout(() => {
                    reject(new Error(`Get state timeout for ${stateId}`));
                }, 10000);

                connectionClient.emit('getState', stateId, (error, state) => {
                    clearTimeout(timeoutId);
                    
                    if (error) {
                        reject(new Error(`Failed to get state ${stateId}: ${error}`));
                    } else {
                        resolve(state);
                    }
                });
            });
        }

        // Input handler
        node.on('input', async function(msg, send, done) {
            try {
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
                }
                
                if (msg.topic === "reconnect") {
                    node.log("Manual reconnection requested");
                    try {
                        connectionClient = null;
                        node.isInitialized = false;
                        await initializeConnection();
                        setStatus("green", "dot", "Reconnected");
                    } catch (error) {
                        setError(`Reconnection failed: ${error.message}`, "Reconnect failed");
                    }
                    done && done();
                    return;
                }
                
                const configState = config.state?.trim();
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    const error = new Error("State ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                if (!connectionClient || !connectionClient.connected) {
                    setStatus("yellow", "ring", "Reconnecting...");
                    await initializeConnection();
                    
                    if (!connectionClient || !connectionClient.connected) {
                        throw new Error('Failed to establish WebSocket connection');
                    }
                }

                setStatus("blue", "dot", `Reading ${stateId}...`);

                const state = await getState(stateId);
                
                msg[settings.outputProperty] = state?.val !== undefined ? state.val : state;
                msg.state = state;
                msg.timestamp = Date.now();
                
                setStatus("green", "dot", "OK");
                send(msg);
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
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
            }, 15000);

            node.statusInterval = statusInterval;
        }

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            node.log("Get node closing...");
            
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

    RED.nodes.registerType("iobget", iobget);
};