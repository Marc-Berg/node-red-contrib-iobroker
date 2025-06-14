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

        // Store current config for change detection
        node.currentConfig = { iobhost, iobport };

        // Helper function for error handling
        function setError(message, statusText) {
            node.error(message);
            node.status({ fill: "red", shape: "ring", text: statusText });
        }

        // Helper function for status updates
        function setStatus(fill, shape, text) {
            node.status({ fill, shape, text });
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

        // Get state value via WebSocket (passive query only)
        async function getState(stateId) {
            try {
                setStatus("blue", "dot", `Reading ${stateId}...`);

                // Check if config has changed
                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport
                    };
                    settings.serverId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    
                    // Reset connection with new config
                    await connectionManager.resetConnection(settings.serverId, newGlobalConfig);
                    node.log(`Configuration changed, connection reset for ${settings.serverId}`);
                }

                // Get WebSocket connection (without subscription setup)
                const client = await connectionManager.getConnection(
                    settings.serverId,
                    globalConfig
                );

                // Direct state query via WebSocket
                return new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(() => {
                        reject(new Error(`Get state timeout for ${stateId}`));
                    }, 10000);

                    client.emit('getState', stateId, (error, state) => {
                        clearTimeout(timeoutId);
                        
                        if (error) {
                            reject(new Error(`Failed to get state ${stateId}: ${error}`));
                        } else {
                            resolve(state);
                        }
                    });
                });

            } catch (error) {
                throw new Error(`WebSocket get state failed: ${error.message}`);
            }
        }

        //Input-Handler
        node.on('input', async function(msg, send, done) {
            try {
                // Handle special command messages first
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
                
                if (msg.topic === "reconnect") {
                    node.log("Manual reconnection requested");
                    try {
                        await connectionManager.resetConnection(settings.serverId, globalConfig);
                        setStatus("green", "dot", "Reconnected");
                    } catch (error) {
                        setError(`Reconnection failed: ${error.message}`, "Reconnect failed");
                    }
                    done && done();
                    return;
                }
                
                // Normal state reading operation
                const configState = config.state?.trim();
                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    const error = new Error("State ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                // Perform passive state query
                const state = await getState(stateId);
                
                // Prepare response message
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

        // Status monitoring (lightweight)
        function startStatusMonitoring() {
            const statusInterval = setInterval(() => {
                if (!node.context) return; // Node is being destroyed
                
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (!status.connected) {
                    setStatus("red", "ring", "Disconnected");
                }
                
            }, 30000); // Check every 30 seconds (less frequent than iobin)

            node.statusInterval = statusInterval;
        }

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            if (node.statusInterval) {
                clearInterval(node.statusInterval);
                node.statusInterval = null;
            }
            done();
        });

        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initial status setup (no active initialization needed)
        setStatus("green", "dot", "Ready");
        startStatusMonitoring();
    }

    // Register the node type
    RED.nodes.registerType("iobget", iobget);
};
