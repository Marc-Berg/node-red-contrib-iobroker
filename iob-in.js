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
        
        const { iobhost, iobport, user, password, usessl } = globalConfig;
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
        
        node.currentConfig = { iobhost, iobport, user, password, usessl };
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
                node.currentConfig.password !== currentGlobalConfig.password ||
                node.currentConfig.usessl !== currentGlobalConfig.usessl
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
                        password: newGlobalConfig.password,
                        usessl: newGlobalConfig.usessl
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
                    globalConfig  // Pass the full config object
                );
                
                node.isSubscribed = true;
                const patternInfo = actualWildcardMode 
                    ? `wildcard pattern: ${statePattern}`
                    : `single state: ${statePattern}`;
                    
                node.log(`Successfully subscribed to ${patternInfo} via WebSocket${settings.sendInitialValue && !actualWildcardMode ? ' (with initial value)' : ''}`);
                
                setStatus("green", "dot", actualWildcardMode ? `Pattern: ${statePattern}` : "Connected");
                node.isInitialized = true;
                
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
};