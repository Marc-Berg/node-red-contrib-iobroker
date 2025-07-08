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
            includeAliases: config.includeAliases || false,
            aliasResolution: config.aliasResolution || "both",
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
        if (settings.includeAliases) {
            node.log(`Alias resolution enabled (mode: ${settings.aliasResolution})`);
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
                
                const enumsByType = {
                    rooms: [],
                    functions: [],
                    other: []
                };

                const enumMemberMap = new Map();

                if (allEnums && Array.isArray(allEnums)) {
                    allEnums.forEach(enumObj => {
                        if (!enumObj.common || !enumObj.common.members || !Array.isArray(enumObj.common.members)) {
                            return;
                        }

                        const enumType = enumObj._id.split('.')[1];
                        const enumData = {
                            id: enumObj._id,
                            name: enumObj.common.name,
                            type: enumType,
                            icon: enumObj.common.icon,
                            color: enumObj.common.color,
                            members: enumObj.common.members
                        };

                        if (enumType === 'rooms') {
                            enumsByType.rooms.push(enumData);
                        } else if (enumType === 'functions') {
                            enumsByType.functions.push(enumData);
                        } else {
                            enumsByType.other.push(enumData);
                        }

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

            assignments.roomName = assignments.rooms[0]?.name || null;
            assignments.functionName = assignments.functions[0]?.name || null;

            return assignments;
        }

        // Alias functions
        async function loadAliasData() {
            try {
                node.log(`Loading alias data from ioBroker...`);
                const allAliases = await connectionManager.getObjects(settings.serverId, "alias.*");
                
                const aliasMap = new Map(); // alias ID → target info
                const reverseAliasMap = new Map(); // target ID → [alias objects...]
                const aliasObjects = new Map(); // alias ID → full alias object

                if (allAliases && Array.isArray(allAliases)) {
                    allAliases.forEach(aliasObj => {
                        if (aliasObj.common && aliasObj.common.alias && aliasObj.common.alias.id) {
                            const aliasId = aliasObj._id;
                            const aliasConfig = aliasObj.common.alias.id;
                            
                            // Handle both simple string IDs and complex read/write objects
                            let targetInfo;
                            if (typeof aliasConfig === 'string') {
                                // Simple alias: "target.state.id"
                                targetInfo = {
                                    type: 'simple',
                                    read: aliasConfig,
                                    write: aliasConfig,
                                    targets: [aliasConfig]
                                };
                            } else if (typeof aliasConfig === 'object' && aliasConfig !== null) {
                                // Complex alias with read/write: { read: "...", write: "..." }
                                const readId = aliasConfig.read || null;
                                const writeId = aliasConfig.write || null;
                                
                                targetInfo = {
                                    type: 'complex',
                                    read: readId,
                                    write: writeId,
                                    targets: [readId, writeId].filter(id => id && typeof id === 'string')
                                };
                            } else {
                                // Invalid alias configuration
                                node.warn(`Invalid alias configuration for ${aliasId}: ${JSON.stringify(aliasConfig)}`);
                                return;
                            }
                            
                            // Store alias mapping
                            aliasMap.set(aliasId, targetInfo);
                            aliasObjects.set(aliasId, aliasObj);
                            
                            // Store reverse mapping for all target IDs
                            targetInfo.targets.forEach(targetId => {
                                if (!reverseAliasMap.has(targetId)) {
                                    reverseAliasMap.set(targetId, []);
                                }
                                reverseAliasMap.get(targetId).push(aliasObj);
                            });
                        }
                    });
                }

                const aliasData = {
                    aliasMap,
                    reverseAliasMap,
                    aliasObjects,
                    totalAliases: aliasMap.size
                };

                node.log(`Loaded ${aliasData.totalAliases} aliases (simple + complex read/write)`);
                return aliasData;

            } catch (error) {
                node.error(`Failed to load alias data: ${error.message}`);
                return null;
            }
        }

        async function getAliasInfo(objectId, aliasData, enumData = null) {
            if (!aliasData) {
                return {
                    isAlias: false,
                    aliasTarget: null,
                    aliasedBy: []
                };
            }

            const aliasInfo = {
                isAlias: false,
                aliasTarget: null,
                aliasedBy: []
            };

            try {
                // Check if this object is an alias (alias → target resolution)
                if (settings.aliasResolution === 'both' || settings.aliasResolution === 'target') {
                    if (aliasData.aliasMap.has(objectId)) {
                        const targetInfo = aliasData.aliasMap.get(objectId);
                        aliasInfo.isAlias = true;

                        try {
                            // For complex aliases, create a comprehensive target description
                            if (targetInfo.type === 'simple') {
                                // Simple alias - get the single target object
                                const targetObject = await connectionManager.getObject(settings.serverId, targetInfo.read);
                                if (targetObject) {
                                    // Enrich target object with enum assignments if enabled
                                    let enrichedTarget = targetObject;
                                    if (settings.includeEnums && enumData) {
                                        enrichedTarget = {
                                            ...targetObject,
                                            enumAssignments: getEnumAssignments(targetObject._id, enumData)
                                        };
                                    }
                                    
                                    aliasInfo.aliasTarget = {
                                        type: 'simple',
                                        target: enrichedTarget
                                    };
                                }
                            } else if (targetInfo.type === 'complex') {
                                // Complex alias - get both read and write targets if they exist
                                const targets = {};
                                
                                if (targetInfo.read) {
                                    try {
                                        const readTarget = await connectionManager.getObject(settings.serverId, targetInfo.read);
                                        if (readTarget) {
                                            // Enrich read target with enum assignments if enabled
                                            let enrichedReadTarget = readTarget;
                                            if (settings.includeEnums && enumData) {
                                                enrichedReadTarget = {
                                                    ...readTarget,
                                                    enumAssignments: getEnumAssignments(readTarget._id, enumData)
                                                };
                                            }
                                            targets.read = enrichedReadTarget;
                                        }
                                    } catch (readError) {
                                        node.warn(`Could not get read target ${targetInfo.read}: ${readError.message}`);
                                    }
                                }
                                
                                if (targetInfo.write && targetInfo.write !== targetInfo.read) {
                                    try {
                                        const writeTarget = await connectionManager.getObject(settings.serverId, targetInfo.write);
                                        if (writeTarget) {
                                            // Enrich write target with enum assignments if enabled
                                            let enrichedWriteTarget = writeTarget;
                                            if (settings.includeEnums && enumData) {
                                                enrichedWriteTarget = {
                                                    ...writeTarget,
                                                    enumAssignments: getEnumAssignments(writeTarget._id, enumData)
                                                };
                                            }
                                            targets.write = enrichedWriteTarget;
                                        }
                                    } catch (writeError) {
                                        node.warn(`Could not get write target ${targetInfo.write}: ${writeError.message}`);
                                    }
                                }
                                
                                aliasInfo.aliasTarget = {
                                    type: 'complex',
                                    readId: targetInfo.read,
                                    writeId: targetInfo.write,
                                    targets: targets
                                };
                            }
                        } catch (targetError) {
                            node.warn(`Error getting target objects for alias ${objectId}: ${targetError.message}`);
                        }
                    }
                }

                // Check if this object is aliased by others (target → alias resolution)
                if (settings.aliasResolution === 'both' || settings.aliasResolution === 'reverse') {
                    if (aliasData.reverseAliasMap.has(objectId)) {
                        const aliasObjects = aliasData.reverseAliasMap.get(objectId);
                        aliasInfo.aliasedBy = aliasObjects.map(aliasObj => {
                            let enrichedAliasObj = {
                                _id: aliasObj._id,
                                type: aliasObj.type,
                                common: aliasObj.common,
                                native: aliasObj.native
                            };
                            
                            // Enrich alias objects with enum assignments if enabled
                            if (settings.includeEnums && enumData) {
                                enrichedAliasObj.enumAssignments = getEnumAssignments(aliasObj._id, enumData);
                            }
                            
                            return enrichedAliasObj;
                        });
                    }
                }

            } catch (error) {
                node.warn(`Error getting alias info for ${objectId}: ${error.message}`);
            }

            return aliasInfo;
        }

        async function enrichObjectsWithAliases(objects, aliasData, enumData = null) {
            if (!settings.includeAliases || !aliasData) {
                return objects;
            }

            if (Array.isArray(objects)) {
                const enrichedObjects = [];
                for (const obj of objects) {
                    if (obj && obj._id) {
                        const aliasInfo = await getAliasInfo(obj._id, aliasData, enumData);
                        enrichedObjects.push({
                            ...obj,
                            aliasInfo
                        });
                        
                        // Reduced delay since we're not doing state queries anymore
                        if (enrichedObjects.length % 10 === 0) {
                            await new Promise(resolve => setTimeout(resolve, 5));
                        }
                    } else {
                        enrichedObjects.push(obj);
                    }
                }
                return enrichedObjects;
            } else if (objects && typeof objects === 'object' && objects._id) {
                const aliasInfo = await getAliasInfo(objects._id, aliasData, enumData);
                return {
                    ...objects,
                    aliasInfo
                };
            }

            return objects;
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

        function formatOutput(objects, objectIdOrPattern, outputMode, appliedObjectType, enumData = null, aliasData = null) {
            const baseResult = {
                [settings.outputProperty]: null,
                objects: null,
                count: 0,
                timestamp: Date.now(),
                // Conditional properties - only add if relevant
                ...(appliedObjectType && { appliedFilter: appliedObjectType }),
                ...(objectIdOrPattern.includes('*') && { pattern: objectIdOrPattern }),
                ...(settings.includeEnums && { includesEnums: true }),
                ...(settings.includeAliases && { includesAliases: true })
            };

            if (!objects) {
                return baseResult;
            }

            if (!Array.isArray(objects) && typeof objects === 'object') {
                const result = {
                    ...baseResult,
                    [settings.outputProperty]: objects,
                    objects: objects,
                    count: 1
                };

                return result;
            }

            const objectArray = Array.isArray(objects) ? objects : Object.values(objects);
            const objectMap = {};
            
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
                    outputData = objectArray.length > 0 ? objectArray[0] : null;
                    break;
                default:
                    outputData = objectArray;
            }

            const result = {
                ...baseResult,
                [settings.outputProperty]: outputData,
                objects: objectMap,
                count: objectArray.length
            };

            // Add enum statistics if enabled and data available
            if (settings.includeEnums && enumData && objectArray.length > 0) {
                const enumStats = {
                    objectsWithRooms: 0,
                    objectsWithFunctions: 0,
                    objectsWithAnyEnum: 0,
                    totalEnumAssignments: 0
                };

                objectArray.forEach(obj => {
                    if (obj && obj.enumAssignments) {
                        if (obj.enumAssignments.hasRoom) enumStats.objectsWithRooms++;
                        if (obj.enumAssignments.hasFunction) enumStats.objectsWithFunctions++;
                        if (obj.enumAssignments.totalEnums > 0) enumStats.objectsWithAnyEnum++;
                        enumStats.totalEnumAssignments += obj.enumAssignments.totalEnums;
                    }
                });

                if (enumStats.totalEnumAssignments > 0) {
                    result.enumStatistics = enumStats;
                }
            }

            // Add alias statistics if enabled and data available
            if (settings.includeAliases && aliasData && objectArray.length > 0) {
                const aliasStats = {
                    objectsWithAliases: 0,
                    aliasObjects: 0,
                    targetObjects: 0,
                    totalAliasRelationships: 0
                };

                objectArray.forEach(obj => {
                    if (obj && obj.aliasInfo) {
                        if (obj.aliasInfo.isAlias) {
                            aliasStats.aliasObjects++;
                        }
                        if (obj.aliasInfo.aliasedBy && obj.aliasInfo.aliasedBy.length > 0) {
                            aliasStats.targetObjects++;
                            aliasStats.totalAliasRelationships += obj.aliasInfo.aliasedBy.length;
                        }
                        if (obj.aliasInfo.isAlias || (obj.aliasInfo.aliasedBy && obj.aliasInfo.aliasedBy.length > 0)) {
                            aliasStats.objectsWithAliases++;
                        }
                    }
                });

                if (aliasStats.totalAliasRelationships > 0 || aliasStats.aliasObjects > 0) {
                    result.aliasStatistics = aliasStats;
                }
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
                        const aliasText = settings.includeAliases ? " +aliases" : "";
                        setStatus("green", "dot", readyText + enumText + aliasText);
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
                const aliasText = settings.includeAliases ? " +aliases" : "";
                setStatus("green", "dot", reconnectedText + enumText + aliasText);
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

                const eventCallback = createEventCallback();
                await connectionManager.registerForEvents(
                    settings.nodeId,
                    settings.serverId,
                    eventCallback,
                    globalConfig
                );
                
                const status = connectionManager.getConnectionStatus(settings.serverId);
                if (status.ready) {
                    const readyText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                    const enumText = settings.includeEnums ? " +enums" : "";
                    const aliasText = settings.includeAliases ? " +aliases" : "";
                    setStatus("green", "dot", readyText + enumText + aliasText);
                    node.isInitialized = true;
                    node.log(`Connection established for get object node (wildcard: ${isWildcardPattern}, type filter: ${settings.objectType || 'none'}, enums: ${settings.includeEnums}, aliases: ${settings.includeAliases})`);
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

                // Load alias data if needed
                let aliasData = null;
                if (settings.includeAliases) {
                    setStatus("blue", "dot", `Loading aliases...`);
                    aliasData = await loadAliasData();
                    if (!aliasData) {
                        node.warn(`Failed to load alias data - continuing without alias information`);
                    }
                }

                if (isCurrentWildcard) {
                    const features = [];
                    if (settings.includeEnums) features.push("+enums");
                    if (settings.includeAliases) features.push("+aliases");
                    const statusText = `Reading objects ${objectIdOrPattern} ${features.join(" ")}...`;
                    setStatus("blue", "dot", statusText);
                    
                    try {
                        let objects = await connectionManager.getObjects(settings.serverId, objectIdOrPattern, currentObjectType);
                        
                        if (!objects || (Array.isArray(objects) && objects.length === 0) || 
                            (typeof objects === 'object' && Object.keys(objects).length === 0)) {
                            setStatus("yellow", "ring", "No objects found");
                            const typeInfo = currentObjectType ? ` (type: ${currentObjectType})` : '';
                            node.warn(`No objects found for pattern: ${objectIdOrPattern}${typeInfo}`);
                            
                            const result = formatOutput(currentOutputMode === 'array' ? [] : {}, objectIdOrPattern, currentOutputMode, currentObjectType, enumData, aliasData);
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Enrich with enum assignments
                        objects = await enrichObjectsWithEnums(objects, enumData);
                        
                        // Enrich with alias information (including enum data for target objects)
                        objects = await enrichObjectsWithAliases(objects, aliasData, enumData);
                        
                        const result = formatOutput(objects, objectIdOrPattern, currentOutputMode, currentObjectType, enumData, aliasData);
                        Object.assign(msg, result);
                        
                        const readyText = isWildcardPattern ? "Ready (Pattern)" : "Ready";
                        const enumText = settings.includeEnums ? " +enums" : "";
                        const aliasText = settings.includeAliases ? " +aliases" : "";
                        setStatus("green", "dot", readyText + enumText + aliasText);
                        
                        const typeInfo = currentObjectType ? ` (filtered by type: ${currentObjectType})` : '';
                        const enumInfo = settings.includeEnums ? ` with enum assignments` : '';
                        const aliasInfo = settings.includeAliases ? ` with alias information` : '';
                        node.log(`Successfully retrieved ${result.count} objects for pattern: ${objectIdOrPattern} (mode: ${currentOutputMode})${typeInfo}${enumInfo}${aliasInfo}`);
                        
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Pattern error");
                        node.error(`Error retrieving objects for pattern ${objectIdOrPattern}: ${error.message}`);
                        
                        const result = formatOutput(null, objectIdOrPattern, currentOutputMode, currentObjectType, enumData, aliasData);
                        result.error = error.message;
                        result.errorType = error.message.includes('timeout') ? 'timeout' : 'unknown';
                        Object.assign(msg, result);
                        
                        send(msg);
                        done && done(error);
                    }
                } else {
                    // Single object retrieval
                    const features = [];
                    if (settings.includeEnums) features.push("+enums");
                    if (settings.includeAliases) features.push("+aliases");
                    const statusText = `Reading object ${objectIdOrPattern} ${features.join(" ")}...`;
                    setStatus("blue", "dot", statusText);

                    try {
                        let objectData = await connectionManager.getObject(settings.serverId, objectIdOrPattern);
                        
                        if (objectData && currentObjectType && objectData.type !== currentObjectType) {
                            objectData = null;
                        }
                        
                        if (!objectData) {
                            const typeInfo = currentObjectType ? ` (type filter: ${currentObjectType})` : '';
                            setStatus("yellow", "ring", "Object not found");
                            node.warn(`Object not found: ${objectIdOrPattern}${typeInfo}`);
                            
                            const result = formatOutput(null, objectIdOrPattern, 'single', currentObjectType, enumData, aliasData);
                            result.error = currentObjectType ? "Object not found or type mismatch" : "Object not found";
                            Object.assign(msg, result);
                            
                            send(msg);
                            done && done();
                            return;
                        }
                        
                        // Enrich with enum assignments
                        objectData = await enrichObjectsWithEnums(objectData, enumData);
                        
                        // Enrich with alias information (including enum data for target objects)
                        objectData = await enrichObjectsWithAliases(objectData, aliasData, enumData);
                        
                        const result = formatOutput(objectData, objectIdOrPattern, 'single', currentObjectType, enumData, aliasData);
                        Object.assign(msg, result);
                        
                        const enumText = settings.includeEnums ? " +enums" : "";
                        const aliasText = settings.includeAliases ? " +aliases" : "";
                        setStatus("green", "dot", "Ready" + enumText + aliasText);
                        
                        const typeInfo = currentObjectType ? ` (type filter: ${currentObjectType})` : '';
                        const enumInfo = settings.includeEnums ? ` with enum assignments` : '';
                        const aliasInfo = settings.includeAliases ? ` with alias information` : '';
                        node.log(`Successfully retrieved object: ${objectIdOrPattern}${typeInfo}${enumInfo}${aliasInfo}`);
                        
                        send(msg);
                        done && done();
                        
                    } catch (error) {
                        setStatus("red", "ring", "Error");
                        node.error(`Error processing input: ${error.message}`);
                        
                        const result = formatOutput(null, objectIdOrPattern, 'single', currentObjectType, enumData, aliasData);
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