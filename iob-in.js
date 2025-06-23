const connectionManager = require('./lib/websocket-manager');

module.exports = function(RED) {
    function iobin(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
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
        
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }
        
        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }
        
        const statePattern = config.state?.trim();
        if (!statePattern) {
            return setError("State ID/Pattern missing", "State ID missing");
        }
        
        const isWildcardPattern = statePattern.includes('*');
        const useWildcardConfig = config.useWildcard || false;
        
        let actualWildcardMode = isWildcardPattern;
        if (useWildcardConfig && !isWildcardPattern) {
            actualWildcardMode = false;
            node.warn(`Wildcard mode was enabled but no * found in pattern '${statePattern}' - treating as single state`);
        }
        
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue || false,
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id,
            useWildcard: actualWildcardMode
        };
        
        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;
        node.isSubscribed = false;
        node.initialValueSent = false;
        node.statePattern = statePattern;
        
        // NEW: Track if this is a deploy connection (new node instance) vs reconnection
        node.isDeployConnection = true; // Set to true on node creation
        
        function shouldSendMessage(ack, filter) {
            switch (filter) {
                case "ack": return ack === true;
                case "noack": return ack === false;
                default: return true;
            }
        }
        
        function createMessage(stateId, state, isInitialValue = false) {
            const message = {
                topic: stateId,
                state: state,
                timestamp: Date.now()
            };
            
            if (actualWildcardMode) {
                message.pattern = node.statePattern;
            }
            
            if (isInitialValue) {
                message.initial = true;
            }
            
            message[settings.outputProperty] = state.val;
            return message;
        }
        
        function onStateChange(stateId, state) {
            try {
                if (!state || state.val === undefined) {
                    node.warn(`Invalid state data received for ${stateId}`);
                    return;
                }
                
                if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                    return;
                }
                
                const message = createMessage(stateId, state, false);
                node.send(message);
                
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
        
        // Enhanced callback with deploy vs reconnect distinction
        function createCallback() {
            const callback = onStateChange;
            
            // NEW: Mark callback with deploy connection status and whether it wants initial values
            callback.isDeployConnection = node.isDeployConnection;
            callback.wantsInitialValue = settings.sendInitialValue && !actualWildcardMode;
            
            callback.updateStatus = function(status) {
                switch (status) {
                    case 'connected':
                        const statusText = actualWildcardMode
                            ? `Pattern connected: ${node.statePattern}`
                            : "Connected";
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        
                        // NEW: Send initial value only for deploy connections, not reconnections
                        if (settings.sendInitialValue && !actualWildcardMode && node.isDeployConnection) {
                            node.log("Deploy connection - will send initial value");
                            sendInitialValue().catch(error => {
                                node.warn(`Failed to send initial value after deploy connection: ${error.message}`);
                            });
                            // Mark as no longer a deploy connection
                            node.isDeployConnection = false;
                            callback.isDeployConnection = false;
                        } else if (!node.isDeployConnection) {
                            node.log("Reconnection detected - skipping initial value");
                        }
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        node.isSubscribed = false;
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        node.isSubscribed = false;
                        // NOTE: Don't reset isDeployConnection here - it stays false for reconnections
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
                node.log("Reconnection detected - resubscribing (no initial value for reconnect)");
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
                
                if (node.context) {
                    initialize();
                }
            };
            
            callback.onDisconnect = function() {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };
            
            // NEW: Called when subscription is successful
            callback.onSubscribed = function() {
                node.log(`Successfully subscribed to ${statePattern} - ${node.isDeployConnection ? 'deploy' : 'reconnect'} connection`);
                
                // Send initial value immediately after subscription for deploy connections
                if (settings.sendInitialValue && !actualWildcardMode && node.isDeployConnection) {
                    sendInitialValue().catch(error => {
                        node.warn(`Failed to send initial value after subscription: ${error.message}`);
                    });
                }
            };
            
            return callback;
        }
        
        // Send initial value for single state subscriptions only (deploy connections)
        async function sendInitialValue() {
            // Skip initial values for wildcard patterns
            if (!settings.sendInitialValue || actualWildcardMode) {
                if (actualWildcardMode) {
                    node.log(`Skipping initial values for wildcard pattern: ${node.statePattern}`);
                }
                return;
            }
            
            // NEW: Only send if this is a deploy connection and not already sent
            if (node.initialValueSent || !node.isDeployConnection) {
                node.log(`Skipping initial value - ${node.initialValueSent ? 'already sent' : 'this is a reconnection'}`);
                return;
            }
            
            try {
                node.log(`Sending initial value for deploy connection to single state: ${statePattern}`);
                
                // Try to use the manager's method
                await connectionManager.sendInitialValueForNode(
                    settings.serverId, 
                    statePattern, 
                    settings.nodeId, 
                    node.isDeployConnection
                );
                
                node.initialValueSent = true;
                node.isDeployConnection = false; // Mark as no longer deploy connection
                
            } catch (error) {
                node.warn(`Failed to send initial value: ${error.message}`);
                
                // Fallback: try getting cached state value
                try {
                    const cachedState = connectionManager.getCachedStateValue(settings.serverId, statePattern);
                    
                    if (cachedState && cachedState.val !== undefined) {
                        if (shouldSendMessage(cachedState.ack, settings.ackFilter)) {
                            const message = createMessage(statePattern, cachedState, true);
                            node.send(message);
                            
                            node.log(`Initial value sent from cache for ${statePattern}: ${cachedState.val} (ack: ${cachedState.ack})`);
                            setStatus("green", "dot", `Initial: ${cachedState.val}`);
                        } else {
                            node.log(`Initial value filtered out by ack filter (ack: ${cachedState.ack})`);
                        }
                        
                        node.initialValueSent = true;
                        node.isDeployConnection = false;
                    }
                } catch (fallbackError) {
                    node.warn(`Fallback initial value failed: ${fallbackError.message}`);
                }
            }
        }
        
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
                node.log(`Configuration change detected`);
                node.isSubscribed = false;
                // NEW: Config change is like a redeploy - reset to deploy connection
                node.isDeployConnection = true;
                node.initialValueSent = false;
            }
            
            return configChanged;
        }
        
        async function initialize() {
            if (node.isSubscribed && connectionManager.getConnectionStatus(settings.serverId).connected) {
                node.log("Already subscribed and connected, skipping initialization");
                return;
            }
            
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                if (hasConfigChanged()) {
                    const newGlobalConfig = RED.nodes.getNode(config.server);
                    const oldServerId = settings.serverId;
                    
                    node.currentConfig = {
                        iobhost: newGlobalConfig.iobhost,
                        iobport: newGlobalConfig.iobport,
                        user: newGlobalConfig.user,
                        password: newGlobalConfig.password,
                        usessl: newGlobalConfig.usessl
                    };
                    
                    const newServerId = `${newGlobalConfig.iobhost}:${newGlobalConfig.iobport}`;
                    settings.serverId = newServerId;
                    
                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }
                
                const callback = createCallback();
                
                await connectionManager.subscribe(
                    settings.nodeId,
                    settings.serverId,
                    statePattern,
                    callback,
                    globalConfig
                );
                
                node.isSubscribed = true;
                const patternInfo = actualWildcardMode 
                    ? `wildcard pattern: ${statePattern}`
                    : `single state: ${statePattern}`;
                    
                const connectionType = node.isDeployConnection ? 'deploy' : 'reconnect';
                const initialValueInfo = settings.sendInitialValue && !actualWildcardMode && node.isDeployConnection 
                    ? ' (with initial value on deploy)' 
                    : '';
                    
                node.log(`Successfully subscribed to ${patternInfo} via WebSocket (${connectionType} connection)${initialValueInfo}`);
                
                setStatus("green", "dot", actualWildcardMode ? `Pattern: ${statePattern}` : "Connected");
                node.isInitialized = true;
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket subscription failed: ${errorMsg}`);
                node.isSubscribed = false;
                
                // The new SocketClient will handle retries automatically
                // No need for manual retry logic here
            }
        }
        
        node.on("close", async function(removed, done) {
            node.log("Node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;
            node.initialValueSent = false;
            node.isDeployConnection = true; // Reset for next deploy
            
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
        
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
            node.isSubscribed = false;
            node.initialValueSent = false;
        });
        
        initialize();
    }
    
    RED.nodes.registerType("iobin", iobin);
};