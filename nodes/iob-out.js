const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers } = require('../lib/utils/status-helpers');

module.exports = function(RED) {
    function IoBrokerOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.server = RED.nodes.getNode(config.server);
        node.inputProperty = config.inputProperty?.trim() || "payload";
        node.setMode = config.setMode || "value";
        node.autoCreate = config.autoCreate || false;
        node.configState = config.state?.trim();
        
        // Auto-create object settings
        node.stateName = config.stateName?.trim() || "";
        node.stateRole = config.stateRole?.trim() || "";
        node.payloadType = config.payloadType?.trim() || "";
        node.stateReadonly = config.stateReadonly?.trim() || "";
        node.stateUnit = config.stateUnit?.trim() || "";
        node.stateMin = config.stateMin !== "" ? parseFloat(config.stateMin) : undefined;
        node.stateMax = config.stateMax !== "" ? parseFloat(config.stateMax) : undefined;
        
        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Store last set value for status display
        node.lastValue = undefined;
        node.hasSetValue = false;
        
        // Pending operations for async handling
        node.pendingOperations = new Map(); // operationId -> { msg, done, operation }
        node.operationCounter = 0;

        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        // Helper function to format values for status display
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

        // Helper function to update status with current value
        function updateStatusWithValue() {
            if (node.hasSetValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                const autoCreateStatus = node.autoCreate ? " (auto-create)" : "";
                node.status({ fill: "green", shape: "dot", text: formattedValue + autoCreateStatus });
            } else {
                const autoCreateStatus = node.autoCreate ? " (auto-create)" : "";
                node.status({ fill: "green", shape: "dot", text: "Ready" + autoCreateStatus });
            }
        }

        // Helper function to detect payload type
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

        // Helper function to get object properties
        function getObjectProperties(msg, stateId, value) {
            const props = {
                name: msg.stateName || node.stateName || stateId.split('.').pop(),
                role: msg.stateRole || node.stateRole || "state",
                type: msg.payloadType || node.payloadType || detectPayloadType(value),
                unit: msg.stateUnit || node.stateUnit || undefined,
                min: msg.stateMin !== undefined ? msg.stateMin : node.stateMin,
                max: msg.stateMax !== undefined ? msg.stateMax : node.stateMax
            };

            let readonly = false;
            if (msg.stateReadonly !== undefined) {
                readonly = msg.stateReadonly === true || msg.stateReadonly === "true";
            } else if (node.stateReadonly !== "") {
                readonly = node.stateReadonly === "true";
            }
            props.readonly = readonly;

            return props;
        }

        // Helper function to create object definition
        function createObjectDefinition(stateId, properties) {
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

            return objectDef;
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'ready', 'Ready');
                updateStatusWithValue();
            }
        };

        const onStateSetResult = ({ serverId, stateId, nodeId, success, error }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                // Find the pending operation
                let operationId = null;
                for (const [id, op] of node.pendingOperations) {
                    if (op.operation === 'setState' && op.stateId === stateId) {
                        operationId = id;
                        break;
                    }
                }
                
                if (operationId) {
                    const operation = node.pendingOperations.get(operationId);
                    node.pendingOperations.delete(operationId);
                    
                    if (success) {
                        node.log(`Successfully set state ${stateId} to ${operation.value}`);
                        node.lastValue = operation.value;
                        node.hasSetValue = true;
                        updateStatusWithValue();
                        
                        if (operation.done) {
                            operation.done();
                        }
                    } else {
                        StatusHelpers.updateConnectionStatus(node, 'error', 'Set failed');
                        node.error(`Failed to set state ${stateId}: ${error}`);
                        if (operation.done) {
                            operation.done(new Error(`Failed to set state: ${error}`));
                        }
                    }
                }
            }
        };

        const onObjectGetResult = ({ serverId, objectId, nodeId, success, object, error }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                // Find the pending operation
                let operationId = null;
                for (const [id, op] of node.pendingOperations) {
                    if (op.operation === 'getObject' && op.objectId === objectId) {
                        operationId = id;
                        break;
                    }
                }
                
                if (operationId) {
                    const operation = node.pendingOperations.get(operationId);
                    node.pendingOperations.delete(operationId);
                    
                    if (success && object) {
                        // Object exists, proceed with setState
                        node.log(`Object ${objectId} exists, setting state`);
                        operation.callback(true);
                    } else {
                        // Object doesn't exist, need to create it
                        node.log(`Object ${objectId} doesn't exist, creating it`);
                        operation.callback(false);
                    }
                }
            }
        };

        const onObjectSetResult = ({ serverId, objectId, nodeId, success, error }) => {
            if (serverId === node.server.id && nodeId === node.id) {
                // Find the pending operation
                let operationId = null;
                for (const [id, op] of node.pendingOperations) {
                    if (op.operation === 'setObject' && op.objectId === objectId) {
                        operationId = id;
                        break;
                    }
                }
                
                if (operationId) {
                    const operation = node.pendingOperations.get(operationId);
                    node.pendingOperations.delete(operationId);
                    
                    if (success) {
                        node.log(`Successfully created object ${objectId}`);
                        operation.callback(true);
                    } else {
                        StatusHelpers.updateConnectionStatus(node, 'error', 'Object creation failed');
                        node.error(`Failed to create object ${objectId}: ${error}`);
                        operation.callback(false, error);
                    }
                }
            }
        };

        const onDisconnected = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'disconnected', 'Disconnected');
            }
        };

        const onRetrying = ({ serverId, attempt, delay }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'retrying', `Retrying in ${delay / 1000}s (Attempt #${attempt})`);
            }
        };

        const onPermanentFailure = ({ serverId, error }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'error', `Failed: ${error.message}`);
            }
        };

        // --- Helper Functions ---

        // Async function to ensure object exists if auto-create is enabled
        async function ensureObjectExists(stateId, msg, value) {
            return new Promise((resolve, reject) => {
                if (!node.autoCreate) {
                    resolve(true);
                    return;
                }

                const operationId = ++node.operationCounter;
                
                // First check if object exists
                node.pendingOperations.set(operationId, {
                    operation: 'getObject',
                    objectId: stateId,
                    callback: (exists, error) => {
                        if (error) {
                            reject(new Error(`Failed to check object existence: ${error}`));
                            return;
                        }
                        
                        if (exists) {
                            resolve(true);
                            return;
                        }
                        
                        // Object doesn't exist, create it
                        const objectProperties = getObjectProperties(msg, stateId, value);
                        const objectDef = createObjectDefinition(stateId, objectProperties);
                        
                        const createOperationId = ++node.operationCounter;
                        node.pendingOperations.set(createOperationId, {
                            operation: 'setObject',
                            objectId: stateId,
                            callback: (success, createError) => {
                                if (success) {
                                    resolve(true);
                                } else {
                                    reject(new Error(`Failed to create object: ${createError}`));
                                }
                            }
                        });
                        
                        Orchestrator.setObject(node.id, stateId, objectDef);
                    }
                });
                
                Orchestrator.getObject(node.id, stateId);
            });
        }

        // --- Node Input Handler ---

        node.on('input', async function(msg, send, done) {
            try {
                // Check if orchestrator is ready
                if (!node.isRegistered) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Node not registered');
                    if (done) done(new Error('Node not registered with orchestrator'));
                    return;
                }

                // Get state ID from config or message topic
                const stateId = node.configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                
                if (!stateId) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Missing state ID');
                    if (done) done(new Error('State ID is required'));
                    return;
                }

                // Get value from message
                const value = msg[node.inputProperty];
                if (value === undefined) {
                    StatusHelpers.updateConnectionStatus(node, 'error', 'Input missing');
                    node.error(`Input property "${node.inputProperty}" not found in message`);
                    if (done) done(new Error(`Input property "${node.inputProperty}" not found in message`));
                    return;
                }

                // Check/create object if auto-create is enabled
                if (node.autoCreate) {
                    StatusHelpers.updateConnectionStatus(node, 'checking', 'Checking object...');
                    try {
                        await ensureObjectExists(stateId, msg, value);
                    } catch (error) {
                        StatusHelpers.updateConnectionStatus(node, 'error', 'Object creation failed');
                        node.error(`Object creation failed for ${stateId}: ${error.message}`);
                        if (done) done(error);
                        return;
                    }
                }

                // Set the state
                const ack = node.setMode === "value";
                StatusHelpers.updateConnectionStatus(node, 'setting', 'Setting...');
                
                const operationId = ++node.operationCounter;
                node.pendingOperations.set(operationId, {
                    operation: 'setState',
                    stateId: stateId,
                    value: value,
                    done: done
                });
                
                Orchestrator.setState(node.id, stateId, value, ack);
                
            } catch (error) {
                StatusHelpers.updateConnectionStatus(node, 'error', 'Error');
                node.error(`Failed to process input: ${error.message}`);
                if (done) done(error);
            }
        });

        // --- Node Lifecycle ---

        // Function to register with orchestrator
        const registerWithOrchestrator = () => {
            if (!node.isRegistered) {
                node.log(`Registering node with orchestrator after flows started`);
                Orchestrator.registerNode(node.id, node.server);
                node.isRegistered = true;
            }
        };

        // Register with orchestrator when flows are ready
        // Use timeout to ensure registration happens after flows are started
        setTimeout(() => {
            registerWithOrchestrator();
        }, 300);

        // Listen for events from the Orchestrator
        Orchestrator.on('server:ready', onServerReady);
        Orchestrator.on(`state:set_result:${node.id}`, onStateSetResult);
        Orchestrator.on(`object:get_result:${node.id}`, onObjectGetResult);
        Orchestrator.on(`object:set_result:${node.id}`, onObjectSetResult);
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);

        node.on('close', function(done) {
            // Clean up any pending operations
            node.pendingOperations.clear();
            
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
            Orchestrator.removeListener(`state:set_result:${node.id}`, onStateSetResult);
            Orchestrator.removeListener(`object:get_result:${node.id}`, onObjectGetResult);
            Orchestrator.removeListener(`object:set_result:${node.id}`, onObjectSetResult);
            Orchestrator.removeListener('connection:disconnected', onDisconnected);
            Orchestrator.removeListener('connection:retrying', onRetrying);
            Orchestrator.removeListener('connection:failed_permanently', onPermanentFailure);
            
            // Only unregister if we were actually registered
            if (node.isRegistered) {
                Orchestrator.unregisterNode(node.id, node.server.id);
            }
            done();
        });

        // Initial status
        const initialStatusText = node.autoCreate ? "Waiting for server... (auto-create)" : "Waiting for server...";
        StatusHelpers.updateConnectionStatus(node, 'waiting', initialStatusText);
    }

    RED.nodes.registerType("iobout", IoBrokerOutNode);
};