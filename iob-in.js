const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobin(config) {
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

        // Validate state ID
        const stateId = config.state?.trim();
        if (!stateId) {
            return setError("State ID missing", "State ID missing");
        }

        // Configuration with defaults
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
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

        // Filter function for acknowledgment status
        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true; // "both"
            }
        }

        // Create message from state change
        function createMessage(stateId, state) {
            const message = {
                topic: stateId,
                state: state,
                timestamp: Date.now()
            };
            message[settings.outputProperty] = state.val;
            return message;
        }

        // State change callback
        function onStateChange(stateId, state) {
            try {
                // Validate state data
                if (!state || state.val === undefined) {
                    node.warn(`Invalid state data received for ${stateId}`);
                    return;
                }

                // Filter by acknowledgment status
                if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                    return;
                }

                // Create and send message
                const message = createMessage(stateId, state);
                node.send(message);
                
                // Update status to show last activity
                const timestamp = new Date().toLocaleTimeString();
                setStatus("green", "dot", `Last: ${timestamp}`);
                
            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
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

        // Initialize subscription
        async function initialize() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
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
                
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    stateId,
                    onStateChange,
                    globalConfig
                );
                
                setStatus("green", "dot", "Connected");
                node.log(`Successfully subscribed to ${stateId} via WebSocket`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket subscription failed: ${errorMsg}`);
                
                // Retry after delay for connection errors
                if (errorMsg.includes('timeout') || errorMsg.includes('refused')) {
                    setTimeout(() => {
                        node.log("Retrying WebSocket connection...");
                        initialize();
                    }, 5000);
                }
            }
        }

        // Cleanup function
        async function cleanup() {
            try {
                setStatus("yellow", "ring", "Disconnecting...");
                
                await connectionManager.unsubscribe(
                    settings.nodeId,
                    settings.serverId,
                    stateId
                );
                
                setStatus("", "", "");
                node.log(`Successfully unsubscribed from ${stateId}`);
                
            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            }
        }

        // Status monitoring
        function startStatusMonitoring() {
            const statusInterval = setInterval(() => {
                if (!node.context) return; // Node is being destroyed
                
                const status = connectionManager.getConnectionStatus(settings.serverId);
                
                if (!status.connected) {
                    setStatus("red", "ring", "Disconnected");
                } else {
                    // Keep current status if connected
                }
            }, 10000); // Check every 10 seconds

            // Store interval for cleanup
            node.statusInterval = statusInterval;
        }

        // Input handler (for manual triggers or commands)
        node.on("input", function(msg) {
            if (msg.topic === "status") {
                // Return connection status
                const status = connectionManager.getConnectionStatus(settings.serverId);
                const statusMsg = {
                    payload: status,
                    topic: "status",
                    timestamp: Date.now()
                };
                node.send(statusMsg);
            } else if (msg.topic === "reconnect") {
                // Force reconnection
                node.log("Manual reconnection requested");
                cleanup().then(() => initialize());
            } else if (msg.topic === "config-update") {
                // Handle configuration update
                node.log("Configuration update requested");
                initialize(); // This will detect config changes and reset connection
            }
        });

        // Listen for configuration changes from Node-RED
        node.on("config-update", function() {
            node.log("Node configuration updated");
            initialize();
        });

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            // Clear status monitoring
            if (node.statusInterval) {
                clearInterval(node.statusInterval);
                node.statusInterval = null;
            }

            // Cleanup subscription
            try {
                await Promise.race([
                    cleanup(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Cleanup timeout')), 3000)
                    )
                ]);
            } catch (error) {
                node.warn(`Cleanup timeout/error: ${error.message}`);
            } finally {
                done();
            }
        });

        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initialize the node
        initialize();
        startStatusMonitoring();
    }

    // Register the node type
    RED.nodes.registerType("iobin", iobin);

    // Add admin endpoint for WebSocket states
    RED.httpAdmin.get("/iobroker/ws/states/:serverId", async function(req, res) {
        try {
            const serverId = decodeURIComponent(req.params.serverId);
            console.log(`[Admin API] Getting states for server: ${serverId}`);
            
            // Parse serverId to get host and port
            const [iobhost, iobport] = serverId.split(':');
            if (!iobhost || !iobport) {
                return res.status(400).json({ error: 'Invalid server ID format' });
            }

            const serverConfig = { iobhost, iobport };
            
            // Get states via WebSocket connection manager
            const states = await connectionManager.getStates(serverId);
            
            if (!states || typeof states !== 'object') {
                return res.status(404).json({ error: 'No states found' });
            }

            console.log(`[Admin API] Returning ${Object.keys(states).length} states`);
            res.json(states);
            
        } catch (error) {
            console.error(`[Admin API] Error getting states: ${error.message}`);
            res.status(500).json({ 
                error: 'Failed to load states', 
                details: error.message 
            });
        }
    });

    // Add admin endpoint for connection status
    RED.httpAdmin.get("/iobroker/connection-status/:serverId", function(req, res) {
        const serverId = decodeURIComponent(req.params.serverId);
        const status = connectionManager.getConnectionStatus(serverId);
        res.json(status);
    });

    // Add admin endpoint for connection list
    RED.httpAdmin.get("/iobroker/connections", function(req, res) {
        const connections = Array.from(connectionManager.connections.keys()).map(serverId => ({
            serverId,
            status: connectionManager.getConnectionStatus(serverId)
        }));
        res.json(connections);
    });

    // Add admin endpoint to reset connection
    RED.httpAdmin.post("/iobroker/reset-connection/:serverId", async function(req, res) {
        try {
            const serverId = decodeURIComponent(req.params.serverId);
            const [iobhost, iobport] = serverId.split(':');
            
            if (!iobhost || !iobport) {
                return res.status(400).json({ error: 'Invalid server ID format' });
            }

            const serverConfig = { iobhost, iobport };
            await connectionManager.resetConnection(serverId, serverConfig);
            
            res.json({ success: true, message: 'Connection reset successfully' });
        } catch (error) {
            console.error(`[Admin API] Error resetting connection: ${error.message}`);
            res.status(500).json({ 
                error: 'Failed to reset connection', 
                details: error.message 
            });
        }
    });
};