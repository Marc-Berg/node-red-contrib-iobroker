const connectionManager = require('../lib/manager/websocket-manager');
const { NodeHelpers } = require('../lib/utils/node-helpers');

module.exports = function(RED) {
    function iobgetobject(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Use helper to create status functions
        const { setStatus, setError } = NodeHelpers.createStatusHelpers(node);
        
        // Use helper to validate server config
        const serverConfig = NodeHelpers.validateServerConfig(RED, config, setError);
        if (!serverConfig) return;

        const { globalConfig, connectionDetails, serverId } = serverConfig;

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
            serverId,
            nodeId: node.id
        };

        node.currentConfig = connectionDetails;
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

        // Custom status texts for getobject mode
        const statusTexts = {
            ready: (() => {
                const baseText = isWildcardPattern ? "Ready (Pattern mode)" : "Ready";
                const enumText = settings.includeEnums ? " +enums" : "";
                const aliasText = settings.includeAliases ? " +aliases" : "";
                return baseText + enumText + aliasText;
            })(),
            reconnected: (() => {
                const baseText = isWildcardPattern ? "Reconnected (Pattern)" : "Reconnected";
                const enumText = settings.includeEnums ? " +enums" : "";
                const aliasText = settings.includeAliases ? " +aliases" : "";
                return baseText + enumText + aliasText;
            })()
        };

        // Initialize connection using helper
        NodeHelpers.initializeConnection(
            node, config, RED, settings, globalConfig, setStatus, statusTexts
        );

        // OPTIMIZED: Combined data loading with getObjectView
        async function loadAllDataOptimized(objectIdOrPattern, currentObjectType) {
            const startTime = Date.now();
            
            node.log(`🔧 loadAllDataOptimized called:`);
            node.log(`   Pattern: ${objectIdOrPattern}`);
            node.log(`   Type: ${currentObjectType || 'none'}`);
            node.log(`   Include enums: ${settings.includeEnums}`);
            node.log(`   Include aliases: ${settings.includeAliases}`);
            
            try {
                const queries = [];
                
                // 1. Main objects query
                if (currentObjectType) {
                    node.log(`📋 Adding getObjectView query for type: ${currentObjectType}`);
                    const viewParams = {};
                    if (objectIdOrPattern !== '*' && !objectIdOrPattern.includes('*')) {
                        viewParams.key = objectIdOrPattern;
                        node.log(`   Using key filter: ${objectIdOrPattern}`);
                    }
                    
                    queries.push({
                        name: 'objects',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', currentObjectType, viewParams)
                    });
                } else {
                    node.log(`📋 Adding getObjects query for all types`);
                    queries.push({
                        name: 'objects',
                        promise: connectionManager.getObjects(settings.serverId, objectIdOrPattern, currentObjectType)
                    });
                }
                
                // 2. Enums query (if needed)
                if (settings.includeEnums) {
                    node.log(`🏷️ Adding enum query via getObjectView`);
                    queries.push({
                        name: 'enums',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', 'enum', {})
                    });
                }
                
                // 3. Aliases query (if needed) 
                if (settings.includeAliases) {
                    node.log(`🔗 Adding alias query via getObjectView with prefix filter`);
                    queries.push({
                        name: 'aliases',
                        promise: connectionManager.getObjectView(settings.serverId, 'system', 'state', {
                            startkey: 'alias.',
                            endkey: 'alias.\uffff'
                        })
                    });
                }
                
                node.log(`⚡ Executing ${queries.length} queries in parallel...`);
                
                // Execute all queries in parallel
                const results = await Promise.all(queries.map(q => q.promise));
                
                // Map results back to named structure
                const dataMap = {};
                queries.forEach((query, index) => {
                    dataMap[query.name] = results[index];
                    const resultInfo = results[index]?.rows ? `${results[index].rows.length} rows` : 
                                       Array.isArray(results[index]) ? `${results[index].length} objects` : 'unknown format';
                    node.log(`   ${query.name}: ${resultInfo}`);
                });
                
                const duration = Date.now() - startTime;
                node.log(`✅ loadAllDataOptimized completed in ${duration}ms`);
                
                return dataMap;
                
            } catch (error) {
                node.error(`❌ loadAllDataOptimized failed: ${error.message}`);
                throw error;
            }
        }

        // Performance Test Function
        async function performanceTest(msg, send, done) {
            node.log('🧪 PERFORMANCE TEST MODE ACTIVATED');
            
            const testCases = [
                { name: 'States only', pattern: '*', type: 'state' },
                { name: 'Enums only', pattern: '*', type: 'enum' },
                { name: 'Adapters only', pattern: '*', type: 'adapter' },
                { name: 'All types', pattern: '*', type: null },
                { name: 'Aliases only', pattern: 'alias.*', type: null }
            ];
            
            const results = [];
            
            for (const testCase of testCases) {
                node.log(`🧪 Testing: ${testCase.name} (pattern: ${testCase.pattern}, type: ${testCase.type})`);
                
                const startTime = Date.now();
                
                try {
                    let result;
                    if (testCase.type) {
                        // Test getObjectView directly
                        node.log(`   Using getObjectView('system', '${testCase.type}', {})`);
                        result = await connectionManager.getObjectView(settings.serverId, 'system', testCase.type, {});
                    } else {
                        // Test getObjects
                        node.log(`   Using getObjects('${testCase.pattern}', null)`);
                        result = await connectionManager.getObjects(settings.serverId, testCase.pattern, testCase.type);
                    }
                    
                    const duration = Date.now() - startTime;
                    const count = result?.rows ? result.rows.length : (Array.isArray(result) ? result.length : 0);
                    
                    results.push({
                        test: testCase.name,
                        pattern: testCase.pattern,
                        type: testCase.type,
                        duration: duration,
                        count: count,
                        success: true
                    });
                    
                    node.log(`✅ ${testCase.name}: ${count} objects in ${duration}ms`);
                    
                } catch (error) {
                    results.push({
                        test: testCase.name,
                        pattern: testCase.pattern,
                        type: testCase.type,
                        duration: 0,
                        count: 0,
                        success: false,
                        error: error.message
                    });
                    
                    node.log(`❌ ${testCase.name}: FAILED - ${error.message}`);
                }
            }
            
            const summary = {
                testResults: results,
                totalTests: results.length,
                successfulTests: results.filter(r => r.success).length,
                fastestTest: results.filter(r => r.success).sort((a, b) => a.duration - b.duration)[0],
                slowestTest: results.filter(r => r.success).sort((a, b) => b.duration - a.duration)[0]
            };
            
            node.log(`📊 PERFORMANCE TEST COMPLETE:`);
            node.log(`   Successful tests: ${summary.successfulTests}/${summary.totalTests}`);
            if (summary.fastestTest) {
                node.log(`   Fastest: ${summary.fastestTest.test} (${summary.fastestTest.duration}ms)`);
            }
            if (summary.slowestTest) {
                node.log(`   Slowest: ${summary.slowestTest.test} (${summary.slowestTest.duration}ms)`);
            }
            
            setStatus("green", "dot", `Test complete: ${summary.successfulTests}/${summary.totalTests} passed`);
            
            msg.payload = summary;
            msg.performanceTestResults = summary;
            
            send(msg);
            done && done();
        }

        // OPTIMIZED: Process enum data from getObjectView result
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
            
            // Convert getObjectView result to objects
            for (const row of enumResult.rows) {
                if (row.value && row.value.type === 'enum') {
                    allEnums.push({
                        _id: row.id,
                        ...row.value
                    });
                }
            }
            
            // Process enums
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

            const enumData = {
                enumsByType,
                enumMemberMap,
                totalEnums: allEnums.length
            };

            node.log(`Processed ${enumData.totalEnums} enums via getObjectView (${enumsByType.rooms.length} rooms, ${enumsByType.functions.length} functions, ${enumsByType.other.length} other)`);
            
            return enumData;
        }

        // OPTIMIZED: Process alias data from getObjectView result
        function processAliasData(aliasResult) {
            const aliasMap = new Map();
            const reverseAliasMap = new Map();
            const aliasObjects = new Map();
            
            if (!aliasResult || !aliasResult.rows) {
                return { aliasMap, reverseAliasMap, aliasObjects, totalAliases: 0 };
            }
            
            // Process alias objects from getObjectView result
            for (const row of aliasResult.rows) {
                if (row.id.startsWith('alias.') && row.value && row.value.common && row.value.common.alias && row.value.common.alias.id) {
                    const aliasObj = {
                        _id: row.id,
                        ...row.value
                    };
                    
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
                        continue;
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
            }

            const aliasData = {
                aliasMap,
                reverseAliasMap,
                aliasObjects,
                totalAliases: aliasMap.size
            };

            node.log(`Processed ${aliasData.totalAliases} aliases via getObjectView with prefix filter`);
            return aliasData;
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

        // OPTIMIZED: Process objects from getObjectView result  
        function processObjectViewResult(objectResult, objectType) {
            if (!objectResult) {
                return [];
            }
            
            // Handle both getObjectView result and getObjects result
            if (objectResult.rows) {
                // getObjectView result
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
                // getObjects result (already processed)
                return objectResult;
            }
            
            return [];
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

        // Input handler with OPTIMIZED data loading and DEBUG logging
        node.on('input', async function(msg, send, done) {
            try {
                // Add performance test mode
                if (msg.topic === 'PERFORMANCE_TEST') {
                    await performanceTest(msg, send, done);
                    return;
                }

                // Handle status requests using helper
                if (NodeHelpers.handleStatusRequest(msg, send, done, settings)) {
                    return;
                }

                const objectIdOrPattern = configObjectId || (typeof msg.topic === "string" ? msg.topic.trim() : "");
                if (!NodeHelpers.validateRequiredInput(objectIdOrPattern, "Object ID", setStatus, done)) {
                    return;
                }

                const isCurrentWildcard = objectIdOrPattern.includes('*');
                const currentOutputMode = msg.outputMode || settings.outputMode;
                const currentObjectType = msg.objectType || settings.objectType;
                
                // DETAILED PERFORMANCE LOGGING
                const performanceLog = {
                    startTime: Date.now(),
                    pattern: objectIdOrPattern,
                    objectType: currentObjectType,
                    includeEnums: settings.includeEnums,
                    includeAliases: settings.includeAliases,
                    phases: {}
                };
                
                node.log(`🚀 STARTING REQUEST: ${objectIdOrPattern} (type: ${currentObjectType || 'all'})`);
                node.log(`📊 Features: enums=${settings.includeEnums}, aliases=${settings.includeAliases}`);
                
                // Load all data in parallel with detailed timing
                const features = [];
                if (settings.includeEnums) features.push("+enums");
                if (settings.includeAliases) features.push("+aliases");
                const statusText = `Loading objects ${objectIdOrPattern} ${features.join(" ")}...`;
                setStatus("blue", "dot", statusText);
                
                try {
                    // PHASE 1: Data Loading
                    const dataLoadStart = Date.now();
                    node.log(`📥 PHASE 1: Starting optimized data loading...`);
                    
                    const dataMap = await loadAllDataOptimized(objectIdOrPattern, currentObjectType);
                    
                    performanceLog.phases.dataLoading = Date.now() - dataLoadStart;
                    node.log(`✅ PHASE 1: Data loading completed in ${performanceLog.phases.dataLoading}ms`);
                    
                    // PHASE 2: Data Processing  
                    const processingStart = Date.now();
                    node.log(`🔄 PHASE 2: Starting data processing...`);
                    
                    let objects = dataMap.objects;
                    let enumData = null;
                    let aliasData = null;
                    
                    // Process objects
                    if (currentObjectType && dataMap.objects && dataMap.objects.rows) {
                        const objProcessStart = Date.now();
                        objects = processObjectViewResult(dataMap.objects, currentObjectType);
                        node.log(`📋 Processed objects from getObjectView in ${Date.now() - objProcessStart}ms: ${objects.length} results`);
                    } else {
                        node.log(`📋 Using direct objects result: ${Array.isArray(objects) ? objects.length : 'not array'} results`);
                    }
                    
                    // Process enum data
                    if (settings.includeEnums && dataMap.enums) {
                        const enumProcessStart = Date.now();
                        enumData = processEnumData(dataMap.enums);
                        node.log(`🏷️ Processed enum data in ${Date.now() - enumProcessStart}ms: ${enumData.totalEnums} enums`);
                    }
                    
                    // Process alias data
                    if (settings.includeAliases && dataMap.aliases) {
                        const aliasProcessStart = Date.now();
                        aliasData = processAliasData(dataMap.aliases);
                        node.log(`🔗 Processed alias data in ${Date.now() - aliasProcessStart}ms: ${aliasData.totalAliases} aliases`);
                    }
                    
                    performanceLog.phases.dataProcessing = Date.now() - processingStart;
                    node.log(`✅ PHASE 2: Data processing completed in ${performanceLog.phases.dataProcessing}ms`);
                    
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
                    
                    // PHASE 3: Enrichment
                    const enrichmentStart = Date.now();
                    node.log(`✨ PHASE 3: Starting object enrichment...`);
                    
                    // Enrich with enum assignments
                    const enumEnrichStart = Date.now();
                    objects = enrichObjectsWithEnums(objects, enumData);
                    node.log(`🏷️ Enum enrichment completed in ${Date.now() - enumEnrichStart}ms`);
                    
                    // Enrich with alias information
                    const aliasEnrichStart = Date.now();
                    objects = await enrichObjectsWithAliases(objects, aliasData, enumData);
                    node.log(`🔗 Alias enrichment completed in ${Date.now() - aliasEnrichStart}ms`);
                    
                    performanceLog.phases.enrichment = Date.now() - enrichmentStart;
                    node.log(`✅ PHASE 3: Enrichment completed in ${performanceLog.phases.enrichment}ms`);
                    
                    const result = formatOutput(objects, objectIdOrPattern, currentOutputMode, currentObjectType, enumData, aliasData);
                    Object.assign(msg, result);
                    
                    // FINAL PERFORMANCE SUMMARY
                    performanceLog.totalTime = Date.now() - performanceLog.startTime;
                    node.log(`🎯 PERFORMANCE SUMMARY:`);
                    node.log(`   Total time: ${performanceLog.totalTime}ms`);
                    node.log(`   Data loading: ${performanceLog.phases.dataLoading}ms (${((performanceLog.phases.dataLoading / performanceLog.totalTime) * 100).toFixed(1)}%)`);
                    node.log(`   Data processing: ${performanceLog.phases.dataProcessing}ms (${((performanceLog.phases.dataProcessing / performanceLog.totalTime) * 100).toFixed(1)}%)`);
                    node.log(`   Enrichment: ${performanceLog.phases.enrichment}ms (${((performanceLog.phases.enrichment / performanceLog.totalTime) * 100).toFixed(1)}%)`);
                    node.log(`   Results: ${result.count} objects`);
                    
                    msg.performanceLog = performanceLog;
                    
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

        // Cleanup on node close
        node.on("close", async function(removed, done) {
            await NodeHelpers.handleNodeClose(node, settings, "Get object");
            done();
        });

        node.on("error", NodeHelpers.createErrorHandler(node, setError));
    }

    RED.nodes.registerType("iobgetobject", iobgetobject);
};