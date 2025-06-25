const connectionManager = require('./lib/manager/websocket-manager');

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
        
        // Get server configuration
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
        
        // Simplified wildcard detection
        const isWildcardPattern = statePattern.includes('*');
        
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            ackFilter: config.ackFilter || "both",
            sendInitialValue: config.sendInitialValue && !isWildcardPattern, // Disable for wildcards
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id,
            useWildcard: isWildcardPattern
        };
        
        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;
        node.isSubscribed = false;
        node.statePattern = statePattern;
        
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
            
            if (isWildcardPattern) {
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
                
                const timestamp = new Date().toLocaleTimeString(undefined, { hour12: false })
                const statusText = isWildcardPattern 
                    ? `Pattern active - Last: ${timestamp}`
                    : `Last: ${timestamp}`;
                setStatus("green", "dot", statusText);
                
            } catch (error) {
                node.error(`State change processing error: ${error.message}`);
                setError(`Processing error: ${error.message}`, "Process error");
            }
        }
        
        function createCallback() {
            const callback = onStateChange;
            
            // Simple flag to indicate if this node wants initial values
            callback.wantsInitialValue = settings.sendInitialValue;
            
            // Handle initial value separately (called by the simplified system)
            callback.onInitialValue = function(stateId, state) {
                try {
                    if (!shouldSendMessage(state.ack, settings.ackFilter)) {
                        return;
                    }
                    
                    const message = createMessage(stateId, state, true);
                    node.send(message);
                    
                    node.log(`Initial value sent for ${stateId}: ${state.val}`);
                    
                } catch (error) {
                    node.error(`Initial value processing error: ${error.message}`);
                }
            };
            
            callback.updateStatus = function(status) {
                switch (status) {
                    case 'ready':
                        const statusText = isWildcardPattern
                            ? `Pattern ready: ${node.statePattern}`
                            : "Ready";
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        break;
                    case 'connected':
                        const connectedText = isWildcardPattern
                            ? `Pattern connected: ${node.statePattern}`
                            : "Connected";
                        setStatus("green", "ring", connectedText);
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
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'retrying_production':
                        setStatus("yellow", "ring", "Retrying (prod)...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };
            
            callback.onReconnect = function() {
                node.log("Reconnection detected - resubscribing");
                node.isSubscribed = false;
                setStatus("yellow", "ring", "Resubscribing...");
            };
            
            callback.onDisconnect = function() {
                node.log("Disconnection detected by node");
                setStatus("red", "ring", "Disconnected");
                node.isSubscribed = false;
            };
            
            callback.onSubscribed = function() {
                node.log("Subscription successful");
                node.isSubscribed = true;
            };
            
            return callback;
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
            }
            
            return configChanged;
        }
        
        async function initialize() {
            const status = connectionManager.getConnectionStatus(settings.serverId);
            if (node.isSubscribed && status.connected) {
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
                
                const patternInfo = isWildcardPattern 
                    ? `wildcard pattern: ${statePattern}`
                    : `single state: ${statePattern}`;
                    
                node.log(`Successfully subscribed to ${patternInfo} via WebSocket${settings.sendInitialValue ? ' (with initial value)' : ''}`);
                
                setStatus("green", "dot", isWildcardPattern ? `Pattern: ${statePattern}` : "Ready");
                node.isInitialized = true;
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                
                if (errorMsg.includes('timeout') || errorMsg.includes('refused') || 
                    errorMsg.includes('ECONNRESET') || errorMsg.includes('ENOTFOUND') ||
                    errorMsg.includes('EHOSTUNREACH') || errorMsg.includes('socket hang up')) {
                    
                    setStatus("yellow", "ring", "Waiting for server...");
                    node.log(`Initial connection failed, connection recovery enabled: ${errorMsg}`);
                    
                } else if (errorMsg.includes('authentication') || errorMsg.includes('Authentication failed')) {
                    
                    setError(`Authentication failed: ${errorMsg}`, "Auth failed");
                    
                } else {
                    
                    setStatus("yellow", "ring", "Connection recovery active");
                    node.log(`Connection failed, recovery enabled: ${errorMsg}`);
                }
                
                node.isSubscribed = false;
            }
        }
        
        node.on("close", async function(removed, done) {
            node.log("Node closing...");
            node.isInitialized = false;
            node.isSubscribed = false;
            
            try {
                await connectionManager.unsubscribe(
                    settings.nodeId,
                    settings.serverId,
                    statePattern
                );
                
                node.status({});
                
                const patternInfo = isWildcardPattern 
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
        });
        
        initialize();
    }
    
    RED.nodes.registerType("iobin", iobin);
};