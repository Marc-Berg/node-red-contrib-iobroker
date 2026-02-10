const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobsetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            objectId: config.objectId?.trim() || "",
            objectSource: config.objectSource || "msg",
            objectProperty: config.objectProperty?.trim() || "payload",
            mergeMode: config.mergeMode || "replace",
            validateObject: config.validateObject !== false,
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        const statusTexts = {
            ready: "Ready",
            reconnected: "Reconnected"
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        node.on('input', async function(msg, send, done) {
            try {
                // Handle status requests
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                // Determine object ID
                let objectId = msg.objectId || settings.objectId;
                
                // If no objectId yet, try to extract _id from the object itself
                if (!objectId) {
                    if (settings.objectSource === "msg") {
                        const propertyPath = settings.objectProperty.split('.');
                        const objectDef = propertyPath.reduce((obj, prop) => obj?.[prop], msg);
                        if (objectDef && objectDef._id) {
                            objectId = objectDef._id;
                        }
                    } else if (settings.objectSource === "payload" && msg.payload && msg.payload._id) {
                        objectId = msg.payload._id;
                    }
                }
                
                if (!objectId || !objectId.trim()) {
                    setStatus("red", "ring", "Object ID missing");
                    const error = new Error("Object ID missing (neither configured, in msg.objectId, nor in object._id)");
                    done && done(error);
                    return;
                }

                const trimmedObjectId = objectId.trim();

                // Get object definition
                let objectDef;
                
                if (settings.objectSource === "msg") {
                    // Get from message property
                    const propertyPath = settings.objectProperty.split('.');
                    objectDef = propertyPath.reduce((obj, prop) => obj?.[prop], msg);
                    
                    if (!objectDef) {
                        setStatus("red", "ring", "Object not found");
                        const error = new Error(`Object not found at msg.${settings.objectProperty}`);
                        done && done(error);
                        return;
                    }
                } else if (settings.objectSource === "payload") {
                    objectDef = msg.payload;
                    
                    if (!objectDef || typeof objectDef !== 'object') {
                        setStatus("red", "ring", "Invalid payload");
                        const error = new Error("msg.payload must be an object");
                        done && done(error);
                        return;
                    }
                }

                // Validate object structure if enabled
                if (settings.validateObject) {
                    if (!objectDef.type) {
                        setStatus("red", "ring", "Invalid object");
                        const error = new Error("Object definition must have a 'type' property");
                        done && done(error);
                        return;
                    }
                    
                    if (!objectDef.common) {
                        setStatus("red", "ring", "Invalid object");
                        const error = new Error("Object definition must have a 'common' property");
                        done && done(error);
                        return;
                    }
                }

                // Handle merge mode
                if (settings.mergeMode === "merge") {
                    try {
                        // Get existing object first
                        const existingObject = await connectionManager.getObject(settings.serverId, trimmedObjectId);
                        
                        if (existingObject) {
                            // Deep merge objects
                            objectDef = mergeDeep(existingObject, objectDef);
                        }
                    } catch (getError) {
                        // Object doesn't exist yet - that's ok, we'll create it
                        node.warn(`Object ${trimmedObjectId} doesn't exist yet, will create new one`);
                    }
                }

                // Remove _id from object definition if present (ioBroker doesn't want it in setObject)
                const cleanObjectDef = { ...objectDef };
                delete cleanObjectDef._id;

                setStatus("blue", "dot", `Writing ${trimmedObjectId}...`);

                try {
                    await connectionManager.setObject(
                        settings.serverId,
                        trimmedObjectId,
                        cleanObjectDef
                    );

                    setStatus("green", "dot", statusTexts.ready);

                    // Send success message
                    const outputMsg = {
                        payload: {
                            success: true,
                            objectId: trimmedObjectId,
                            object: cleanObjectDef
                        },
                        objectId: trimmedObjectId,
                        timestamp: Date.now()
                    };

                    send(outputMsg);
                    done && done();

                } catch (setError) {
                    setStatus("red", "ring", "Write failed");
                    node.error(`Failed to write object ${trimmedObjectId}: ${setError.message}`);
                    done && done(setError);
                }

            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "SetObject");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    // Deep merge helper function
    function mergeDeep(target, source) {
        const output = { ...target };
        
        if (isObject(target) && isObject(source)) {
            Object.keys(source).forEach(key => {
                if (isObject(source[key])) {
                    if (!(key in target)) {
                        Object.assign(output, { [key]: source[key] });
                    } else {
                        output[key] = mergeDeep(target[key], source[key]);
                    }
                } else {
                    Object.assign(output, { [key]: source[key] });
                }
            });
        }
        
        return output;
    }

    function isObject(item) {
        return item && typeof item === 'object' && !Array.isArray(item);
    }

    RED.nodes.registerType("iobsetobject", iobsetobject);
};
