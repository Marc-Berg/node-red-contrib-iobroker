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
            setMode: config.setMode || "value", // "value" (ack=true) or "command" (ack=false)
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id
        };

        const configState = config.state?.trim();
        node.currentStatus = { fill: "", shape: "", text: "" };
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

        // Initialize WebSocket connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                connectionClient = await connectionManager.getConnection(
                    settings.serverId,
                    globalConfig
                );
                
                setStatus("green", "dot", "Connected");
                node.log(`WebSocket connection established for output node`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket connection failed: ${errorMsg}`);
                
                // Retry after delay for connection errors
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

        // Set state value via WebSocket using the correct ioBroker API
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
                    // Use the correct ioBroker WebSocket setState API
                    // Based on ioBroker documentation: setState(id, state, callback)
                    const stateObject = {
                        val: value,
                        ack: ack,
                        from: 'system.adapter.node-red',
                        ts: Date.now()
                    };

                    console.log(`[iobout] Setting state ${stateId} =`, stateObject);

                    connectionClient.emit('setState', stateId, stateObject, (error, result) => {
                        clearTimeout(timeoutId);
                        if (error) {
                            console.error(`[iobout] setState failed for ${stateId}:`, error);
                            reject(new Error(`setState failed for ${stateId}: ${error}`));
                        } else {
                            console.log(`[iobout] setState success: ${stateId} = ${value} (ack: ${ack})`);
                            resolve(result);
                        }
                    });

                } catch (emitError) {
                    clearTimeout(timeoutId);
                    console.error(`[iobout] Error emitting setState for ${stateId}:`, emitError);
                    reject(new Error(`Emit error for ${stateId}: ${emitError.message}`));
                }
            });
        }

        // Input message handler
        this.on('input', async function(msg, send, done) {
            try {
                // Determine state ID from config or msg.topic
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    done && done("State ID missing (neither configured nor in msg.topic)");
                    return;
                }

                // Get value from message
                const value = msg[settings.inputProperty];
                if (value === undefined) {
                    node.error(`Input property "${settings.inputProperty}" not found in message`);
                    setStatus("red", "ring", "Input missing");
                    done && done();
                    return;
                }

                // Check WebSocket connection
                if (!connectionClient || !connectionClient.connected) {
                    setStatus("yellow", "ring", "Reconnecting...");
                    await initializeConnection();
                    
                    if (!connectionClient || !connectionClient.connected) {
                        throw new Error('Failed to establish WebSocket connection');
                    }
                }

                // Determine acknowledgment based on setMode
                const ack = settings.setMode === "value"; // true for "value", false for "command"
                
                setStatus("blue", "dot", "Setting...");
                
                // Set state via WebSocket
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

        // Status monitoring for connection health
        function startStatusMonitoring() {
            const statusInterval = setInterval(() => {
                if (!node.context) return; // Node is being destroyed
                
                try {
                    const status = connectionManager.getConnectionStatus(settings.serverId);
                    
                    if (!status.connected) {
                        if (node.currentStatus.fill !== "red") {
                            setStatus("red", "ring", "Disconnected");
                        }
                        connectionClient = null; // Clear invalid connection
                    } else if (status.connected && !connectionClient) {
                        // Try to get the connection again
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
            }, 10000); // Check every 10 seconds

            node.statusInterval = statusInterval;
        }

        // Input handler for commands
        node.on("input", function(msg) {
            if (msg.topic === "status") {
                // Return connection status
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
                node.send(statusMsg);
            } else if (msg.topic === "reconnect") {
                // Force reconnection
                node.log("Manual reconnection requested");
                connectionClient = null;
                initializeConnection();
            }
        });

        // Cleanup on node close
        node.on("close", function(done) {
            node.log("Output node closing...");
            
            // Clear status monitoring
            if (node.statusInterval) {
                clearInterval(node.statusInterval);
                node.statusInterval = null;
            }

            // Clear status
            try {
                node.status({});
                node.currentStatus = { fill: "", shape: "", text: "" };
            } catch (statusError) {
                // Ignore status errors during cleanup
            }
            
            // Note: We don't clean up the WebSocket connection here since
            // it might be shared with other nodes (iobin, iobget)
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