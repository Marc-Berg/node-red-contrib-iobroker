/*!
 * Output Helper Functions for ioBroker Node-RED Integration
 * Utilities for handling state setting operations
 */

const Orchestrator = require('../orchestrator');

class OutputHelpers {
    /**
     * Initialize output node with pending operations tracking
     */
    static initializeOutputNode(node) {
        node.pendingOperations = new Map();
        node.operationCounter = 0;
        node.lastValue = undefined;
        node.hasSetValue = false;
    }

    /**
     * Format values for status display
     */
    static formatValueForStatus(value) {
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

    /**
     * Update status with current value
     */
    static updateStatusWithValue(node, autoCreate = false) {
        if (node.hasSetValue && node.lastValue !== undefined) {
            const formattedValue = OutputHelpers.formatValueForStatus(node.lastValue);
            const autoCreateStatus = autoCreate ? " (auto-create)" : "";
            node.status({ fill: "green", shape: "dot", text: formattedValue + autoCreateStatus });
        } else {
            const autoCreateStatus = autoCreate ? " (auto-create)" : "";
            node.status({ fill: "green", shape: "dot", text: "Ready" + autoCreateStatus });
        }
    }

    /**
     * Detect payload type automatically
     */
    static detectPayloadType(value) {
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

    /**
     * Get object properties for auto-creation
     */
    static getObjectProperties(msg, node, stateId, value) {
        const props = {
            name: msg.stateName || node.stateName || stateId.split('.').pop(),
            role: msg.stateRole || node.stateRole || "state",
            type: msg.payloadType || node.payloadType || OutputHelpers.detectPayloadType(value),
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

    /**
     * Create object definition for ioBroker
     */
    static createObjectDefinition(stateId, properties) {
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

    /**
     * Ensure object exists (with auto-create logic)
     */
    static async ensureObjectExists(node, stateId, msg, value) {
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
                    const objectProperties = OutputHelpers.getObjectProperties(msg, node, stateId, value);
                    const objectDef = OutputHelpers.createObjectDefinition(stateId, objectProperties);
                    
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

    /**
     * Setup event handlers for output operations
     */
    static setupOutputEventHandlers(node, setStatus) {
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
                        OutputHelpers.updateStatusWithValue(node, node.autoCreate);
                        
                        if (operation.done) {
                            operation.done();
                        }
                    } else {
                        setStatus("red", "ring", "Set failed");
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
                        setStatus("red", "ring", "Object creation failed");
                        node.error(`Failed to create object ${objectId}: ${error}`);
                        operation.callback(false, error);
                    }
                }
            }
        };

        // Setup event listeners
        Orchestrator.on(`state:set_result:${node.id}`, onStateSetResult);
        Orchestrator.on(`object:get_result:${node.id}`, onObjectGetResult);
        Orchestrator.on(`object:set_result:${node.id}`, onObjectSetResult);

        // Return cleanup function
        return () => {
            Orchestrator.removeListener(`state:set_result:${node.id}`, onStateSetResult);
            Orchestrator.removeListener(`object:get_result:${node.id}`, onObjectGetResult);
            Orchestrator.removeListener(`object:set_result:${node.id}`, onObjectSetResult);
        };
    }

    /**
     * Process input message and set state
     */
    static async processInput(node, msg, send, done, inputProperty, configState, setMode, setStatus) {
        try {
            // Check if node is ready
            if (!node.isRegistered || !node.isInitialized) {
                setStatus("red", "ring", "Node not ready");
                if (done) done(new Error('Node not ready'));
                return;
            }

            // Get state ID
            const stateId = configState || (typeof msg.topic === "string" ? msg.topic.trim() : "");
            if (!stateId) {
                setStatus("red", "ring", "Missing state ID");
                if (done) done(new Error('State ID is required'));
                return;
            }

            // Get value
            const value = msg[inputProperty];
            if (value === undefined) {
                setStatus("red", "ring", "Input missing");
                node.error(`Input property "${inputProperty}" not found in message`);
                if (done) done(new Error(`Input property "${inputProperty}" not found in message`));
                return;
            }

            // Ensure object exists if auto-create is enabled
            if (node.autoCreate) {
                setStatus("yellow", "ring", "Checking object...");
                try {
                    await OutputHelpers.ensureObjectExists(node, stateId, msg, value);
                } catch (error) {
                    setStatus("red", "ring", "Object creation failed");
                    node.error(`Object creation failed for ${stateId}: ${error.message}`);
                    if (done) done(error);
                    return;
                }
            }

            // Set the state
            const ack = setMode === "value";
            setStatus("yellow", "ring", "Setting...");
            
            const operationId = ++node.operationCounter;
            node.pendingOperations.set(operationId, {
                operation: 'setState',
                stateId: stateId,
                value: value,
                done: done
            });
            
            Orchestrator.setState(node.id, stateId, value, ack);
            
        } catch (error) {
            setStatus("red", "ring", "Error");
            node.error(`Failed to process input: ${error.message}`);
            if (done) done(error);
        }
    }

    /**
     * Cleanup pending operations
     */
    static cleanup(node) {
        if (node.pendingOperations) {
            node.pendingOperations.clear();
        }
    }
}

module.exports = { OutputHelpers };
