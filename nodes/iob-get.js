const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers, NodePatterns } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobget(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;
        node.lastValue = undefined;
        node.hasRetrievedValue = false;

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
            if (node.hasRetrievedValue && node.lastValue !== undefined) {
                const formattedValue = formatValueForStatus(node.lastValue);
                setStatus("green", "dot", formattedValue);
            } else {
                setStatus("green", "dot", "Ready");
            }
        }

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus
        );

        node.on('input', async function(msg, send, done) {
            try {
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }
                
                // Extract state IDs from different input formats
                let stateIds = [];
                
                // Priority: msg.objects takes precedence over msg.topic
                if (msg.objects && typeof msg.objects === 'object') {
                    // Auto-extract from getObject output - only process objects with type "state"
                    const stateObjectIds = [];
                    const aliasIds = [];
                    
                    // Filter for state objects and extract alias state IDs
                    Object.entries(msg.objects).forEach(([objectId, obj]) => {
                        if (obj && obj.type === 'state') {
                            stateObjectIds.push(objectId);
                        }
                        
                        if (obj && obj.aliasInfo) {
                            // Add alias target IDs
                            if (obj.aliasInfo.isAlias && obj.aliasInfo.aliasTarget) {
                                if (obj.aliasInfo.aliasTarget.type === 'simple' && obj.aliasInfo.aliasTarget.target) {
                                    aliasIds.push(obj.aliasInfo.aliasTarget.target._id);
                                } else if (obj.aliasInfo.aliasTarget.type === 'complex' && obj.aliasInfo.aliasTarget.targets) {
                                    obj.aliasInfo.aliasTarget.targets.forEach(target => {
                                        if (target && target._id) {
                                            aliasIds.push(target._id);
                                        }
                                    });
                                }
                            }
                            
                            // Add states that are aliased by this object
                            if (obj.aliasInfo.aliasedBy && Array.isArray(obj.aliasInfo.aliasedBy)) {
                                obj.aliasInfo.aliasedBy.forEach(alias => {
                                    if (alias && alias._id) {
                                        aliasIds.push(alias._id);
                                    }
                                });
                            }
                        }
                    });
                    
                    stateIds = [...stateObjectIds, ...aliasIds];
                } else if (msg.topic !== undefined && msg.topic !== '') {
                    // Explicit topic (single string or array) - only if no objects present
                    const topicIds = Array.isArray(msg.topic) ? msg.topic : [msg.topic];
                    
                    // Check for wildcard patterns and reject them
                    const hasWildcards = topicIds.some(id => typeof id === 'string' && id.includes('*'));
                    if (hasWildcards) {
                        setStatus("red", "ring", "Wildcards not supported");
                        done && done(new Error("iob-get does not support wildcard patterns in msg.topic. Use iob-getobject for pattern matching, then chain to iob-get."));
                        return;
                    }
                    
                    stateIds = topicIds;
                } else {
                    // Fallback to configured state
                    const configState = config.state?.trim();
                    if (configState) {
                        stateIds = [configState];
                    }
                }
                
                if (stateIds.length === 0) {
                    // If we have msg.objects but no state objects were found, return graceful empty result
                    if (msg.objects && typeof msg.objects === 'object') {
                        setStatus("yellow", "ring", "No state objects found");
                        
                        // Return empty result in same format as batch mode
                        msg.topic = "batch_states";
                        msg[settings.outputProperty] = {};
                        msg.states = {};
                        msg.timestamp = Date.now();
                        msg.count = 0; // Update count to reflect actual retrieved states
                        
                        // Keep original objects if available
                        if (Object.keys(msg.objects).length === 0) {
                            msg.objects = {};
                        }
                        
                        node.lastValue = "0 states";
                        node.hasRetrievedValue = true;
                        updateStatusWithValue();
                        
                        send(msg);
                        done && done();
                        return;
                    }
                    
                    // Only validate required input if no msg.objects provided (original behavior)
                    if (!NodeHelpers.validateRequiredInput("", "State ID", setStatus, done)) {
                        return;
                    }
                }
                
                // Filter and validate state IDs
                const validStateIds = stateIds
                    .filter(id => typeof id === 'string' && id.trim())
                    .map(id => id.trim());
                
                if (validStateIds.length === 0) {
                    setStatus("red", "ring", "No valid state IDs");
                    done && done(new Error("No valid state IDs found"));
                    return;
                }
                
                if (validStateIds.length === 1) {
                    // Single state mode
                    const stateId = validStateIds[0];
                    setStatus("blue", "dot", `Reading ${stateId}...`);
                    
                    const state = await connectionManager.getState(settings.serverId, stateId);
                    
                    const valueToSet = state?.val !== undefined ? state.val : state;
                    msg[settings.outputProperty] = valueToSet;
                    msg.state = state;
                    msg.timestamp = Date.now();
                    
                    node.lastValue = valueToSet;
                    node.hasRetrievedValue = true;
                    updateStatusWithValue();
                    
                } else {
                    // Batch mode - format like iob-in grouped messages
                    setStatus("blue", "dot", `Reading ${validStateIds.length} states...`);
                    
                    const stateResults = await connectionManager.getStates(settings.serverId, validStateIds);
                    
                    const values = {};
                    const states = {};
                    
                    for (const [stateId, stateData] of Object.entries(stateResults)) {
                        if (stateData && stateData.val !== undefined) {
                            values[stateId] = stateData.val;
                            states[stateId] = stateData;
                        }
                    }
                    
                    msg.topic = "batch_states";
                    msg[settings.outputProperty] = values;
                    msg.states = states;
                    msg.timestamp = Date.now();
                    msg.count = Object.keys(values).length; // Update count to reflect actual retrieved states
                    
                    // Include objects info if available (for compatibility with iob-getobject)
                    // Include ALL objects for states that were retrieved (originals + aliases)
                    if (msg.objects && typeof msg.objects === 'object') {
                        const allObjects = {};
                        const retrievedStateIds = new Set(Object.keys(stateResults));
                        
                        // Add original objects that have corresponding states
                        Object.entries(msg.objects).forEach(([objectId, obj]) => {
                            if (retrievedStateIds.has(objectId)) {
                                allObjects[objectId] = obj;
                            }
                        });
                        
                        // Add alias objects for alias states that were retrieved
                        Object.entries(msg.objects).forEach(([objectId, obj]) => {
                            if (obj && obj.aliasInfo && obj.aliasInfo.aliasedBy) {
                                obj.aliasInfo.aliasedBy.forEach(aliasObj => {
                                    if (aliasObj && aliasObj._id && retrievedStateIds.has(aliasObj._id)) {
                                        allObjects[aliasObj._id] = aliasObj;
                                    }
                                });
                            }
                        });
                        
                        // Only include objects if we have some to show
                        if (Object.keys(allObjects).length > 0) {
                            msg.objects = allObjects;
                        }
                    }
                    
                    node.lastValue = `${Object.keys(values).length} states`;
                    node.hasRetrievedValue = true;
                    updateStatusWithValue();
                }
                
                send(msg);
                done && done();
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "Get");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobget", iobget);
};