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
        
        // Validate state ID or pattern
        const statePattern = config.state?.trim();
        if (!statePattern) {
            return setError("State ID/Pattern missing", "State ID missing");
        }
        
        // Determine if this is a wildcard pattern and validate consistency
        const isWildcardPattern = statePattern.includes('*');
        const useWildcardConfig = config.useWildcard || false;
        
        // Auto-correct inconsistent wildcard configuration
        let actualWildcardMode = isWildcardPattern;
        if (useWildcardConfig && !isWildcardPattern) {
            // User enabled wildcard but no * in pattern - treat as single state
            actualWildcardMode = false;
            node.warn(`Wildcard mode was enabled but no * found in pattern '${statePattern}' - treating as single state`);
        }
        
        // Configuration with defaults
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue || false,
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id,
            useWildcard: actualWildcardMode // Use corrected wildcard mode
        };
        
        node.currentConfig = { iobhost, iobport, user, password };
        node.isInitialized = false;
        node.isSubscribed = false;
        node.initialValueSent = false;
        node.statePattern = statePattern;
        
        // Filter function for acknowledgment status
        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true; // "both"
            }
        }
        
        // Create message from state change
        function createMessage(stateId, state, isInitialValue = false) {
            const message = {
                topic: stateId,
                state: state,
                timestamp: Date.now()
            };
            
            // Add wildcard context if using patterns
            if (actualWildcardMode) {
                message.pattern = node.statePattern;
            }
            
            // Add initial value indicator if this is the initial value
            if (isInitialValue) {
                message.initial = true;
            }
            
            message[settings.outputProperty] = state.val;
            return message;
        }
        
        // State change callback - works for both single states and wildcards
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
                const message = createMessage(stateId, state, false);
                node.send(message);
                
                // Update status to show last activity
                const timestamp = new Date().toLocaleTimeString();
                const statusText = actualWildcardMode 
                    ? `Pattern active - Last: ${timestamp}`
                    : `Last: ${timestamp}`;
                setStatus("green", "dot", statusText);
                
            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }
        
        // Send initial value for single state subscriptions only
        async function sendInitialValue() {
            // Skip initial values for actual wildcard patterns (not for checkbox-only wildcards)
            if (!settings.sendInitialValue || actualWildcardMode) {
                if (actualWildcardMode) {
                    node.log(`Skipping initial values for wildcard pattern: ${node.statePattern}`);
                }
                return;
            }
            
            if (node.initialValueSent) {
                return;
            }
            
            try {
                node.log(`Checking initial value for single state: ${statePattern}`);
                
                // Try cached value first
                const cachedState = connectionManager.getCachedStateValue(settings.serverId, statePattern);
                
                if (cachedState && cachedState.val !== undefined) {
                    if (shouldSendMessage(cachedState.ack, settings.ackFilter)) {
                        const message = createMessage(statePattern, cachedState, true);
                        node.send(message);
                        
                        node.log(`Initial value sent for ${statePattern}: ${cachedState.val} (ack: ${cachedState.ack})`);
                        setStatus("green", "dot", `Initial: ${cachedState.val}`);
                    } else {
                        node.log(`Initial value filtered out by ack filter (ack: ${cachedState.ack})`);
                    }
                    
                    node.initialValueSent = true;
                } else {
                    // Fallback to live query
                    const currentState = await connectionManager.getState(settings.serverId, statePattern);
                    
                    if (currentState && currentState.val !== undefined) {
                        if (shouldSendMessage(currentState.ack, settings.ackFilter)) {
                            const message = createMessage(statePattern, currentState, true);
                            node.send(message);
                            
                            node.log(`Initial value sent from live query: ${currentState.val} (ack: ${currentState.ack})`);
                            setStatus("green", "dot", `Initial: ${currentState.val}`);
                        } else {
                            node.log(`Initial value filtered out by ack filter (ack: ${currentState.ack})`);
                        }
                        
                        node.initialValueSent = true;
                    } else {
                        node.warn(`No initial value available for ${statePattern}`);
                        node.initialValueSent = true;
                    }
                }
                
            } catch (error) {
                node.warn(`Failed to send initial value: ${error.message}`);
            }
        }
        
        // Enhanced callback with wildcard support
        function createCallback() {
            const callback = onStateChange;
            
            callback.updateStatus = function(status) {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [debug] [Node ${settings.nodeId}] Status update: ${status}`);
                
                switch (status) {
                    case 'connected':
                        const statusText = actualWildcardMode
                            ? `Pattern connected: ${node.statePattern}`
                            : "Connected";
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        
                        // Send initial value after successful connection (single states only)
                        if (settings.sendInitialValue && !actualWildcardMode) {
                            sendInitialValue().catch(error => {
                                node.warn(`Failed to send initial value after connection: ${error.message}`);
                            });
                        }
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        node.isSubscribed = false;
                        node.initialValueSent = false;
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        node.isSubscribed = false;
                        node.initialValueSent = false;
                        break;
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
                        node.isSubscribed = false;
                        node.initialValueSent = false;
                        break;
                    default:
                        setStatus("grey", "ring", "Unknown");
                }
            };
            
            callback.onReconnect = function() {
                node.log("Reconnection detected - resubscribing");
                node.isSubscribed = false;
                node.initialValueSent = false;
                setStatus("yellow", "ring", "Resubscribing...");
                
                if (node.context) {
                    initialize();
                }
            };
            
            callback.onDisconnect = function() {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
                node.initialValueSent = false;
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
                node.isSubscribed = false;
                node.initialValueSent = false;
            }
            
            return configChanged;
        }
        
        // Initialize subscription - simplified for native wildcard support
        async function initialize() {
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
                
                // Simple subscription - ioBroker handles wildcards natively
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    statePattern, // Can be single state or wildcard pattern
                    callback,
                    globalConfig
                );
                
                node.isSubscribed = true;
                const patternInfo = actualWildcardMode 
                    ? `wildcard pattern: ${statePattern}`
                    : `single state: ${statePattern}`;
                    
                node.log(`Successfully subscribed to ${patternInfo} via WebSocket${settings.sendInitialValue && !actualWildcardMode ? ' (with initial value)' : ''}`);
                
                setStatus("green", "dot", actualWildcardMode ? `Pattern: ${statePattern}` : "Connected");
                node.isInitialized = true;
                
                // Send initial value after successful subscription (single states only)
                if (settings.sendInitialValue && !actualWildcardMode) {
                    await sendInitialValue();
                }
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket subscription failed: ${errorMsg}`);
                node.isSubscribed = false;
                node.initialValueSent = false;
                
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
        
        // Cleanup on node close
        node.on("close", async function(removed, done) {
            node.log("Node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;
            node.initialValueSent = false;
            
            try {
                await connectionManager.unsubscribe(
                    settings.nodeId,
                    settings.serverId,
                    statePattern
                );
                
                node.status({});
                
                const patternInfo = actualWildcardMode 
                    ? `wildcard pattern ${statePattern}`
                    : `single state ${statePattern}`;
                    
                node.log(`Successfully unsubscribed from ${patternInfo}`);
                
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
            node.initialValueSent = false;
        });
        
        // Initialize the node
        initialize();
    }
    
    // Register the node type
    RED.nodes.registerType("iobin", iobin);
    
    // Admin endpoints for the tree view
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