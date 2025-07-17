const Orchestrator = require('../lib/orchestrator');
const { StatusHelpers } = require('../lib/utils/status-helpers');

module.exports = function(RED) {
    function iobgetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get the server configuration
        node.server = RED.nodes.getNode(config.server);
        if (!node.server) {
            StatusHelpers.updateConnectionStatus(node, 'error', "Error: Server not configured");
            return;
        }

        // Configuration
        const configObjectId = config.objectId?.trim() || "";
        const isWildcardPattern = configObjectId.includes('*');
        
        node.outputProperty = config.outputProperty?.trim() || "payload";
        node.outputMode = config.outputMode || (isWildcardPattern ? "array" : "single");
        node.objectType = config.objectType?.trim() || "";
        node.useWildcard = isWildcardPattern;
        node.includeEnums = config.includeEnums || false;
        node.enumTypes = config.enumTypes || "all";
        node.includeAliases = config.includeAliases || false;
        node.aliasResolution = config.aliasResolution || "both";

        // Track if the node has been registered with the orchestrator
        node.isRegistered = false;
        
        // Store for enum and alias data
        node.enumData = null;
        node.aliasData = null;

        // Helper function to create status text
        function createStatusText(baseText) {
            const enumText = node.includeEnums ? " +enums" : "";
            const aliasText = node.includeAliases ? " +aliases" : "";
            return baseText + enumText + aliasText;
        }

        // Helper function to format output (compatible with version 0.14.0)
        function formatOutput(objects, objectIdOrPattern, outputMode, appliedObjectType, enumData = null, aliasData = null) {
            const baseResult = {
                [node.outputProperty]: null,
                objects: null,
                count: 0,
                timestamp: Date.now(),
                ...(appliedObjectType && { appliedFilter: appliedObjectType }),
                ...(objectIdOrPattern.includes('*') && { pattern: objectIdOrPattern }),
                ...(node.includeEnums && { includesEnums: true }),
                ...(node.includeAliases && { includesAliases: true })
            };

            if (!objects) {
                return baseResult;
            }

            if (!Array.isArray(objects) && typeof objects === 'object') {
                const result = {
                    ...baseResult,
                    [node.outputProperty]: objects,
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
                [node.outputProperty]: outputData,
                objects: objectMap,
                count: objectArray.length
            };

            // Generate enum statistics if enums are included
            if (node.includeEnums && enumData && objectArray.length > 0) {
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

                // Always add enum statistics when enums are enabled, even if zero
                result.enumStatistics = enumStats;
            }

            // Generate alias statistics if aliases are included
            if (node.includeAliases && aliasData && objectArray.length > 0) {
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

                // Always add alias statistics when aliases are enabled, even if zero
                result.aliasStatistics = aliasStats;
            }

            return result;
        }

        // Helper function to get enum assignments for an object
        function getEnumAssignments(objectId, enumData) {
            if (!enumData || !enumData.enumMemberMap || !enumData.enumMemberMap.has(objectId)) {
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

            const includeRooms = node.enumTypes === 'all' || (Array.isArray(node.enumTypes) && node.enumTypes.includes('rooms'));
            const includeFunctions = node.enumTypes === 'all' || (Array.isArray(node.enumTypes) && node.enumTypes.includes('functions'));
            const includeOther = node.enumTypes === 'all';

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

        // Helper function to enrich objects with enum assignments
        function enrichObjectsWithEnums(objects, enumData) {
            if (!node.includeEnums || !enumData) {
                return objects;
            }

            if (Array.isArray(objects)) {
                return objects.map(obj => {
                    if (obj && obj._id) {
                        const enriched = { ...obj };
                        enriched.enumAssignments = getEnumAssignments(obj._id, enumData);
                        return enriched;
                    }
                    return obj;
                });
            } else if (objects && typeof objects === 'object' && objects._id) {
                const enriched = { ...objects };
                enriched.enumAssignments = getEnumAssignments(objects._id, enumData);
                return enriched;
            }

            return objects;
        }

        // Helper function to get alias information for an object
        function getAliasInfo(objectId, aliasData) {
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
                // Check if this object is an alias
                if (node.aliasResolution === 'both' || node.aliasResolution === 'target') {
                    if (aliasData.aliasMap && aliasData.aliasMap.has(objectId)) {
                        const targetInfo = aliasData.aliasMap.get(objectId);
                        aliasInfo.isAlias = true;
                        aliasInfo.aliasTarget = targetInfo.id;
                    }
                }

                // Check if this object is aliased by other objects
                if (node.aliasResolution === 'both' || node.aliasResolution === 'reverse') {
                    if (aliasData.reverseAliasMap && aliasData.reverseAliasMap.has(objectId)) {
                        const aliasObjects = aliasData.reverseAliasMap.get(objectId);
                        aliasInfo.aliasedBy = aliasObjects || [];
                    }
                }
            } catch (error) {
                node.warn(`Error getting alias info for ${objectId}: ${error.message}`);
            }

            return aliasInfo;
        }

        // Helper function to enrich objects with alias information
        function enrichObjectsWithAliases(objects, aliasData) {
            if (!node.includeAliases || !aliasData) {
                return objects;
            }

            if (Array.isArray(objects)) {
                return objects.map((obj) => {
                    if (obj && obj._id) {
                        const enriched = { ...obj };
                        enriched.aliasInfo = getAliasInfo(obj._id, aliasData);
                        return enriched;
                    }
                    return obj;
                });
            } else if (objects && typeof objects === 'object' && objects._id) {
                const enriched = { ...objects };
                enriched.aliasInfo = getAliasInfo(objects._id, aliasData);
                return enriched;
            }
            return objects;
        }

        // Process enum data into the format expected by the enrich functions
        function processEnumData(enumResult) {
            const enumsByType = {
                rooms: [],
                functions: [],
                other: []
            };
            const enumMemberMap = new Map();
            
            if (!enumResult || !enumResult.rows) {
                return { enumsByType, enumMemberMap, totalEnums: 0 };
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

            return {
                enumsByType,
                enumMemberMap,
                totalEnums: allEnums.length
            };
        }

        // Process alias data into the format expected by the enrich functions
        function processAliasData(aliasResult) {
            const aliasMap = new Map();
            const reverseAliasMap = new Map();
            const aliasObjects = new Map();
            
            // Handle both possible formats: object map and rows array
            let aliasEntries = [];
            if (aliasResult && aliasResult.rows && Array.isArray(aliasResult.rows)) {
                // Format 1: rows array (like enums)
                aliasEntries = aliasResult.rows.map(row => ({
                    id: row.id,
                    value: row.value
                }));
            } else if (aliasResult && typeof aliasResult === 'object') {
                // Format 2: direct object map
                aliasEntries = Object.entries(aliasResult).map(([id, value]) => ({
                    id,
                    value
                }));
            } else {
                return { aliasMap, reverseAliasMap, aliasObjects, totalAliases: 0 };
            }
            
            for (const entry of aliasEntries) {
                if (entry.id.startsWith('alias.') && entry.value && entry.value.common && entry.value.common.alias && entry.value.common.alias.id) {
                    const aliasObj = {
                        _id: entry.id,
                        ...entry.value
                    };
                    
                    const aliasId = aliasObj._id;
                    const aliasConfig = aliasObj.common.alias;
                    
                    // Extract target ID and other properties
                    let targetId = aliasConfig.id;
                    const readExpression = aliasConfig.read;
                    const writeExpression = aliasConfig.write;
                    
                    // Handle complex alias configurations where id is an object
                    if (typeof targetId === 'object' && targetId !== null) {
                        // Use read target as primary, fall back to write target
                        const readTarget = targetId.read;
                        const writeTarget = targetId.write;
                        
                        // Process both read and write targets
                        const targets = [readTarget, writeTarget].filter(target => target && typeof target === 'string');
                        
                        if (targets.length > 0) {
                            targets.forEach(target => {
                                const targetInfo = {
                                    id: target,
                                    read: readExpression,
                                    write: writeExpression,
                                    alias: aliasObj,
                                    type: 'complex'
                                };
                                
                                aliasMap.set(aliasId, targetInfo);
                                aliasObjects.set(aliasId, aliasObj);
                                
                                // Add to reverse mapping
                                if (!reverseAliasMap.has(target)) {
                                    reverseAliasMap.set(target, []);
                                }
                                reverseAliasMap.get(target).push(aliasObj);
                            });
                        }
                    } else if (typeof targetId === 'string') {
                        // Simple alias configuration
                        const targetInfo = {
                            id: targetId,
                            read: readExpression,
                            write: writeExpression,
                            alias: aliasObj,
                            type: 'simple'
                        };
                        
                        aliasMap.set(aliasId, targetInfo);
                        aliasObjects.set(aliasId, aliasObj);
                        
                        // Add to reverse mapping
                        if (!reverseAliasMap.has(targetId)) {
                            reverseAliasMap.set(targetId, []);
                        }
                        reverseAliasMap.get(targetId).push(aliasObj);
                    }
                }
            }

            return {
                aliasMap,
                reverseAliasMap,
                aliasObjects,
                totalAliases: aliasMap.size
            };
        }

        // Helper function to process object results from ioBroker
        function processObjectResult(objects, objectIdOrPattern) {
            if (!objects) {
                return null;
            }
            // Wildcard: objects as object map
            if (objectIdOrPattern.includes('*') && objects && typeof objects === 'object' && !Array.isArray(objects)) {
                // Convert object map to array - include ALL object types (state, folder, channel, device, etc.)
                return Object.entries(objects).map(([id, obj]) => {
                    if (obj && typeof obj === 'object') {
                        // Ensure _id is set
                        return {
                            _id: id,
                            ...obj
                        };
                    }
                    return obj;
                }).filter(obj => obj !== null && obj !== undefined);
            }
            // Single object
            if (!Array.isArray(objects) && typeof objects === 'object') {
                if (!objects._id && objectIdOrPattern && !objectIdOrPattern.includes('*')) {
                    return {
                        _id: objectIdOrPattern,
                        ...objects
                    };
                }
                return objects;
            }
            // Array results
            if (Array.isArray(objects)) {
                return objects.map(obj => {
                    if (obj && typeof obj === 'object' && !obj._id) {
                        // Try to infer _id from object structure
                        const possibleId = obj.id || obj.objectId || obj.key;
                        if (possibleId) {
                            return {
                                _id: possibleId,
                                ...obj
                            };
                        }
                    }
                    return obj;
                }).filter(obj => obj !== null && obj !== undefined);
            }
            return objects;
        }

        // Helper function to validate input
        function validateInput(msg) {
            // Check if we have a valid object ID from either config or message
            const objectIdFromMsg = msg.payload && typeof msg.payload === 'string' ? msg.payload.trim() : '';
            const objectIdFromTopic = msg.topic && typeof msg.topic === 'string' ? msg.topic.trim() : '';
            
            const objectIdOrPattern = objectIdFromMsg || objectIdFromTopic || configObjectId;
            
            if (!objectIdOrPattern) {
                throw new Error('No object ID or pattern provided');
            }
            
            // Extract parameters from message
            const currentOutputMode = msg.outputMode || node.outputMode;
            const currentObjectType = msg.objectType || node.objectType;
            
            return {
                objectIdOrPattern,
                currentOutputMode,
                currentObjectType
            };
        }

        // --- Event Handlers ---

        const onServerReady = ({ serverId }) => {
            if (serverId === node.server.id) {
                const statusText = createStatusText(node.useWildcard ? "Ready (Pattern mode)" : "Ready");
                StatusHelpers.updateConnectionStatus(node, 'ready', statusText);
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
                StatusHelpers.updateConnectionStatus(node, 'error', `Connection failed: ${error}`);
            }
        };

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
        Orchestrator.on('connection:disconnected', onDisconnected);
        Orchestrator.on('connection:retrying', onRetrying);
        Orchestrator.on('connection:failed_permanently', onPermanentFailure);

        // Input handler
        node.on('input', async function(msg, send, done) {
            try {
                // Validate input
                const { objectIdOrPattern, currentOutputMode, currentObjectType } = validateInput(msg);
                
                node.log(`Requesting object(s) for pattern: ${objectIdOrPattern} (mode: ${currentOutputMode}, type: ${currentObjectType})`);
                
                // Update status
                StatusHelpers.updateConnectionStatus(node, 'requesting', 'Requesting objects...');
                
                // Clear previous results
                node.enumData = null;
                node.aliasData = null;
                
                // Start all requests in parallel
                const promises = [];
                
                // Request the object(s)
                promises.push(new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Object request timeout'));
                    }, 10000);
                    
                    const handler = (data) => {
                        if (data.serverId === node.server.id && data.nodeId === node.id) {
                            clearTimeout(timeout);
                            Orchestrator.removeListener(`object:get_result:${node.id}`, handler);
                            resolve(data);
                        }
                    };
                    
                    Orchestrator.on(`object:get_result:${node.id}`, handler);
                    Orchestrator.getObject(node.id, objectIdOrPattern);
                }));
                
                // Request enums if needed
                if (node.includeEnums) {
                    promises.push(new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Enums request timeout'));
                        }, 10000);
                        
                        const handler = (data) => {
                            if (data.serverId === node.server.id && data.nodeId === node.id) {
                                clearTimeout(timeout);
                                Orchestrator.removeListener(`enums:get_result:${node.id}`, handler);
                                resolve(data);
                            }
                        };
                        
                        Orchestrator.on(`enums:get_result:${node.id}`, handler);
                        Orchestrator.getEnums(node.id);
                    }));
                }
                
                // Request aliases if needed
                if (node.includeAliases) {
                    promises.push(new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Aliases request timeout'));
                        }, 10000);
                        
                        const handler = (data) => {
                            if (data.serverId === node.server.id && data.nodeId === node.id) {
                                clearTimeout(timeout);
                                Orchestrator.removeListener(`aliases:get_result:${node.id}`, handler);
                                resolve(data);
                            }
                        };
                        
                        Orchestrator.on(`aliases:get_result:${node.id}`, handler);
                        Orchestrator.getAliases(node.id);
                    }));
                }
                
                // Wait for all requests to complete
                node.log(`[DEBUG] Waiting for ${promises.length} requests to complete...`);
                const results = await Promise.all(promises);
                node.log(`[DEBUG] All requests completed, processing results...`);
                
                // Process results
                const objectResult = results[0];
                let enumResult = null;
                let aliasResult = null;
                
                node.log(`[DEBUG] Object result received: ${JSON.stringify({success: objectResult.success, hasObject: !!objectResult.object, objectType: typeof objectResult.object})}`);
                
                if (node.includeEnums) {
                    enumResult = results[1];
                    node.log(`[DEBUG] Enum result received: ${JSON.stringify({success: enumResult.success, hasEnums: !!enumResult.enums})}`);
                }
                
                if (node.includeAliases) {
                    const aliasIndex = node.includeEnums ? 2 : 1;
                    aliasResult = results[aliasIndex];
                    node.log(`[DEBUG] Alias result received: ${JSON.stringify({success: aliasResult.success, hasAliases: !!aliasResult.aliases})}`);
                }
                
                // Process object result
                if (!objectResult.success) {
                    node.log(`[DEBUG] Object request failed: ${objectResult.error}`);
                    throw new Error(objectResult.error || 'Failed to retrieve objects');
                }
                
                // Debug: Log what we got from the orchestrator
                node.log(`[DEBUG] Raw object result from orchestrator: ${JSON.stringify(objectResult, null, 2)}`);
                
                let processedObjects = processObjectResult(objectResult.object, objectIdOrPattern);
                node.log(`Processed ${Array.isArray(processedObjects) ? processedObjects.length : (processedObjects ? 1 : 0)} objects`);
                
                // Process enum data if retrieved
                if (enumResult && enumResult.success) {
                    node.enumData = processEnumData(enumResult.enums);
                    node.log(`Processed enum data: ${node.enumData.totalEnums} enums, ${node.enumData.enumMemberMap.size} object mappings`);
                }
                
                // Process alias data if retrieved
                if (aliasResult && aliasResult.success) {
                    node.log(`[DEBUG] Alias request successful, processing data...`);
                    node.log(`[DEBUG] Full alias result structure: ${JSON.stringify(aliasResult, null, 2)}`);
                    node.aliasData = processAliasData(aliasResult.aliases);
                    node.log(`Processed alias data: ${node.aliasData.totalAliases} aliases, ${node.aliasData.aliasMap.size} mappings, ${node.aliasData.reverseAliasMap.size} reverse mappings`);
                    
                    // Debug: Log reverse alias mappings
                    if (node.aliasData.reverseAliasMap.size > 0) {
                        node.log(`Reverse alias mappings: ${Array.from(node.aliasData.reverseAliasMap.keys()).join(', ')}`);
                    }
                } else if (aliasResult) {
                    node.log(`[DEBUG] Alias request failed: ${aliasResult.error || 'Unknown error'}`);
                    node.log(`[DEBUG] Full failed alias result: ${JSON.stringify(aliasResult, null, 2)}`);
                } else {
                    node.log(`[DEBUG] No alias result received`);
                }
                
                // Enrich objects with enum and alias data
                if (node.includeEnums && node.enumData) {
                    processedObjects = enrichObjectsWithEnums(processedObjects, node.enumData);
                    node.log(`Enriched objects with enum data`);
                }
                
                if (node.includeAliases && node.aliasData) {
                    node.log(`[DEBUG] Starting alias enrichment for ${Array.isArray(processedObjects) ? processedObjects.length : 1} objects`);
                    processedObjects = enrichObjectsWithAliases(processedObjects, node.aliasData);
                    node.log(`Enriched objects with alias data`);
                } else {
                    node.log(`[DEBUG] Skipping alias enrichment: includeAliases=${node.includeAliases}, aliasData=${!!node.aliasData}`);
                }
                
                // Log sample enriched object for debugging
                if (Array.isArray(processedObjects) && processedObjects.length > 0) {
                    node.log(`Sample enriched object: ${JSON.stringify(processedObjects[0], null, 2)}`);
                } else if (processedObjects && processedObjects._id) {
                    node.log(`Sample enriched object: ${JSON.stringify(processedObjects, null, 2)}`);
                }
                
                // Format the output
                const output = formatOutput(
                    processedObjects,
                    objectIdOrPattern,
                    currentOutputMode,
                    currentObjectType,
                    node.enumData,
                    node.aliasData
                );
                
                // Add to message
                Object.assign(msg, output);
                
                // Update status
                const statusText = createStatusText(node.useWildcard ? "Ready (Pattern mode)" : "Ready");
                StatusHelpers.updateConnectionStatus(node, 'ready', statusText);
                
                // Send message
                send(msg);
                done();
                
            } catch (error) {
                StatusHelpers.updateConnectionStatus(node, 'error', `Error: ${error.message}`);
                node.error(`Error processing input: ${error.message}`);
                
                // Send error response
                const output = formatOutput(null, msg.topic || configObjectId, node.outputMode, node.objectType, null, null);
                output.error = error.message;
                output.errorType = error.message.includes('timeout') ? 'timeout' : 'unknown';
                
                Object.assign(msg, output);
                send(msg);
                done(error);
            }
        });

        node.on('close', function(done) {
            // Clean up all listeners to prevent memory leaks
            Orchestrator.removeListener('server:ready', onServerReady);
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
        StatusHelpers.updateConnectionStatus(node, 'waiting', 'Waiting for server...');
    }

    RED.nodes.registerType("iobgetobject", iobgetobject);
};