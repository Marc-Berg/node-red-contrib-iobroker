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
        node.isNodeRedReady = false;
        
        // Ultra-simple deploy detection - much less code!
        node.isNodeRedReady = true; // Default to ready
        
        // If deploy is active, wait for it to complete
        if (connectionManager.isDeployActive) {
            node.isNodeRedReady = false;
            node.log("[DEBUG] Deploy active - waiting 2 seconds for completion");
            
            setTimeout(() => {
                node.isNodeRedReady = true;
                node.log("[DEBUG] Deploy wait completed - Node-RED ready");
                
                // Trigger initial values if pending
                if (settings.sendInitialValue && !actualWildcardMode && !node.initialValueSent && node.isInitialized) {
                    node.log("[DEBUG] Triggering initial value after deploy wait");
                    setImmediate(() => sendInitialValueNow());
                }
            }, 2000);
        } else {
            node.log("[DEBUG] No active deploy - Node-RED ready immediately");
        }
        
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
        
        // Simplified initial value function - much cleaner!
        async function sendInitialValueNow() {
            node.log(`[DEBUG] sendInitialValueNow called - sendInitial: ${settings.sendInitialValue}, wildcard: ${actualWildcardMode}, sent: ${node.initialValueSent}`);
            
            if (!settings.sendInitialValue || actualWildcardMode || node.initialValueSent) {
                node.log("[DEBUG] sendInitialValueNow: Early return due to conditions");
                return;
            }
            
            // Wait for Node-RED to be ready
            if (!node.isNodeRedReady) {
                node.log("[DEBUG] Node-RED not ready yet, setting up wait loop");
                const waitForReady = () => {
                    if (node.isNodeRedReady) {
                        node.log("[DEBUG] Node-RED became ready, retrying sendInitialValueNow");
                        setImmediate(() => sendInitialValueNow());
                    } else {
                        node.log("[DEBUG] Still waiting for Node-RED to be ready");
                        setTimeout(waitForReady, 100);
                    }
                };
                waitForReady();
                return;
            }
            
            node.log("[DEBUG] Starting initial value retrieval");
            
            // Simple retry loop for connection race conditions
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (attempt > 0) {
                        node.log(`[DEBUG] Attempt ${attempt + 1} - waiting ${200 * attempt}ms`);
                        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
                    }
                    
                    node.log(`[DEBUG] Getting initial value for: ${statePattern}`);
                    
                    const currentState = await connectionManager.getState(settings.serverId, statePattern);
                    
                    if (currentState && currentState.val !== undefined) {
                        if (shouldSendMessage(currentState.ack, settings.ackFilter)) {
                            const message = createMessage(statePattern, currentState, true);
                            node.send(message);
                            node.log(`[DEBUG] Initial value sent: ${currentState.val}`);
                            setStatus("green", "dot", `Initial: ${currentState.val}`);
                        } else {
                            node.log(`[DEBUG] Initial value filtered by ack filter`);
                        }
                    } else {
                        node.log(`[DEBUG] No initial value available`);
                    }
                    
                    node.initialValueSent = true;
                    node.log("[DEBUG] Initial value process completed");
                    return;
                    
                } catch (error) {
                    node.log(`[DEBUG] Attempt ${attempt + 1} failed: ${error.message}`);
                    if (attempt === 2) {
                        node.warn(`Initial value failed after ${attempt + 1} attempts: ${error.message}`);
                    } else if (error.message.includes('No active connection')) {
                        continue; // Retry
                    } else {
                        node.warn(`Initial value failed: ${error.message}`);
                        return;
                    }
                }
            }
        }
        
        // Enhanced callback with immediate initial value triggering
        function createCallback() {
            const callback = onStateChange;
            
            callback.updateStatus = function(status) {
                node.log(`[DEBUG] updateStatus called with: ${status}`);
                
                switch (status) {
                    case 'connected':
                        const statusText = actualWildcardMode
                            ? `Pattern connected: ${node.statePattern}`
                            : "Connected";
                        setStatus("green", "dot", statusText);
                        node.isInitialized = true;
                        
                        // Send initial value immediately
                        if (settings.sendInitialValue && !actualWildcardMode) {
                            node.log("[DEBUG] Connected - triggering initial value");
                            setImmediate(() => sendInitialValueNow());
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
                    
                node.log(`Successfully subscribed to ${patternInfo} via WebSocket${settings.sendInitialValue && !actualWildcardMode ? ' (with initial value)' : ''}`);
                
                setStatus("green", "dot", actualWildcardMode ? `Pattern: ${statePattern}` : "Connected");
                node.isInitialized = true;
                
                // Check if connection is already ready and send initial value if needed
                const connectionStatus = connectionManager.getConnectionStatus(settings.serverId);
                node.log(`[DEBUG] Post-subscribe check - connection: ${connectionStatus.connected}`);
                
                if (connectionStatus.connected && settings.sendInitialValue && !actualWildcardMode && !node.initialValueSent) {
                    node.log("[DEBUG] Connection ready - triggering initial value");
                    setImmediate(() => sendInitialValueNow());
                }
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`WebSocket subscription failed: ${errorMsg}`);
                node.isSubscribed = false;
                node.initialValueSent = false;
                
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