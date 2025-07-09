const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobout(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        // Node-specific configuration
        const settings = {
            inputProperty: config.inputProperty?.trim() || "payload",
            setMode: config.setMode || "value",
            autoCreate: config.autoCreate || false,
            serverId,
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
        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        // Custom status texts for auto-create mode
        const statusTexts = {
            ready: settings.autoCreate ? "Ready (Auto-create enabled)" : "Ready",
            reconnected: settings.autoCreate ? "Reconnected (Auto-create)" : "Reconnected"
        };

        // Initialize connection using helper
        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        // Auto-detect payload type
        function detectPayloadType(value) {
            if (value === null || value === undefined) return "mixed";
            if (typeof value === "boolean") return "boolean";
            if (typeof value === "number") return "number";
            if (typeof value === "string") return "string";
            if (Array.isArray(value)) return "array";
            if (Buffer.isBuffer && Buffer.isBuffer(value)) return "file";
            if (typeof value === "object") {
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

            // Handle readonly setting
            let readonly = false;
            if (msg.stateReadonly !== undefined) {
                readonly = msg.stateReadonly === true || msg.stateReadonly === "true";
            } else if (settings.stateReadonly !== "") {
                readonly = settings.stateReadonly === "true";
            }
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
                return true;
            } catch (error) {
                node.error(`Failed to create object ${stateId}: ${error.message}`);
                throw error;
            }
        }

        // Check if object exists and create if needed
        async function ensureObjectExists(stateId, msg, value) {
            if (!settings.autoCreate) {
                return true;
            }

            try {
                const existingObject = await connectionManager.getObject(settings.serverId, stateId);
                
                if (existingObject) {
                    return true;
                }
                const objectProperties = getObjectProperties(msg, stateId, value);
                await createObject(stateId, objectProperties);
                
                return true;
            } catch (error) {
                if (error.message && error.message.includes('not found')) {
                    try {
                        const objectProperties = getObjectProperties(msg, stateId, value);
                        await createObject(stateId, objectProperties);
                        return true;
                    } catch (createError) {
                        node.error(`Failed to create missing object ${stateId}: ${createError.message}`);
                        throw createError;
                    }
                } else {
                    node.error(`Error checking object existence for ${stateId}: ${error.message}`);
                    throw error;
                }
            }
        }

        // Input message handler
        this.on('input', async function(msg, send, done) {
            try {
                // Handle status requests using helper
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!NodeHelpers.validateRequiredInput(stateId, "State ID", setStatus, done)) {
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
                
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Failed to set value: ${error.message}`);
                done && done(error);
            }
        });

        // Cleanup on node close
        node.on("close", async function(done) {
            await NodeHelpers.handleNodeClose(node, settings, "Output");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobout", iobout);
};