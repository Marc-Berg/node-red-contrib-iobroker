const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobout(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            inputProperty: config.inputProperty?.trim() || "payload",
            setMode: config.setMode || "value",
            autoCreate: config.autoCreate || false,
            serverId,
            nodeId: node.id,
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
        node.lastValue = undefined;
        node.hasSetValue = false;

        function formatValueForStatus(value) {
            let displayValue;
            
            if (value === null) {
                displayValue = "null";
            } else if (value === undefined) {
                displayValue = "undefined";
            } else if (typeof value === 'boolean') {
                displayValue = value ? "true" : "false";
            } else if (typeof value === 'object') {
                try {
                    displayValue = JSON.stringify(value);
                } catch (e) {
                    displayValue = "[Object]";
                }
            } else {
                displayValue = String(value);
            }
            
            if (displayValue.length > 20) {
                return "..." + displayValue.slice(-20);
            }
            
            return displayValue;
        }

        function updateStatusWithValue() {
            const autoCreateStatus = settings.autoCreate ? " (auto-create)" : "";
            
            if (node.hasSetValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                setStatus("green", "dot", formattedValue + autoCreateStatus);
            } else {
                setStatus("green", "dot", "Ready" + autoCreateStatus);
            }
        }

        const statusTexts = {
            ready: settings.autoCreate ? "Ready (Auto-create enabled)" : "Ready",
            reconnected: settings.autoCreate ? "Reconnected (Auto-create)" : "Reconnected"
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

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

        function getObjectProperties(msg, stateId, value) {
            const props = {
                name: msg.stateName || settings.stateName || stateId.split('.').pop(),
                role: msg.stateRole || settings.stateRole || "state",
                type: msg.payloadType || settings.payloadType || detectPayloadType(value),
                unit: msg.stateUnit || settings.stateUnit || undefined,
                min: msg.stateMin !== undefined ? msg.stateMin : settings.stateMin,
                max: msg.stateMax !== undefined ? msg.stateMax : settings.stateMax
            };

            let readonly = false;
            if (msg.stateReadonly !== undefined) {
                readonly = msg.stateReadonly === true || msg.stateReadonly === "true";
            } else if (settings.stateReadonly !== "") {
                readonly = settings.stateReadonly === "true";
            }
            props.readonly = readonly;

            return props;
        }

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

        async function ensureObjectExists(stateId, msg, value) {
            if (!settings.autoCreate) {
                return true;
            }

            const objectProperties = getObjectProperties(msg, stateId, value);

            try {
                const existingObject = await connectionManager.getObject(settings.serverId, stateId);
                
                if (existingObject) {
                    return true;
                }
                
                await createObject(stateId, objectProperties);
                return true;
            } catch (error) {
                if (error.message && error.message.includes('not found')) {
                    try {
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

        this.on('input', async function(msg, send, done) {
            try {
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

                try {
                    await ensureObjectExists(stateId, msg, value);
                } catch (error) {
                    setStatus("red", "ring", "Object creation failed");
                    node.error(`Object creation failed for ${stateId}: ${error.message}`);
                    done && done(error);
                    return;
                }

                const ack = settings.setMode === "value";
                const customTimestamp = msg.ts && typeof msg.ts === 'number' ? msg.ts : null;
                setStatus("blue", "dot", "Setting...");
                
                await connectionManager.setState(settings.serverId, stateId, value, ack, customTimestamp);
                
                node.lastValue = value;
                node.hasSetValue = true;
                updateStatusWithValue();
                
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Failed to set value: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(done) {
            await NodeHelpers.handleNodeClose(node, settings, "Output");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobout", iobout);
};