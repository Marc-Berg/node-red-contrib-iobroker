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
            enableHistory: config.enableHistory || false,
            historyAdapter: config.historyAdapter?.trim() || "",
            historyTemplate: config.historyTemplate?.trim() || "",
            historySettings: {},
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

        // Parse History Settings
        try {
            settings.historySettings = config.historySettings ? 
                JSON.parse(config.historySettings) : {};
        } catch (e) {
            node.warn("Invalid history settings JSON, using defaults");
            settings.historySettings = {};
        }

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
            const historyStatus = settings.enableHistory ? " (history)" : "";
            
            if (node.hasSetValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                setStatus("green", "dot", formattedValue + autoCreateStatus + historyStatus);
            } else {
                setStatus("green", "dot", "Ready" + autoCreateStatus + historyStatus);
            }
        }

        const statusTexts = {
            ready: (settings.autoCreate ? "Ready (Auto-create enabled)" : "Ready") + 
                   (settings.enableHistory ? " (History enabled)" : ""),
            reconnected: (settings.autoCreate ? "Reconnected (Auto-create)" : "Reconnected") + 
                        (settings.enableHistory ? " (History)" : "")
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

        function getHistoryDefaults(adapterType) {
            const defaults = {
                history: {
                    changesOnly: true,
                    maxLength: 960,
                    retention: 365,
                    debounce: 0
                },
                influxdb: {
                    storageType: "",
                    aliasId: "",
                    debounceTime: 0,
                    blockTime: 0,
                    changesOnly: true,
                    changesRelogInterval: 0,
                    changesMinDelta: 0,
                    debounce: 0,
                    ignoreBelowNumber: "",
                    disableSkippedValueLogging: false,
                    enableDebugLogs: false,
                    round: "",
                    ignoreZero: false,
                    ignoreAboveNumber: ""
                },
                sql: {
                    storageType: "Number",
                    changesOnly: true,
                    debounce: 0,
                    retention: 365
                }
            };
            
            return defaults[adapterType] || {};
        }

        function getHistoryConfig(msg) {
            // Priority 1: Message-based configuration
            if (msg.historyConfig) {
                return msg.historyConfig;
            }
            
            // Priority 2: Node configuration
            if (settings.enableHistory && settings.historyAdapter) {
                return {
                    adapter: settings.historyAdapter,
                    ...settings.historySettings
                };
            }
            
            return null;
        }

        async function applyHistoryConfig(stateId, historyConfig) {
            try {
                const historyConfigs = Array.isArray(historyConfig) ? historyConfig : [historyConfig];
                
                for (const config of historyConfigs) {
                    // Simple string format: just adapter name
                    const finalConfig = typeof config === 'string' ? { adapter: config } : config;
                    
                    if (!finalConfig.adapter) {
                        throw new Error("History adapter not specified");
                    }
                    
                    // Get existing object
                    const obj = await connectionManager.getObject(settings.serverId, stateId);
                    if (!obj) {
                        throw new Error(`Object ${stateId} not found`);
                    }
                    
                    // Check if history is already configured correctly
                    if (obj.common.custom && obj.common.custom[finalConfig.adapter]) {
                        const existing = obj.common.custom[finalConfig.adapter];
                        if (existing.enabled) {
                            // History already configured - check if update needed
                            const adapterType = finalConfig.adapter.split('.')[0];
                            const defaults = getHistoryDefaults(adapterType);
                            const expectedConfig = {
                                enabled: true,
                                ...defaults,
                                ...finalConfig,
                                adapter: undefined
                            };
                            
                            // Compare configurations (simple check)
                            if (JSON.stringify(existing) === JSON.stringify(expectedConfig)) {
                                node.log(`History already configured for ${stateId} on ${finalConfig.adapter}`);
                                continue; // Skip this adapter, already configured correctly
                            }
                        }
                    }
                    
                    // Initialize custom section
                    if (!obj.common.custom) {
                        obj.common.custom = {};
                    }
                    
                    // Get adapter type and defaults
                    const adapterType = finalConfig.adapter.split('.')[0];
                    const defaults = getHistoryDefaults(adapterType);
                    
                    // Apply history configuration
                    obj.common.custom[finalConfig.adapter] = {
                        enabled: true,
                        ...defaults,
                        ...finalConfig,
                        adapter: undefined // Remove adapter key from config
                    };
                    
                    // Save object
                    await connectionManager.setObject(settings.serverId, stateId, obj);
                    
                    node.log(`History enabled for ${stateId} on ${finalConfig.adapter}`);
                }
                
            } catch (error) {
                throw new Error(`Failed to apply history config: ${error.message}`);
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
                
                // Apply history configuration only when creating new objects
                const historyConfig = getHistoryConfig(msg);
                if (historyConfig) {
                    try {
                        await applyHistoryConfig(stateId, historyConfig);
                    } catch (historyError) {
                        node.warn(`History configuration failed for new object ${stateId}: ${historyError.message}`);
                        // Don't fail object creation if history config fails
                    }
                }
                
                return true;
            } catch (error) {
                if (error.message && error.message.includes('not found')) {
                    try {
                        await createObject(stateId, objectProperties);
                        
                        // Apply history configuration only when creating new objects
                        const historyConfig = getHistoryConfig(msg);
                        if (historyConfig) {
                            try {
                                await applyHistoryConfig(stateId, historyConfig);
                            } catch (historyError) {
                                node.warn(`History configuration failed for new object ${stateId}: ${historyError.message}`);
                                // Don't fail object creation if history config fails
                            }
                        }
                        
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