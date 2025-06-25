 const connectionManager = require('./lib/manager/websocket-manager');

module.exports = function(RED) {
    function ioboutenhanced(config) {
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

        // Configuration with defaults
        const settings = {
            inputProperty: config.inputProperty?.trim() || "payload",
            setMode: config.setMode || "value",
            autoCreate: config.autoCreate || false,
            serverId: `${iobhost}:${iobport}`,
            nodeId: node.id,
            // Object creation settings
            stateName: config.stateName?.trim() || "",
            stateRole: config.stateRole?.trim() || "",
            payloadType: config.payloadType?.trim() || "",
            stateReadonly: config.stateReadonly?.trim() || "",
            stateUnit: config.stateUnit?.trim() || "",
            stateMin: config.stateMin !== "" ? parseFloat(config.stateMin) : undefined,
            stateMax: config.stateMax !== "" ? parseFloat(config.stateMax) : undefined
        };

        const configState = config.state?.trim();
        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

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

        // Auto-detect payload type
        function detectPayloadType(value) {
            if (value === null || value === undefined) return "mixed";
            if (typeof value === "boolean") return "boolean";
            if (typeof value === "number") return "number";
            if (typeof value === "string") return "string";
            if (Array.isArray(value)) return "array";
            if (Buffer.isBuffer && Buffer.isBuffer(value)) return "file";
            if (typeof value === "object") {
                // Check if object looks like file data
                if (value.filename || value.mimetype || value.buffer || 
                    (value.data && value.type) || value.base64) {
                    return "file";
                }
                return "object";
            }
            return "mixed";
        }

        // Get object creation properties from message or config
        function getObjectProperties(msg, stateId, value) {
            const props = {
                name: msg.stateName || settings.stateName || stateId.split('.').pop(),
                role: msg.stateRole || settings.stateRole || "state",
                type: msg.payloadType || settings.payloadType || detectPayloadType(value),
                unit: msg.stateUnit || settings.stateUnit || undefined,
                min: msg.stateMin !== undefined ? msg.stateMin : settings.stateMin,
                max: msg.stateMax !== undefined ? msg.stateMax : settings.stateMax
            };

            // Handle readonly setting - Default is writable (false)
            let readonly = false; // Default: writable
            if (msg.stateReadonly !== undefined) {
                readonly = msg.stateReadonly === true || msg.stateReadonly === "true";
            } else if (settings.stateReadonly !== "") {
                readonly = settings.stateReadonly === "true";
            }
            // If neither message nor config specifies readonly, it stays writable (false)
            props.readonly = readonly;

            return props;
        }

        // Create ioBroker object
        async function createObject(stateId, properties) {
            const objectDef = {
                _id: stateId,
                type: "state",
                common: {
                    name: properties.name,
                    role: properties.role,
                    type: properties.type,
                    read: true,
                    write: !properties.readonly
                },
                native: {}
            };

            // Add optional properties
            if (properties.unit) objectDef.common.unit = properties.unit;
            if (properties.min !== undefined) objectDef.common.min = properties.min;
            if (properties.max !== undefined) objectDef.common.max = properties.max;

            try {
                await connectionManager.setObject(settings.serverId, stateId, objectDef);
                node.log(`Created object: ${stateId} with type: ${properties.type}, role: ${properties.role}`);
                return true;
            } catch (error) {
                node.error(`Failed to create object ${stateId}: ${error.message}`);
                throw error;
            }
        }

        // Check if object exists and create if needed
        async function ensureObjectExists(stateId, msg, value) {
            if (!settings.autoCreate) {
                return true; // Skip object creation if auto-create is disabled
            }

            try {
                // Check if object already exists
                const existingObject = await connectionManager.getObject(settings.serverId, stateId);
                
                if (existingObject) {
                    node.log(`Object ${stateId} already exists, skipping creation`);
                    return true;
                }

                // Object doesn't exist, create it
                node.log(`Object ${stateId} not found, creating with auto-create settings`);
                const objectProperties = getObjectProperties(msg, stateId, value);
                await createObject(stateId, objectProperties);
                
                return true;
            } catch (error) {
                if (error.message && error.message.includes('not found')) {
                    // Object truly doesn't exist, try to create it
                    try {
                        const objectProperties = getObjectProperties(msg, stateId, value);
                        await createObject(stateId, objectProperties);
                        return true;
                    } catch (createError) {
                        node.error(`Failed to create missing object ${stateId}: ${createError.message}`);
                        throw createError;
                    }
                } else {
                    // Other error
                    node.error(`Error checking object existence for ${stateId}: ${error.message}`);
                    throw error;
                }
            }
        }

        // Create callback for event notifications
        function createEventCallback() {
            const callback = function() {};

            callback.updateStatus = function(status) {
                switch (status) {
                    case 'ready':
                        setStatus("green", "dot", "Ready");
                        node.isInitialized = true;
                        break;
                    case 'connected':
                        setStatus("green", "ring", "Connected");
                        break;
                    case 'connecting':
                        setStatus("yellow", "ring", "Connecting...");
                        break;
                    case 'disconnected':
                        setStatus("red", "ring", "Disconnected");
                        node.isInitialized = false;
                        break;
                    case 'reconnecting':
                        setStatus("yellow", "ring", "Reconnecting...");
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
                node.log("Reconnection detected by output enhanced node");
                setStatus("green", "dot", "Reconnected");
                node.isInitialized = true;
            };

            callback.onDisconnect = function() {
                node.log("Disconnection detected by output enhanced node");
                setStatus("red", "ring", "Disconnected");
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
            }
            
            return configChanged;
        }

        // Initialize connection
        async function initializeConnection() {
            try {
                setStatus("yellow", "ring", "Connecting...");
                
                // Always check for configuration changes
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
                
                // Register for events only - using existing API pattern
                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );
                
                setStatus("green", "dot", settings.autoCreate ? "Ready (Auto-create enabled)" : "Ready");
                node.isInitialized = true;
                node.log(`Connection established for output enhanced node (auto-create: ${settings.autoCreate})`);
                
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                setError(`Connection failed: ${errorMsg}`, "Connection failed");
                node.error(`Connection failed: ${errorMsg}`);
                
                // The new architecture will handle retries automatically via recovery callbacks
                // No manual retry logic needed here
            }
        }

        // Input message handler
        this.on('input', async function(msg, send, done) {
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

                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!stateId) {
                    setStatus("red", "ring", "State ID missing");
                    done && done("State ID missing (neither configured nor in msg.topic)");
                    return;
                }

                const value = msg[settings.inputProperty];
                if (value === undefined) {
                    node.error(`Input property "${settings.inputProperty}" not found in message`);
                    setStatus("red", "ring", "Input missing");
                    done && done();
                    return;
                }

                if (settings.autoCreate) {
                    setStatus("blue", "dot", "Checking object...");
                }

                // Ensure object exists if auto-create is enabled
                try {
                    await ensureObjectExists(stateId, msg, value);
                } catch (error) {
                    setStatus("red", "ring", "Object creation failed");
                    node.error(`Object creation failed for ${stateId}: ${error.message}`);
                    done && done(error);
                    return;
                }

                const ack = settings.setMode === "value";
                setStatus("blue", "dot", "Setting...");
                
                await connectionManager.setState(settings.serverId, stateId, value, ack);
                
                const autoCreateStatus = settings.autoCreate ? " (auto-create)" : "";
                setStatus("green", "dot", `Ready${autoCreateStatus}`);
                node.log(`Successfully set ${stateId} = ${value} (mode: ${settings.setMode}${autoCreateStatus})`);
                
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Failed to set value: ${error.message}`);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function(done) {
            node.log("Output enhanced node closing...");
            
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

    RED.nodes.registerType("ioboutenhanced", ioboutenhanced);
};