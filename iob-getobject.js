const connectionManager = require('./lib/manager/websocket-manager');

module.exports = function(RED) {
    function iobgetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get server configuration
        const globalConfig = RED.nodes.getNode(config.server);
        if (!globalConfig) {
            return setError("No server configuration selected", "No server config");
        }

        const { iobhost, iobport, user, password, usessl } = globalConfig;
        if (!iobhost || !iobport) {
            return setError("ioBroker host or port missing", "Host/port missing");
        }

        // Auto-detect wildcard mode from object ID
        const configObjectId = config.objectId?.trim() || "";
        const isWildcardPattern = configObjectId.includes('*');

        // Configuration with defaults
        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            outputMode: config.outputMode || (isWildcardPattern ? "array" : "single"),
            useWildcard: isWildcardPattern,
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

        // Log initial configuration
        if (isWildcardPattern) {
            node.log(`Wildcard pattern detected: ${configObjectId} (output mode: ${settings.outputMode})`);
        }

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

        function formatOutput(objects, objectIdOrPattern, outputMode) {
            if (!objects) {
                return null;
            }

            // Handle single object result
            if (!Array.isArray(objects) && typeof objects === 'object') {
                return {
                    [settings.outputProperty]: objects,
                    objects: objects,
                    objectId: objectIdOrPattern,
                    count: 1,
                    timestamp: Date.now()
                };
            }

            // Handle multiple objects (from wildcard pattern)
            const objectArray = Array.isArray(objects) ? objects : Object.values(objects);
            const objectMap = {};
            
            // Create object map
            objectArray.forEach(obj => {
                if (obj && obj._id) {
                    objectMap[obj._id] = obj;
                }
            });

            let outputData;
            switch (outputMode) {
                case 'array':
                    outputData = objectArray;
                    break;
                case 'object':
                    outputData = objectMap;
                    break;
                case 'single':
                    // For single mode with multiple results, take the first one
                    outputData = objectArray.length > 0 ? objectArray[0] : null;
                    break;
                default:
                    outputData = objectArray;
            }

            return {
                [settings.outputProperty]: outputData,
                objects: objectMap,
                objectId: objectIdOrPattern,
                pattern: isWildcardPattern ? objectIdOrPattern : undefined,
                count: objectArray.length,
                timestamp: Date.now()
            };
        }

        // Create callback for event notifications
        function createEventCallback() {
            const callback = function() {};

            callback.updateStatus = function(status) {
                switch (status) {
                    case 'ready':
                        const readyText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                        setStatus("green", "dot", readyText);
                        node.isInitialized = true;
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        break;
                    case 'retrying':
                        setStatus("yellow", "ring", "Retrying...");
                        break;
                    case 'failed_permanently':
                        setStatus("red", "ring", "Auth failed");
                        break;
                    default:
                        setStatus("grey", "ring", status);
                }
            };

            callback.onReconnect = function() {
                node.log("Reconnection detected by get object node");
                const reconnectedText = isWildcardPattern ? "Reconnected (Pattern)" : "Reconnected";
                setStatus("green", "dot", reconnectedText);
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by get object node");
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
                node.currentConfig.iobport !== currentGlobalConfig.iobport ||
                node.currentConfig.user !== currentGlobalConfig.user ||
                node.currentConfig.password !== currentGlobalConfig.password ||
                node.currentConfig.usessl !== currentGlobalConfig.usessl
            );
        }

        // Initialize connection
        async function initializeConnection() {
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
                    
                    // Force connection reset for configuration changes
                    if (oldServerId !== newServerId) {
                        node.log(`Server changed from ${oldServerId} to ${newServerId}, forcing connection reset`);
                        await connectionManager.forceServerSwitch(oldServerId, newServerId, newGlobalConfig);
                    }
                }

                // Register for events using centralized manager
                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );
                
                // Only set ready status if connection is actually ready
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (status.ready) {
                    const readyText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                    setStatus("green", "dot", readyText);
                    node.isInitialized = true;
                    node.log(`Connection established for get object node (wildcard: ${isWildcardPattern})`);
                } else {
                    // Node is registered, will get status updates when connection is ready
                    setStatus("yellow", "ring", "Waiting for connection...");
                    node.log(`Get object node registered - waiting for connection to be ready`);
                }
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setStatus("red", "ring", "Registration failed");
                node.error(`Node registration failed: ${errorMsg}`);
            }
        }

        // Input handler
        node.on('input', async function(msg, send, done) {
            try {
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

                const objectIdOrPattern = configObjectId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!objectIdOrPattern) {
                    setStatus("red", "ring", "Object ID missing");
                    const error = new Error("Object ID missing (neither configured nor in msg.topic)");
                    done && done(error);
                    return;
                }

                // Detect if this specific request is a wildcard pattern
                const isCurrentWildcard = objectIdOrPattern.includes('*');
                const currentOutputMode = msg.outputMode || settings.outputMode;

                if (isCurrentWildcard) {
                    setStatus("blue", "dot", `Reading objects ${objectIdOrPattern}...`);
                    
                    try {
                        // Use getObjects for wildcard patterns
                        const objects = await connectionManager.getObjects(settings.serverId, objectIdOrPattern);
                        
                        if (!objects || (Array.isArray(objects) && objects.length === 0) || 
                            (typeof objects === 'object' && Object.keys(objects).length === 0)) {
                            setStatus("yellow", "ring", "No objects found");
                            node.warn(`No objects found for pattern: ${objectIdOrPattern}`);
                            
                            // Send message with empty result
                            const result = formatOutput(currentOutputMode === 'array' ? [] : {}, objectIdOrPattern, currentOutputMode);
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Format output according to configured mode
                        const result = formatOutput(objects, objectIdOrPattern, currentOutputMode);
                        Object.assign(msg, result);
                        
                        setStatus("green", "dot", isWildcardPattern ? "Ready (Pattern)" : "Ready");
                        node.log(`Successfully retrieved ${result.count} objects for pattern: ${objectIdOrPattern} (mode: ${currentOutputMode})`);
                        
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Pattern error");
                        node.error(`Error retrieving objects for pattern ${objectIdOrPattern}: ${error.message}`);
                        
                        // Send error message with details
                        msg.error = error.message;
                        const result = formatOutput(null, objectIdOrPattern, currentOutputMode);
                        Object.assign(msg, result);
                        
                        send(msg);
                        done && done(error);
                    }
                } else {
                    // Single object retrieval
                    setStatus("blue", "dot", `Reading object ${objectIdOrPattern}...`);

                    try {
                        const objectData = await connectionManager.getObject(settings.serverId, objectIdOrPattern);
                        
                        if (!objectData) {
                            setStatus("yellow", "ring", "Object not found");
                            node.warn(`Object not found: ${objectIdOrPattern}`);
                            
                            // Send message with null payload but include object ID for reference
                            const result = formatOutput(null, objectIdOrPattern, 'single');
                            result.error = "Object not found";
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Format single object output
                        const result = formatOutput(objectData, objectIdOrPattern, 'single');
                        
                        // Add some useful metadata for single objects
                        if (objectData.common) {
                            result.objectType = objectData.type || 'unknown';
                            result.objectName = objectData.common.name || objectIdOrPattern;
                            result.objectRole = objectData.common.role || 'unknown';
                        }
                        
                        Object.assign(msg, result);
                        
                        setStatus("green", "dot", "Ready");
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Error");
                        node.error(`Error processing input: ${error.message}`);
                        
                        // Send error message with details
                        msg.error = error.message;
                        const result = formatOutput(null, objectIdOrPattern, 'single');
                        Object.assign(msg, result);
                        
                        send(msg);
                        done && done(error);
                    }
                }
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            node.log("Get object node closing...");
            
            // Unregister from events
            connectionManager.unregisterFromEvents(settings.nodeId);

            try {
                node.status({});
            } catch (statusError) {
                // Ignore status errors during cleanup
            }

            done();
        });

        // Error handling
        node.on("error", function(error) {
            node.error(`Node error: ${error.message}`);
            setError(`Node error: ${error.message}`, "Node error");
        });

        // Initialize the node
        initializeConnection();
    }

    RED.nodes.registerType("iobgetobject", iobgetobject);
};