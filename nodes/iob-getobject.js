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
        const isWildcardPattern = configObjectId && configObjectId.includes('*');
        
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

        // --- Helper Functions ---

        function getObjectIdOrPattern(msg, node) {
            const objectIdFromMsg = msg.payload && typeof msg.payload === 'string' ? msg.payload.trim() : '';
            const objectIdFromTopic = msg.topic && typeof msg.topic === 'string' ? msg.topic.trim() : '';
            
            return objectIdFromMsg || objectIdFromTopic || configObjectId;
        }

        function getOutputMode(msg, node) {
            return msg.outputMode || node.outputMode;
        }

        function getObjectType(msg, node) {
            return msg.objectType || node.objectType;
        }

        function createStatusText(text) {
            return node.server.connectionName ? `[${node.server.connectionName}] ${text}` : text;
        }

        function processObjectResult(objectData, objectIdOrPattern) {
            if (!objectData) {
                node.log('[DEBUG] No object data returned');
                return null;
            }

            if (Array.isArray(objectData)) {
                node.log(`[DEBUG] Processing array of ${objectData.length} objects`);
                return objectData.map(obj => {
                    if (obj && typeof obj === 'object') {
                        if (!obj._id && obj.name) {
                            const possibleId = Object.keys(obj).find(key => key !== 'name' && obj[key] === obj);
                            if (possibleId) {
                                return {
                                    _id: possibleId,
                                    ...obj
                                };
                            }
                        }
                    }
                    return obj;
                }).filter(obj => obj !== null && obj !== undefined);
            }

            if (typeof objectData === 'object') {
                if (objectData._id) {
                    node.log('[DEBUG] Processing single object with _id');
                    return objectData;
                } else {
                    node.log('[DEBUG] Processing object collection without _id structure');
                    return Object.keys(objectData).map(key => {
                        const obj = objectData[key];
                        if (obj && typeof obj === 'object') {
                            return {
                                _id: key,
                                ...obj
                            };
                        }
                        return null;
                    }).filter(obj => obj !== null);
                }
            }

            node.log('[DEBUG] Processing primitive object data');
            return objectData;
        }

        function processEnumData(enumData) {
            if (!enumData || typeof enumData !== 'object') {
                return {
                    totalEnums: 0,
                    enumMemberMap: new Map()
                };
            }

            const enumMemberMap = new Map();
            let totalEnums = 0;

            // Handle both formats: direct object map and getObjectView format
            let enumObjects = [];
            
            if (Array.isArray(enumData.rows)) {
                // getObjectView format: { rows: [{ id, value }] }
                enumObjects = enumData.rows.map(row => ({
                    id: row.id,
                    ...row.value
                }));
            } else {
                // Direct object map format: { "enum.id": { common: {...} } }
                enumObjects = Object.keys(enumData).map(enumId => ({
                    id: enumId,
                    ...enumData[enumId]
                }));
            }

            enumObjects.forEach(enumObj => {
                if (enumObj && enumObj.common && enumObj.common.members && Array.isArray(enumObj.common.members)) {
                    totalEnums++;
                    enumObj.common.members.forEach(memberId => {
                        if (!enumMemberMap.has(memberId)) {
                            enumMemberMap.set(memberId, []);
                        }
                        enumMemberMap.get(memberId).push({
                            id: enumObj.id,
                            name: enumObj.common.name || enumObj.id,
                            desc: enumObj.common.desc
                        });
                    });
                }
            });

            return {
                totalEnums,
                enumMemberMap
            };
        }

        function processAliasData(aliasData) {
            if (!aliasData || typeof aliasData !== 'object') {
                return {
                    totalAliases: 0,
                    aliasMap: new Map(),
                    reverseAliasMap: new Map()
                };
            }

            const aliasMap = new Map();
            const reverseAliasMap = new Map();
            let totalAliases = 0;

            Object.keys(aliasData).forEach(aliasId => {
                const aliasObj = aliasData[aliasId];
                if (aliasObj && aliasObj.common && aliasObj.common.alias && aliasObj.common.alias.id) {
                    totalAliases++;
                    const targetId = aliasObj.common.alias.id;
                    
                    aliasMap.set(aliasId, {
                        targetId: targetId,
                        name: aliasObj.common.name || aliasId,
                        desc: aliasObj.common.desc,
                        read: aliasObj.common.alias.read,
                        write: aliasObj.common.alias.write
                    });

                    if (!reverseAliasMap.has(targetId)) {
                        reverseAliasMap.set(targetId, []);
                    }
                    reverseAliasMap.get(targetId).push({
                        aliasId: aliasId,
                        name: aliasObj.common.name || aliasId,
                        desc: aliasObj.common.desc,
                        read: aliasObj.common.alias.read,
                        write: aliasObj.common.alias.write
                    });
                }
            });

            return {
                totalAliases,
                aliasMap,
                reverseAliasMap
            };
        }

        function enrichObjectsWithEnums(objects, enumData) {
            if (!objects || !enumData || !enumData.enumMemberMap) {
                return objects;
            }

            const enrichSingleObject = (obj) => {
                if (!obj || !obj._id) return obj;
                
                const enums = enumData.enumMemberMap.get(obj._id);
                if (enums && enums.length > 0) {
                    return {
                        ...obj,
                        enums: enums
                    };
                }
                return obj;
            };

            if (Array.isArray(objects)) {
                return objects.map(enrichSingleObject);
            } else {
                return enrichSingleObject(objects);
            }
        }

        function enrichObjectsWithAliases(objects, aliasData) {
            if (!objects || !aliasData) {
                return objects;
            }

            const enrichSingleObject = (obj) => {
                if (!obj || !obj._id) return obj;
                
                const result = { ...obj };
                
                if (node.aliasResolution === 'target' || node.aliasResolution === 'both') {
                    const aliases = aliasData.reverseAliasMap.get(obj._id);
                    if (aliases && aliases.length > 0) {
                        result.aliases = aliases;
                    }
                }
                
                if (node.aliasResolution === 'alias' || node.aliasResolution === 'both') {
                    const aliasInfo = aliasData.aliasMap.get(obj._id);
                    if (aliasInfo) {
                        result.aliasTarget = aliasInfo;
                    }
                }
                
                return result;
            };

            if (Array.isArray(objects)) {
                return objects.map(enrichSingleObject);
            } else {
                return enrichSingleObject(objects);
            }
        }

        function formatOutput(objects, objectIdOrPattern, outputMode, objectType, enumData, aliasData) {
            let filteredObjects = objects;

            if (filteredObjects && objectType) {
                const filterByType = (obj) => {
                    return obj && obj.type && obj.type === objectType;
                };

                if (Array.isArray(filteredObjects)) {
                    filteredObjects = filteredObjects.filter(filterByType);
                } else if (!filterByType(filteredObjects)) {
                    filteredObjects = null;
                }
            }

            const result = {
                count: 0,
                objectIdOrPattern: objectIdOrPattern
            };

            if (filteredObjects) {
                if (Array.isArray(filteredObjects)) {
                    result.count = filteredObjects.length;
                    if (outputMode === 'single' && filteredObjects.length > 0) {
                        result[node.outputProperty] = filteredObjects[0];
                    } else {
                        result[node.outputProperty] = filteredObjects;
                    }
                } else {
                    result.count = 1;
                    result[node.outputProperty] = filteredObjects;
                }
            } else {
                result[node.outputProperty] = outputMode === 'single' ? null : [];
            }

            if (enumData) {
                result.enumsProcessed = enumData.totalEnums;
            }

            if (aliasData) {
                result.aliasesProcessed = aliasData.totalAliases;
            }

            return result;
        }

        // Helper function to validate input
        function validateInput(msg) {
            const objectIdFromMsg = msg.payload && typeof msg.payload === 'string' ? msg.payload.trim() : '';
            const objectIdFromTopic = msg.topic && typeof msg.topic === 'string' ? msg.topic.trim() : '';
            
            const objectIdOrPattern = objectIdFromMsg || objectIdFromTopic || configObjectId;
            
            if (!objectIdOrPattern) {
                throw new Error('No object ID or pattern provided');
            }

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

        const onRetrying = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'connecting', 'Retrying connection...');
            }
        };

        const onPermanentFailure = ({ serverId }) => {
            if (serverId === node.server.id) {
                StatusHelpers.updateConnectionStatus(node, 'error', 'Connection failed permanently');
            }
        };

        // Register with orchestrator
        if (node.server && node.server.id) {
            Orchestrator.registerNode(node.id, node.server);
            node.isRegistered = true;
        }

        // Connection event listeners
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
                
                // Use optimized parallel request method
                const useOptimizedMethod = true;
                
                if (useOptimizedMethod) {
                    // New optimized method - single parallel request
                    try {
                        node.log(`[DEBUG] Attempting optimized parallel request...`);
                        const result = await Orchestrator.getMultipleData(node.id, {
                            objectId: objectIdOrPattern,
                            needsEnums: node.includeEnums,
                            needsAliases: node.includeAliases,
                            objectType: currentObjectType // Pass object type filter to optimized request
                        });
                        
                        // Process the combined result
                        const objectResult = {
                            success: result.success && result.objects !== undefined,
                            object: result.objects,
                            error: result.objectsError
                        };
                        
                        const enumResult = node.includeEnums ? {
                            success: result.success && result.enums !== undefined,
                            enums: result.enums,
                            error: result.enumsError
                        } : null;
                        
                        const aliasResult = node.includeAliases ? {
                            success: result.success && result.aliases !== undefined,
                            aliases: result.aliases,
                            error: result.aliasesError
                        } : null;
                        
                        node.log(`[DEBUG] Optimized method completed in ${result.duration || 'unknown'}ms`);
                        
                        // Process results
                        await processResults(objectResult, enumResult, aliasResult, objectIdOrPattern, currentOutputMode, currentObjectType, msg, send, done);
                        
                    } catch (optimizedError) {
                        node.log(`[DEBUG] Optimized method failed: ${optimizedError.message}, falling back to original method`);
                        throw optimizedError; // For now, don't use fallback
                    }
                    
                } else {
                    // Original method - separate sequential requests (fallback)
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
                    node.log(`[DEBUG] Using fallback method with ${promises.length} requests`);
                    const results = await Promise.all(promises);
                    
                    // Process results
                    const objectResult = results[0];
                    let enumResult = null;
                    let aliasResult = null;
                    
                    if (node.includeEnums) {
                        enumResult = results[1];
                    }
                    
                    if (node.includeAliases) {
                        const aliasIndex = node.includeEnums ? 2 : 1;
                        aliasResult = results[aliasIndex];
                    }
                    
                    // Process results
                    await processResults(objectResult, enumResult, aliasResult, objectIdOrPattern, currentOutputMode, currentObjectType, msg, send, done);
                }
                
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

        // Helper method to process results (both optimized and original)
        async function processResults(objectResult, enumResult, aliasResult, objectIdOrPattern, currentOutputMode, currentObjectType, msg, send, done) {
            try {
                // Process object result
                if (!objectResult.success) {
                    node.log(`[DEBUG] Object request failed: ${objectResult.error}`);
                    throw new Error(objectResult.error || 'Failed to retrieve objects');
                }

                // Debug: Log what we got from the orchestrator (summary only)
                const objectCount = objectResult.object ? 
                    (Array.isArray(objectResult.object) ? objectResult.object.length : 
                     (typeof objectResult.object === 'object' ? Object.keys(objectResult.object).length : 1)) : 0;
                node.log(`[DEBUG] Raw object result: success=${objectResult.success}, objectCount=${objectCount}`);
                
                let processedObjects = processObjectResult(objectResult.object, objectIdOrPattern);
                node.log(`[DEBUG] Objects after processObjectResult: ${Array.isArray(processedObjects) ? processedObjects.length : (processedObjects ? 1 : 0)} objects`);
                
                // Debug: Log object types before filtering
                if (Array.isArray(processedObjects)) {
                    const typeDistribution = {};
                    processedObjects.forEach(obj => {
                        const type = obj?.type || 'unknown';
                        typeDistribution[type] = (typeDistribution[type] || 0) + 1;
                    });
                    node.log(`[DEBUG] Object type distribution: ${JSON.stringify(typeDistribution)}`);
                } else if (processedObjects) {
                    node.log(`[DEBUG] Single object type: ${processedObjects.type || 'unknown'}`);
                }
                
                node.log(`Processed ${Array.isArray(processedObjects) ? processedObjects.length : (processedObjects ? 1 : 0)} objects`);
                
                // Debug: Log filtering configuration
                node.log(`[DEBUG] Object type filter: "${currentObjectType}" (empty = no filter)`);
                
                // Process enum data if retrieved
                if (enumResult && enumResult.success) {
                    node.enumData = processEnumData(enumResult.enums);
                    node.log(`Processed enum data: ${node.enumData.totalEnums} enums, ${node.enumData.enumMemberMap.size} object mappings`);
                }
                
                // Process alias data if retrieved
                if (aliasResult && aliasResult.success) {
                    node.aliasData = processAliasData(aliasResult.aliases);
                    node.log(`Processed alias data: ${node.aliasData.totalAliases} aliases, ${node.aliasData.aliasMap.size} mappings, ${node.aliasData.reverseAliasMap.size} reverse mappings`);
                } else if (aliasResult) {
                    node.log(`[DEBUG] Alias request failed: ${aliasResult.error || 'Unknown error'}`);
                }
                
                // Enrich objects with enum and alias data
                if (node.includeEnums && node.enumData) {
                    processedObjects = enrichObjectsWithEnums(processedObjects, node.enumData);
                    node.log(`Enriched objects with enum data`);
                }
                
                if (node.includeAliases && node.aliasData) {
                    processedObjects = enrichObjectsWithAliases(processedObjects, node.aliasData);
                    node.log(`Enriched objects with alias data`);
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
                
                node.log(`[DEBUG] Final output count: ${output.count} objects`);
                
                // Add detailed statistics
                if (Array.isArray(processedObjects)) {
                    const typeStats = {};
                    processedObjects.forEach(obj => {
                        const type = obj?.type || 'unknown';
                        typeStats[type] = (typeStats[type] || 0) + 1;
                    });
                    node.log(`[STATISTICS] Object types found: ${JSON.stringify(typeStats)}`);
                } else if (processedObjects) {
                    node.log(`[STATISTICS] Single object type: ${processedObjects.type || 'unknown'}`);
                }
                
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
        }

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
