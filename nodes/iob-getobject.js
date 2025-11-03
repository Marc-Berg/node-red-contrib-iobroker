const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobgetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

        const configObjectId = config.objectId?.trim() || "";
        const isWildcardPattern = configObjectId.includes('*');

        const settings = {
            outputProperty: config.outputProperty?.trim() || "payload",
            outputMode: config.outputMode || (isWildcardPattern ? "array" : "single"),
            objectType: config.objectType?.trim() || "",
            useWildcard: isWildcardPattern,
            includeEnums: config.includeEnums || false,
            enumTypes: config.enumTypes || "all",
            includeAliases: config.includeAliases || false,
            aliasResolution: config.aliasResolution || "both",
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
        node.isInitialized = false;

        const createStatusText = (baseText) => {
            const enumText = settings.includeEnums ? " +enums" : "";
            const aliasText = settings.includeAliases ? " +aliases" : "";
            return baseText + enumText + aliasText;
        };

        const statusTexts = {
            ready: createStatusText(isWildcardPattern ? "Ready (Pattern mode)" : "Ready"),
            reconnected: createStatusText(isWildcardPattern ? "Reconnected (Pattern)" : "Reconnected")
        };

        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );
        
        async function loadAllDataOptimized(objectIdOrPattern, currentObjectType) {
            try {
                const queries = [];
                
                // Use getObjectView only for exact matches (performance optimization)
                // For wildcard patterns, always use getObjects to ensure proper pattern filtering
                if (currentObjectType && objectIdOrPattern !== '*' && !objectIdOrPattern.includes('*')) {
                    const viewParams = { key: objectIdOrPattern };
                    
                    queries.push({
                        name: 'objects',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', currentObjectType, viewParams)
                    });
                } else {
                    // Use getObjects for wildcard patterns or when no type filter is set
                    queries.push({
                        name: 'objects',
                        promise: connectionManager.getObjects(settings.serverId, objectIdOrPattern, currentObjectType)
                    });
                }
                
                if (settings.includeEnums) {
                    queries.push({
                        name: 'enums',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', 'enum', {})
                    });
                }
                
                if (settings.includeAliases) {
                    queries.push({
                        name: 'aliases',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', 'state', {
                            startkey: 'alias.',
                            endkey: 'alias.\uffff'
                        })
                    });
                }
                
                const results = await Promise.all(queries.map(q => q.promise));
                
                const dataMap = {};
                queries.forEach((query, index) => {
                    dataMap[query.name] = results[index];
                });
                
                return dataMap;
                
            } catch (error) {
                node.error(`loadAllDataOptimized failed: ${error.message}`);
                throw error;
            }
        }

        function processEnumData(enumResult) {
            const enumMemberMap = new Map();
            
            if (!enumResult || !enumResult.rows) {
                return { enumMemberMap, totalEnums: 0 };
            }
            
            const allEnums = [];
            
            for (const row of enumResult.rows) {
                if (row.value && row.value.type === 'enum') {
                    allEnums.push({
                        _id: row.id,
                        ...row.value
                    });
                }
            }
            
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

                enumObj.common.members.forEach(memberId => {
                    if (!enumMemberMap.has(memberId)) {
                        enumMemberMap.set(memberId, []);
                    }
                    enumMemberMap.get(memberId).push(enumData);
                });
            });

            return {
                enumMemberMap,
                totalEnums: allEnums.length
            };
        }

        function processAliasData(aliasResult) {
            const aliasMap = new Map();
            const reverseAliasMap = new Map();
            const aliasObjects = new Map();
            
            if (!aliasResult || !aliasResult.rows) {
                return { aliasMap, reverseAliasMap, aliasObjects, totalAliases: 0 };
            }
            
            for (const row of aliasResult.rows) {
                if (row.id.startsWith('alias.') && row.value && row.value.common && row.value.common.alias && row.value.common.alias.id) {
                    const aliasObj = {
                        _id: row.id,
                        ...row.value
                    };
                    
                    const aliasId = aliasObj._id;
                    const aliasConfig = aliasObj.common.alias.id;
                    
                    let targetInfo;
                    if (typeof aliasConfig === 'string') {
                        targetInfo = {
                            type: 'simple',
                            read: aliasConfig,
                            write: aliasConfig,
                            targets: [aliasConfig]
                        };
                    } else if (typeof aliasConfig === 'object' && aliasConfig !== null) {
                        const readId = aliasConfig.read || null;
                        const writeId = aliasConfig.write || null;
                        
                        targetInfo = {
                            type: 'complex',
                            read: readId,
                            write: writeId,
                            targets: [readId, writeId].filter(id => id && typeof id === 'string')
                        };
                    } else {
                        node.warn(`Invalid alias configuration for ${aliasId}: ${JSON.stringify(aliasConfig)}`);
                        continue;
                    }
                    
                    aliasMap.set(aliasId, targetInfo);
                    aliasObjects.set(aliasId, aliasObj);
                    
                    targetInfo.targets.forEach(targetId => {
                        if (!reverseAliasMap.has(targetId)) {
                            reverseAliasMap.set(targetId, []);
                        }
                        reverseAliasMap.get(targetId).push(aliasObj);
                    });
                }
            }

            return {
                aliasMap,
                reverseAliasMap,
                aliasObjects,
                totalAliases: aliasMap.size
            };
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

        async function loadAliasTargetObjects(objects, aliasData) {
            if (!aliasData || !Array.isArray(objects)) {
                return new Map();
            }

            const targetIdsNeeded = new Set();
            const existingObjectsMap = new Map();
            
            objects.forEach(obj => {
                if (obj && obj._id) {
                    existingObjectsMap.set(obj._id, obj);
                }
            });

            for (const obj of objects) {
                if (!obj || !obj._id) continue;

                if (settings.aliasResolution === 'both' || settings.aliasResolution === 'target') {
                    if (aliasData.aliasMap.has(obj._id)) {
                        const targetInfo = aliasData.aliasMap.get(obj._id);
                        targetInfo.targets.forEach(targetId => {
                            if (targetId && !existingObjectsMap.has(targetId)) {
                                targetIdsNeeded.add(targetId);
                            }
                        });
                    }
                }

                if (settings.aliasResolution === 'both' || settings.aliasResolution === 'reverse') {
                    // Note: Reverse aliases are already present in the original objects list
                    // No additional loading needed for reverse lookup
                }
            }

            const targetObjectsMap = new Map();
            
            existingObjectsMap.forEach((obj, id) => {
                targetObjectsMap.set(id, obj);
            });

            if (targetIdsNeeded.size > 0) {
                const batchSize = 20;
                const targetIdArray = Array.from(targetIdsNeeded);
                
                for (let i = 0; i < targetIdArray.length; i += batchSize) {
                    const batch = targetIdArray.slice(i, i + batchSize);
                    
                    const batchPromises = batch.map(async (targetId) => {
                        try {
                            const targetObj = await connectionManager.getObject(settings.serverId, targetId);
                            if (targetObj) {
                                return { id: targetId, object: targetObj };
                            }
                        } catch (error) {
                            node.warn(`Could not load target object ${targetId}: ${error.message}`);
                        }
                        return null;
                    });

                    const batchResults = await Promise.all(batchPromises);
                    
                    batchResults.forEach(result => {
                        if (result) {
                            targetObjectsMap.set(result.id, result.object);
                        }
                    });

                    if (i + batchSize < targetIdArray.length) {
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
            }

            return targetObjectsMap;
        }

        function getAliasInfoOptimized(objectId, aliasData, targetObjectsMap, enumData = null) {
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
                if (settings.aliasResolution === 'both' || settings.aliasResolution === 'target') {
                    if (aliasData.aliasMap.has(objectId)) {
                        const targetInfo = aliasData.aliasMap.get(objectId);
                        aliasInfo.isAlias = true;

                        if (targetInfo.type === 'simple') {
                            const targetObject = targetObjectsMap.get(targetInfo.read);
                            if (targetObject) {
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
                            const targets = {};
                            
                            if (targetInfo.read) {
                                const readTarget = targetObjectsMap.get(targetInfo.read);
                                if (readTarget) {
                                    let enrichedReadTarget = readTarget;
                                    if (settings.includeEnums && enumData) {
                                        enrichedReadTarget = {
                                            ...readTarget,
                                            enumAssignments: getEnumAssignments(readTarget._id, enumData)
                                        };
                                    }
                                    targets.read = enrichedReadTarget;
                                }
                            }
                            
                            if (targetInfo.write && targetInfo.write !== targetInfo.read) {
                                const writeTarget = targetObjectsMap.get(targetInfo.write);
                                if (writeTarget) {
                                    let enrichedWriteTarget = writeTarget;
                                    if (settings.includeEnums && enumData) {
                                        enrichedWriteTarget = {
                                            ...writeTarget,
                                            enumAssignments: getEnumAssignments(writeTarget._id, enumData)
                                        };
                                    }
                                    targets.write = enrichedWriteTarget;
                                }
                            }
                            
                            aliasInfo.aliasTarget = {
                                type: 'complex',
                                readId: targetInfo.read,
                                writeId: targetInfo.write,
                                targets: targets
                            };
                        }
                    }
                }

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

        async function enrichObjectsWithAliasesOptimized(objects, aliasData, enumData = null) {
            if (!settings.includeAliases || !aliasData) {
                return objects;
            }

            if (Array.isArray(objects)) {
                const targetObjectsMap = await loadAliasTargetObjects(objects, aliasData);
                
                const enrichedObjects = objects.map(obj => {
                    if (obj && obj._id) {
                        const aliasInfo = getAliasInfoOptimized(obj._id, aliasData, targetObjectsMap, enumData);
                        return {
                            ...obj,
                            aliasInfo
                        };
                    }
                    return obj;
                });

                return enrichedObjects;
                
            } else if (objects && typeof objects === 'object' && objects._id) {
                const singleObjectArray = [objects];
                const targetObjectsMap = await loadAliasTargetObjects(singleObjectArray, aliasData);
                const aliasInfo = getAliasInfoOptimized(objects._id, aliasData, targetObjectsMap, enumData);
                
                return {
                    ...objects,
                    aliasInfo
                };
            }

            return objects;
        }

        function enrichObjectsWithEnums(objects, enumData) {
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

        function processObjectViewResult(objectResult, objectType) {
            if (!objectResult) {
                return [];
            }
            
            if (objectResult.rows) {
                const objects = [];
                for (const row of objectResult.rows) {
                    if (row.value && row.value.type === objectType) {
                        objects.push({
                            _id: row.id,
                            ...row.value
                        });
                    }
                }
                return objects;
            } else if (Array.isArray(objectResult)) {
                return objectResult;
            }
            
            return [];
        }

        function formatOutput(objects, objectIdOrPattern, outputMode, appliedObjectType, enumData = null, aliasData = null) {
            const baseResult = {
                objects: null,
                count: 0,
                timestamp: Date.now(),
                ...(appliedObjectType && { appliedFilter: appliedObjectType }),
                ...(objectIdOrPattern.includes('*') && { pattern: objectIdOrPattern }),
                ...(settings.includeEnums && { includesEnums: true }),
                ...(settings.includeAliases && { includesAliases: true })
            };

            if (!objects) {
                const res = { ...baseResult };
                NodeHelpers.setMessageProperty(RED, res, settings.outputProperty, null);
                return res;
            }

            if (!Array.isArray(objects) && typeof objects === 'object') {
                // Check if the object is empty (no properties with valid IDs)
                const hasValidProperties = objects._id || Object.keys(objects).length > 0;
                const res = {
                    ...baseResult,
                    objects: objects,
                    count: hasValidProperties ? 1 : 0
                };
                NodeHelpers.setMessageProperty(RED, res, settings.outputProperty, objects);
                return res;
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
                objects: objectMap,
                count: objectArray.length
            };
            NodeHelpers.setMessageProperty(RED, result, settings.outputProperty, outputData);

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

        node.on('input', async function(msg, send, done) {
            try {
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const objectIdOrPattern = configObjectId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!NodeHelpers.validateRequiredInput(objectIdOrPattern, "Object ID", setStatus, done)) {
                    return;
                }

                const currentOutputMode = msg.outputMode || settings.outputMode;
                const currentObjectType = msg.objectType || settings.objectType;
                
                const features = [];
                if (settings.includeEnums) features.push("+enums");
                if (settings.includeAliases) features.push("+aliases");
                const statusText = `Loading objects ${objectIdOrPattern} ${features.join(" ")}...`;
                setStatus("blue", "dot", statusText);
                
                try {
                    const dataMap = await loadAllDataOptimized(objectIdOrPattern, currentObjectType);
                    
                    let objects = dataMap.objects;
                    let enumData = null;
                    let aliasData = null;
                    
                    if (currentObjectType && dataMap.objects && dataMap.objects.rows) {
                        objects = processObjectViewResult(dataMap.objects, currentObjectType);
                    }
                    
                    if (settings.includeEnums && dataMap.enums) {
                        enumData = processEnumData(dataMap.enums);
                    }
                    
                    if (settings.includeAliases && dataMap.aliases) {
                        aliasData = processAliasData(dataMap.aliases);
                    }
                    
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
                    
                    objects = enrichObjectsWithEnums(objects, enumData);
                    objects = await enrichObjectsWithAliasesOptimized(objects, aliasData, enumData);
                    
                    const result = formatOutput(objects, objectIdOrPattern, currentOutputMode, currentObjectType, enumData, aliasData);
                    Object.assign(msg, result);
                    
                    setStatus("green", "dot", statusTexts.ready);
                    send(msg);
                    done && done();
                    
                } catch (error) {
                    setStatus("red", "ring", "Error");
                    node.error(`Error retrieving objects for pattern ${objectIdOrPattern}: ${error.message}`);
                    
                    const result = formatOutput(null, objectIdOrPattern, currentOutputMode, currentObjectType, null, null);
                    result.error = error.message;
                    result.errorType = error.message.includes('timeout') ? 'timeout' : 'unknown';
                    Object.assign(msg, result);
                    
                    send(msg);
                    done && done(error);
                }
                
            } catch (error) {
                setStatus("red", "ring", "Error");
                node.error(`Error processing input: ${error.message}`);
                done && done(error);
            }
        });

        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "Get object");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobgetobject", iobgetobject);
};