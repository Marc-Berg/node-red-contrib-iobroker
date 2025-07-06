const connectionManager = require('../lib/manager/websocket-manager');

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
            objectType: config.objectType?.trim() || "",
            useWildcard: isWildcardPattern,
            includeEnums: config.includeEnums || false,
            enumTypes: config.enumTypes || "all",
            serverId: connectionManager.getServerId(globalConfig),
            nodeId: node.id
        };

        node.currentConfig = { iobhost, iobport, user, password, usessl };
        node.isInitialized = false;

        // Log initial configuration
        if (isWildcardPattern) {
            node.log(`Wildcard pattern detected: ${configObjectId} (output mode: ${settings.outputMode})`);
        }
        if (settings.objectType) {
            node.log(`Object type filter: ${settings.objectType}`);
        }
        if (settings.includeEnums) {
            node.log(`Enum assignments enabled (types: ${settings.enumTypes})`);
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

        // Enum assignment functions
        async function loadEnumData() {
            try {
                node.log(`Loading enum data from ioBroker...`);
                const allEnums = await connectionManager.getObjects(settings.serverId, "enum.*");
                
                // Organize enums by type for faster lookup
                const enumsByType = {
                    rooms: [],
                    functions: [],
                    other: []
                };

                const enumMemberMap = new Map(); // objectId -> [enumData, ...]

                if (allEnums && Array.isArray(allEnums)) {
                    allEnums.forEach(enumObj => {
                        if (!enumObj.common || !enumObj.common.members || !Array.isArray(enumObj.common.members)) {
                            return;
                        }

                        const enumType = enumObj._id.split('.')[1]; // rooms, functions, etc.
                        const enumData = {
                            id: enumObj._id,
                            name: enumObj.common.name,
                            type: enumType,
                            icon: enumObj.common.icon,
                            color: enumObj.common.color,
                            members: enumObj.common.members
                        };

                        // Categorize enum
                        if (enumType === 'rooms') {
                            enumsByType.rooms.push(enumData);
                        } else if (enumType === 'functions') {
                            enumsByType.functions.push(enumData);
                        } else {
                            enumsByType.other.push(enumData);
                        }

                        // Build reverse lookup map
                        enumObj.common.members.forEach(memberId => {
                            if (!enumMemberMap.has(memberId)) {
                                enumMemberMap.set(memberId, []);
                            }
                            enumMemberMap.get(memberId).push(enumData);
                        });
                    });
                }

                const enumData = {
                    enumsByType,
                    enumMemberMap,
                    totalEnums: allEnums ? allEnums.length : 0
                };

                node.log(`Loaded ${enumData.totalEnums} enums (${enumsByType.rooms.length} rooms, ${enumsByType.functions.length} functions, ${enumsByType.other.length} other)`);
                
                return enumData;

            } catch (error) {
                node.error(`Failed to load enum data: ${error.message}`);
                return null;
            }
        }

        function getEnumAssignments(objectId, enumData) {
            if (!enumData || !enumData.enumMemberMap.has(objectId)) {
                return {
                    rooms: [],
                    functions: [],
                    other: [],
                    totalEnums: 0,
                    hasRoom: false,
                    hasFunction: false
                };
            }

            const assignedEnums = enumData.enumMemberMap.get(objectId);
            const assignments = {
                rooms: [],
                functions: [],
                other: [],
                totalEnums: assignedEnums.length,
                hasRoom: false,
                hasFunction: false
            };

            // Filter by enum types setting
            const includeRooms = settings.enumTypes === 'all' || settings.enumTypes.includes('rooms');
            const includeFunctions = settings.enumTypes === 'all' || settings.enumTypes.includes('functions');
            const includeOther = settings.enumTypes === 'all';

            assignedEnums.forEach(enumData => {
                if (enumData.type === 'rooms' && includeRooms) {
                    assignments.rooms.push(enumData);
                } else if (enumData.type === 'functions' && includeFunctions) {
                    assignments.functions.push(enumData);
                } else if (enumData.type !== 'rooms' && enumData.type !== 'functions' && includeOther) {
                    assignments.other.push(enumData);
                }
            });

            assignments.hasRoom = assignments.rooms.length > 0;
            assignments.hasFunction = assignments.functions.length > 0;

            // Add convenience properties
            assignments.roomName = assignments.rooms[0]?.name || null;
            assignments.functionName = assignments.functions[0]?.name || null;

            return assignments;
        }

        async function enrichObjectsWithEnums(objects, enumData) {
            if (!settings.includeEnums || !enumData) {
                return objects;
            }

            if (Array.isArray(objects)) {
                return objects.map(obj => {
                    if (obj && obj._id) {
                        obj.enumAssignments = getEnumAssignments(obj._id, enumData);
                    }
                    return obj;
                });
            } else if (objects && typeof objects === 'object' && objects._id) {
                objects.enumAssignments = getEnumAssignments(objects._id, enumData);
                return objects;
            }

            return objects;
        }

        function formatOutput(objects, objectIdOrPattern, outputMode, enumData = null) {
            // Always return a valid result object, even if objects is null/empty
            const baseResult = {
                [settings.outputProperty]: null,
                objects: null,
                objectId: objectIdOrPattern,
                objectType: settings.objectType || 'any',
                count: 0,
                timestamp: Date.now(),
                includesEnums: settings.includeEnums
            };

            if (!objects) {
                // For patterns, add pattern property
                if (isWildcardPattern || (objectIdOrPattern && objectIdOrPattern.includes('*'))) {
                    baseResult.pattern = objectIdOrPattern;
                }
                return baseResult;
            }

            // Handle single object result
            if (!Array.isArray(objects) && typeof objects === 'object') {
                // Enrich single object with enum assignments
                const enrichedObject = settings.includeEnums && enumData 
                    ? { ...objects, enumAssignments: getEnumAssignments(objects._id, enumData) }
                    : objects;

                return {
                    [settings.outputProperty]: enrichedObject,
                    objects: enrichedObject,
                    objectId: objectIdOrPattern,
                    objectType: settings.objectType || 'any',
                    count: 1,
                    timestamp: Date.now(),
                    includesEnums: settings.includeEnums
                };
            }

            // Handle multiple objects (from wildcard pattern)
            const objectArray = Array.isArray(objects) ? objects : Object.values(objects);
            
            // Enrich objects with enum assignments
            const enrichedArray = settings.includeEnums && enumData
                ? objectArray.map(obj => {
                    if (obj && obj._id) {
                        return { ...obj, enumAssignments: getEnumAssignments(obj._id, enumData) };
                    }
                    return obj;
                })
                : objectArray;

            const objectMap = {};
            
            // Create object map
            enrichedArray.forEach(obj => {
                if (obj && obj._id) {
                    objectMap[obj._id] = obj;
                }
            });

            let outputData;
            switch (outputMode) {
                case 'array':
                    outputData = enrichedArray;
                    break;
                case 'object':
                    outputData = objectMap;
                    break;
                case 'single':
                    // For single mode with multiple results, take the first one
                    outputData = enrichedArray.length > 0 ? enrichedArray[0] : null;
                    break;
                default:
                    outputData = enrichedArray;
            }

            const result = {
                [settings.outputProperty]: outputData,
                objects: objectMap,
                objectId: objectIdOrPattern,
                objectType: settings.objectType || 'any',
                count: enrichedArray.length,
                timestamp: Date.now(),
                includesEnums: settings.includeEnums
            };

            // Add pattern property for wildcard patterns
            if (isWildcardPattern || (objectIdOrPattern && objectIdOrPattern.includes('*'))) {
                result.pattern = objectIdOrPattern;
            }

            // Add enum statistics if enabled
            if (settings.includeEnums && enumData) {
                const enumStats = {
                    objectsWithRooms: 0,
                    objectsWithFunctions: 0,
                    objectsWithAnyEnum: 0,
                    totalEnumAssignments: 0
                };

                enrichedArray.forEach(obj => {
                    if (obj && obj.enumAssignments) {
                        if (obj.enumAssignments.hasRoom) enumStats.objectsWithRooms++;
                        if (obj.enumAssignments.hasFunction) enumStats.objectsWithFunctions++;
                        if (obj.enumAssignments.totalEnums > 0) enumStats.objectsWithAnyEnum++;
                        enumStats.totalEnumAssignments += obj.enumAssignments.totalEnums;
                    }
                });

                result.enumStatistics = enumStats;
            }

            return result;
        }

        // Create callback for event notifications
        function createEventCallback() {
            const callback = function() {};

            callback.updateStatus = function(status) {
                switch (status) {
                    case 'ready':
                        const readyText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                        const enumText = settings.includeEnums ? " +enums" : "";
                        setStatus("green", "dot", readyText + enumText);
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
                const enumText = settings.includeEnums ? " +enums" : "";
                setStatus("green", "dot", reconnectedText + enumText);
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
                    
                    const newServerId = connectionManager.getServerId(newGlobalConfig);
                    settings.serverId = newServerId;
                    
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
                
                // Check connection status
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (status.ready) {
                    const readyText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                    const enumText = settings.includeEnums ? " +enums" : "";
                    setStatus("green", "dot", readyText + enumText);
                    node.isInitialized = true;
                    node.log(`Connection established for get object node (wildcard: ${isWildcardPattern}, type filter: ${settings.objectType || 'none'}, enums: ${settings.includeEnums})`);
                } else {
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
                const currentObjectType = msg.objectType || settings.objectType;
                
                // Load enum data if needed
                let enumData = null;
                if (settings.includeEnums) {
                    setStatus("blue", "dot", `Loading enums...`);
                    enumData = await loadEnumData();
                    if (!enumData) {
                        node.warn(`Failed to load enum data - continuing without enum assignments`);
                    }
                }

                if (isCurrentWildcard) {
                    const statusText = settings.includeEnums ? `Reading objects ${objectIdOrPattern} +enums...` : `Reading objects ${objectIdOrPattern}...`;
                    setStatus("blue", "dot", statusText);
                    
                    try {
                        // Use getObjects for wildcard patterns - server-side filtering
                        const objects = await connectionManager.getObjects(settings.serverId, objectIdOrPattern, currentObjectType);
                        
                        if (!objects || (Array.isArray(objects) && objects.length === 0) || 
                            (typeof objects === 'object' && Object.keys(objects).length === 0)) {
                            setStatus("yellow", "ring", "No objects found");
                            const typeInfo = currentObjectType ? ` (type: ${currentObjectType})` : '';
                            node.warn(`No objects found for pattern: ${objectIdOrPattern}${typeInfo}`);
                            
                            // Send message with empty result
                            const result = formatOutput(currentOutputMode === 'array' ? [] : {}, objectIdOrPattern, currentOutputMode, enumData);
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Format output according to configured mode (including enum enrichment)
                        const result = formatOutput(objects, objectIdOrPattern, currentOutputMode, enumData);
                        Object.assign(msg, result);
                        
                        const readyText = isWildcardPattern ? "Ready (Pattern)" : "Ready";
                        const enumText = settings.includeEnums ? " +enums" : "";
                        setStatus("green", "dot", readyText + enumText);
                        
                        const typeInfo = currentObjectType ? ` (filtered by type: ${currentObjectType})` : '';
                        const enumInfo = settings.includeEnums ? ` with enum assignments` : '';
                        node.log(`Successfully retrieved ${result.count} objects for pattern: ${objectIdOrPattern} (mode: ${currentOutputMode})${typeInfo}${enumInfo}`);
                        
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Pattern error");
                        node.error(`Error retrieving objects for pattern ${objectIdOrPattern}: ${error.message}`);
                        
                        // Send error message with details
                        const result = formatOutput(null, objectIdOrPattern, currentOutputMode, enumData);
                        result.error = error.message;
                        result.errorType = error.message.includes('timeout') ? 'timeout' : 'unknown';
                        Object.assign(msg, result);
                        
                        send(msg);
                        done && done(error);
                    }
                } else {
                    // Single object retrieval
                    const statusText = settings.includeEnums ? `Reading object ${objectIdOrPattern} +enums...` : `Reading object ${objectIdOrPattern}...`;
                    setStatus("blue", "dot", statusText);

                    try {
                        // For single objects, we can still apply type filtering
                        let objectData = await connectionManager.getObject(settings.serverId, objectIdOrPattern);
                        
                        // Apply type filter for single objects if specified
                        if (objectData && currentObjectType && objectData.type !== currentObjectType) {
                            objectData = null; // Filter out object if type doesn't match
                        }
                        
                        if (!objectData) {
                            const typeInfo = currentObjectType ? ` (type filter: ${currentObjectType})` : '';
                            setStatus("yellow", "ring", "Object not found");
                            node.warn(`Object not found: ${objectIdOrPattern}${typeInfo}`);
                            
                            // Send message with null payload but include object ID for reference
                            const result = formatOutput(null, objectIdOrPattern, 'single', enumData);
                            result.error = currentObjectType ? "Object not found or type mismatch" : "Object not found";
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Format single object output (including enum enrichment)
                        const result = formatOutput(objectData, objectIdOrPattern, 'single', enumData);
                        
                        // Add some useful metadata for single objects
                        if (objectData.common) {
                            result.objectTypeName = objectData.type || 'unknown';
                            result.objectName = objectData.common.name || objectIdOrPattern;
                            result.objectRole = objectData.common.role || 'unknown';
                        }
                        
                        Object.assign(msg, result);
                        
                        const enumText = settings.includeEnums ? " +enums" : "";
                        setStatus("green", "dot", "Ready" + enumText);
                        
                        const typeInfo = currentObjectType ? ` (type filter: ${currentObjectType})` : '';
                        const enumInfo = settings.includeEnums ? ` with enum assignments` : '';
                        node.log(`Successfully retrieved object: ${objectIdOrPattern}${typeInfo}${enumInfo}`);
                        
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Error");
                        node.error(`Error processing input: ${error.message}`);
                        
                        // Send error message with details
                        const result = formatOutput(null, objectIdOrPattern, 'single', enumData);
                        result.error = error.message;
                        result.errorType = error.message.includes('timeout') ? 'timeout' : 'unknown';
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