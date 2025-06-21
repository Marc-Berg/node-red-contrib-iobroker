// Enhanced iob-in.js with proper reconnection handling
const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Helper functions
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
        
        const { iobhost, iobport, user, password } = globalConfig;
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
        
        node.currentConfig = { iobhost, iobport, user, password };
        node.isInitialized = false;
        node.isSubscribed = false; // Track subscription state
        
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
        
        // Enhanced callback with proper reconnection handling
        function createCallback() {
            const callback = onStateChange;
            
            callback.updateStatus = function(status) {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [debug] [Node ${settings.nodeId}] Status update received: ${status}`);
                
                switch (status) {
                    case 'connected':
                        setStatus("green", "dot", "Connected");
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
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
                        node.isSubscribed = false;
                        break;
                    default:
                        setStatus("grey", "ring", "Unknown");
                }
            };
            
            callback.onReconnect = function() {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [debug] [Node ${settings.nodeId}] Reconnection event received`);
                node.log("Reconnection detected - resubscribing");
                
                // Mark as not subscribed to trigger resubscription
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
                
                // Resubscribe after short delay
                setTimeout(() => {
                    if (node.context) {
                        initialize();
                    }
                }, 1000);
            };
            
            callback.onDisconnect = function() {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };
            
            return callback;
        }
        
        // Check if configuration has changed
        function hasConfigChanged() {
            const currentGlobalConfig = RED.nodes.getNode(config.server);
            if (!currentGlobalConfig) return false;
            
            const configChanged = (
                node.currentConfig.iobhost !== currentGlobalConfig.iobhost ||
                node.currentConfig.iobport !== currentGlobalConfig.iobport ||
                node.currentConfig.user !== currentGlobalConfig.user ||
                node.currentConfig.password !== currentGlobalConfig.password
            );
            
            if (configChanged) {
                node.log(`Configuration change detected: ${node.currentConfig.iobhost}:${node.currentConfig.iobport} -> ${currentGlobalConfig.iobhost}:${currentGlobalConfig.iobport}`);
                node.isSubscribed = false; // Force resubscription
            }
            
            return configChanged;
        }
        
        // Initialize subscription with enhanced error handling
        async function initialize() {
            // Skip if already subscribed and connected
            if (node.isSubscribed && connectionManager.getConnectionStatus(settings.serverId).connected) {
                node.log("Already subscribed and connected, skipping initialization");
                return;
            }
            
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                // Check for configuration changes
                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    const oldServerId = settings.serverId;
                    
                    // Update internal configuration
                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport,
                        user: newGlobalConfig.user,
                        password: newGlobalConfig.password
                    };
                    
                    const newServerId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    settings.serverId = newServerId;
                    
                    // Force connection reset for configuration changes
                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }
                
                const callback = createCallback();
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    stateId,
                    callback,
                    globalConfig
                );
                
                node.isSubscribed = true;
                setStatus("green", "dot", "Connected");
                node.log(`Successfully subscribed to ${stateId} via WebSocket`);
                node.isInitialized = true;
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket subscription failed: ${errorMsg}`);
                node.isSubscribed = false;
                
                // Retry after delay for connection errors
                if (errorMsg.includes('timeout') || errorMsg.includes('refused') || errorMsg.includes('authentication')) {
                    setTimeout(() => {
                        if (node.context && !node.isSubscribed) {
                            node.log("Retrying WebSocket connection...");
                            initialize();
                        }
                    }, 5000);
                }
            }
        }
        
        // Input handler (for status requests)
        node.on("input", function(msg) {
            if (msg.topic === "status") {
                const status = connectionManager.getConnectionStatus(settings.serverId);
                const statusMsg = {
                    payload: {
                        ...status,
                        nodeInitialized: node.isInitialized,
                        isSubscribed: node.isSubscribed,
                        stateId: stateId
                    },
                    topic: "status",
                    timestamp: Date.now()
                };
                node.send(statusMsg);
            } else if (msg.topic === "reconnect") {
                // Manual reconnect trigger
                node.log("Manual reconnect triggered");
                node.isSubscribed = false;
                initialize();
            }
        });
        
        // Cleanup on node close
        node.on("close", async function(removed, done) {
            node.log("Node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;
            
            try {
                await connectionManager.unsubscribe(
                    settings.nodeId,
                    settings.serverId,
                    stateId
                );
                node.status({});
                node.log(`Successfully unsubscribed from ${stateId}`);
            } catch (error) {
                node.warn(`Cleanup error: ${error.message}`);
            } finally {
                done();
            }
        });
        
        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
            node.isSubscribed = false;
        });
        
        // Initialize the node
        initialize();
    }
    
    // Register the node type
    RED.nodes.registerType("iobin", iobin);
    
    // Admin endpoints for the tree view (unchanged)
    RED.httpAdmin.get("/iobroker/ws/states/:serverId", async function(req, res) {
        try {
            const serverId = decodeURIComponent(req.params.serverId);
            const [iobhost, iobport] = serverId.split(':');
            
            if (!iobhost || !iobport) {
                return res.status(400).json({ error: 'Invalid server ID format' });
            }
            
            const states = await connectionManager.getStates(serverId);
            if (!states || typeof states !== 'object') {
                return res.status(404).json({ error: 'No states found' });
            }
            
            res.json(states);
        } catch (error) {
            res.status(500).json({
                error: 'Failed to load states',
                details: error.message
            });
        }
    });
    
    RED.httpAdmin.get("/iobroker/connection-status/:serverId", function(req, res) {
        const serverId = decodeURIComponent(req.params.serverId);
        const status = connectionManager.getConnectionStatus(serverId);
        res.json(status);
    });
};