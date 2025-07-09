/*!
 * Operation Manager for ioBroker Node-RED Integration
 * Clean and simple with getObjectView optimization
 */

const { CONNECTION_STATES } = require('./connection-manager');
const { Logger } = require('../utils/logger');
const { ManagerHelpers } = require('../utils/manager-helpers');

class OperationManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.operationQueues = new Map();
        this.queueProcessors = new Map();

        this.onTriggerReconnection = null;
        this.log = new Logger('OperationManager');

        this.queueProcessor = ManagerHelpers.createQueueProcessor(
            this.operationQueues, 
            this.queueProcessors, 
            this.log
        );

        this.operationExecutor = ManagerHelpers.createOperationExecutor(
            this.connectionManager,
            this.log
        );

        this.timeoutHandler = ManagerHelpers.createTimeoutHandler(10000);
    }

    isImportantOperation(operationName) {
        const importantOps = ['setState', 'getState', 'getStates', 'getObjects', 'subscribe', 'getHistory', 'sendToAdapter'];
        return importantOps.some(op => 
            operationName.toLowerCase().includes(op.toLowerCase())
        );
    }

    async executeOperation(serverId, operation, operationName = 'operation') {
        if (this.connectionManager.isConnectionReady(serverId)) {
            return await this.operationExecutor.executeOperation(serverId, operation, operationName);
        }

        const state = this.connectionManager.getConnectionState(serverId);

        if (state === CONNECTION_STATES.CONNECTING) {
            this.log.info(`Queueing ${operationName} for ${serverId} - connection in progress`);
            return await this.queueProcessor.enqueue(serverId, operation, operationName);
        }

        if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
            this.log.debug(`Queueing ${operationName} for ${serverId} - connection retry in progress`);
            return await this.queueProcessor.enqueue(serverId, operation, operationName, 15000);
        }

        if (state === CONNECTION_STATES.IDLE) {
            const storedConfig = this.connectionManager.getStoredConfig(serverId);
            if (storedConfig) {
                this.log.debug(`Triggering automatic reconnection for ${serverId} due to ${operationName}`);
                this.triggerReconnection(serverId);
                this.log.debug(`Queueing ${operationName} for ${serverId} - triggering reconnection`);
                return await this.queueProcessor.enqueue(serverId, operation, operationName, 15000);
            } else {
                this.log.debug(`No stored config for ${serverId} - cannot auto-reconnect`);
                throw new Error(`No ready connection for ${serverId} and no stored config for auto-reconnect`);
            }
        }

        throw new Error(`No ready connection for ${serverId} (state: ${state})`);
    }

    processQueuedOperations(serverId) {
        this.log.info(`Processing queued operations for ${serverId}`);
        this.queueProcessor.processQueue(serverId);
    }

    clearOperationQueue(serverId, error) {
        this.queueProcessor.clearQueue(serverId, error);
    }

    triggerReconnection(serverId) {
        if (this.onTriggerReconnection) {
            this.onTriggerReconnection(serverId);
        }
    }

    async getState(serverId, stateId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Getting state ${stateId} from ${serverId}`);
            const result = await client.getState(stateId);
            this.log.debug(`State ${stateId} retrieved: ${result?.val !== undefined ? result.val : 'undefined'}`);
            
            return result;
        }, `getState(${stateId})`);
    }

    async setState(serverId, stateId, value, ack = true) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Setting state ${stateId} = ${value} (ack: ${ack}) on ${serverId}`);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
                const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };

                client.emit('setState', stateId, state, (err) => {
                    clearTimeout(timeout);
                    if (err) {
                        reject(new Error(err));
                    } else {
                        this.log.debug(`State ${stateId} set successfully on ${serverId}`);
                        resolve();
                    }
                });
            });
        }, `setState(${stateId})`);
    }

    async getStates(serverId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Retrieving all states for ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('getStates', '*', (err, states) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            const stateCount = Object.keys(states || {}).length;
                            this.log.info(`Retrieved ${stateCount} states for ${serverId}`);
                            resolve(states);
                        }
                    });
                }),
                15000,
                'Get states timeout'
            );
        }, 'getStates');
    }

    async getObject(serverId, objectId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.debug(`Getting object ${objectId} from ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('getObject', objectId, (err, obj) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            this.log.debug(`Object ${objectId} retrieved: ${obj ? 'found' : 'not found'}`);
                            resolve(obj);
                        }
                    });
                }),
                10000,
                'Get object timeout'
            );
        }, `getObject(${objectId})`);
    }

    async getObjects(serverId, pattern = '*', objectType = null) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Getting objects with pattern: ${pattern}, type: ${objectType || 'all'} from ${serverId}`);
            this.log.debug(`getObjects called with pattern: ${pattern}, objectType: ${objectType}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    if (pattern && pattern.includes('*')) {
                        // Use getObjectView for patterns
                        if (objectType) {
                            // Single type
                            const viewParams = {};
                            if (pattern !== '*' && !pattern.includes('*')) {
                                viewParams.key = pattern;
                            }
                            
                            client.emit('getObjectView', 'system', objectType, viewParams, (err, result) => {
                                if (err) {
                                    reject(new Error(err));
                                } else {
                                    const objects = this.processObjectViewResult(result, pattern, objectType);
                                    this.log.info(`Found ${objects.length} objects via getObjectView for pattern: ${pattern}, type: ${objectType}`);
                                    this.log.debug(`getObjectView: Found ${objects.length} objects for pattern: ${pattern}, type: ${objectType}`);
                                    resolve(objects);
                                }
                            });
                        } else {
                            // All types - use multiple getObjectView calls
                            const allTypes = ['state', 'channel', 'device', 'folder', 'adapter', 'instance', 'host', 'group', 'user', 'config', 'enum'];
                            const viewParams = {};
                            
                            const promises = allTypes.map(type => 
                                new Promise((resolveType) => {
                                    client.emit('getObjectView', 'system', type, viewParams, (err, result) => {
                                        if (err) {
                                            this.log.debug(`getObjectView for ${type} failed: ${err}`);
                                            resolveType([]);
                                        } else {
                                            const objects = this.processObjectViewResult(result, pattern, type);
                                            this.log.debug(`getObjectView(${type}): ${objects.length} objects`);
                                            resolveType(objects);
                                        }
                                    });
                                })
                            );
                            
                            Promise.all(promises).then(results => {
                                const allObjects = [];
                                for (const typeResults of results) {
                                    allObjects.push(...typeResults);
                                }
                                allObjects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
                                this.log.info(`Retrieved ${allObjects.length} objects via getObjectView for all types`);
                                this.log.debug(`All types via getObjectView: ${allObjects.length} objects`);
                                resolve(allObjects);
                            }).catch(err => {
                                reject(new Error(`getObjectView for all types failed: ${err.message}`));
                            });
                        }
                    } else {
                        // Single object
                        client.emit('getObject', pattern, (err, obj) => {
                            if (err) {
                                reject(new Error(err));
                            } else {
                                let result = obj ? [obj] : [];

                                if (objectType && obj && obj.type !== objectType) {
                                    result = [];
                                    this.log.debug(`Single object ${pattern} filtered out: found type '${obj.type}', wanted '${objectType}'`);
                                } else if (obj) {
                                    this.log.debug(`Single object ${pattern} matches: type '${obj.type}'`);
                                }

                                this.log.info(`Retrieved ${result.length} objects for single object query: ${pattern}`);
                                resolve(result);
                            }
                        });
                    }
                }),
                25000,
                'Get objects timeout'
            );
        }, `getObjects(${pattern}${objectType ? `, type: ${objectType}` : ''})`);
    }

    processObjectViewResult(result, pattern, objectType) {
        const objects = [];
        
        if (result && result.rows) {
            for (const row of result.rows) {
                if (row.value && row.value.type === objectType) {
                    const objectData = {
                        _id: row.id,
                        ...row.value
                    };
                    
                    if (this.matchesPattern(row.id, pattern)) {
                        objects.push(objectData);
                    }
                }
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    matchesPattern(objectId, pattern) {
        if (pattern === '*') {
            return true;
        }
        
        if (!pattern.includes('*')) {
            return objectId === pattern;
        }
        
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        
        return regex.test(objectId);
    }

    async getObjectView(serverId, designId, searchId, params = {}) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.debug(`Getting object view ${designId}/${searchId} from ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('getObjectView', designId, searchId, params, (err, result) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            const rowCount = result?.rows ? result.rows.length : 0;
                            this.log.debug(`getObjectView returned ${rowCount} rows`);
                            resolve(result);
                        }
                    });
                }),
                15000,
                'getObjectView timeout'
            );
        }, `getObjectView(${designId}, ${searchId})`);
    }

    filterObjectsByPattern(allObjects, pattern, objectType = null) {
        const objects = [];
        if (allObjects && typeof allObjects === 'object') {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            const regex = new RegExp(`^${regexPattern}$`);

            let totalMatched = 0;
            let typeFiltered = 0;

            for (const [objectId, objectData] of Object.entries(allObjects)) {
                if (objectData && regex.test(objectId)) {
                    totalMatched++;
                    if (!objectType || objectData.type === objectType) {
                        objects.push({
                            _id: objectId,
                            ...objectData
                        });
                    } else {
                        typeFiltered++;
                    }
                }
            }

            if (objectType) {
                this.log.debug(`Pattern filtering: ${totalMatched} objects matched pattern, ${typeFiltered} filtered by type '${objectType}', ${objects.length} final results`);
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    filterObjectsByType(allObjects, objectType = null) {
        const objects = [];
        if (allObjects && typeof allObjects === 'object') {
            let totalObjects = 0;
            let typeFiltered = 0;

            for (const [objectId, objectData] of Object.entries(allObjects)) {
                if (objectData) {
                    totalObjects++;
                    if (!objectType || objectData.type === objectType) {
                        objects.push({
                            _id: objectId,
                            ...objectData
                        });
                    } else {
                        typeFiltered++;
                    }
                }
            }

            if (objectType) {
                this.log.debug(`Type filtering: ${totalObjects} total objects, ${typeFiltered} filtered by type '${objectType}', ${objects.length} final results`);
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    async setObject(serverId, objectId, objectDef) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Setting object ${objectId} on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('setObject', objectId, objectDef, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            this.log.debug(`Object ${objectId} set successfully on ${serverId}`);
                            resolve();
                        }
                    });
                }),
                10000,
                'Set object timeout'
            );
        }, `setObject(${objectId})`);
    }

    async getHistory(serverId, historyAdapter, stateId, options) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Getting history for ${stateId} from ${historyAdapter} on ${serverId}`);
            this.log.debug(`History options: ${JSON.stringify(options)}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('sendTo', historyAdapter, 'getHistory', {
                        id: stateId,
                        options: options
                    }, (result) => {
                        if (result && result.error) {
                            reject(new Error(`History query failed: ${result.error}`));
                        } else if (result && result.result) {
                            const dataPoints = Array.isArray(result.result) ? result.result.length : 0;
                            this.log.info(`Retrieved ${dataPoints} history data points for ${stateId}`);
                            resolve(result.result);
                        } else {
                            this.log.info(`No history data returned for ${stateId}`);
                            resolve(result || []);
                        }
                    });
                }),
                30000,
                'History query timeout'
            );
        }, `getHistory(${stateId})`);
    }

    async subscribe(serverId, stateIdOrPattern, callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Subscribing to ${stateIdOrPattern} on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('subscribe', stateIdOrPattern, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            this.log.debug(`Successfully subscribed to ${stateIdOrPattern} on ${serverId}`);
                            resolve();
                        }
                    });
                }),
                5000,
                `Subscribe timeout for ${stateIdOrPattern}`
            );
        }, `subscribe(${stateIdOrPattern})`);
    }

    async unsubscribe(serverId, stateIdOrPattern) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                return;
            }

            this.log.debug(`Unsubscribing from ${stateIdOrPattern} on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('unsubscribe', stateIdOrPattern, () => {
                        this.log.debug(`Unsubscribed from ${stateIdOrPattern} on ${serverId}`);
                        resolve();
                    });
                }),
                3000,
                `Unsubscribe timeout for ${stateIdOrPattern}`
            );
        }, `unsubscribe(${stateIdOrPattern})`);
    }

    async subscribeObjects(serverId, objectIdOrPattern, callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Subscribing to objects ${objectIdOrPattern} on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('subscribeObjects', objectIdOrPattern, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            this.log.debug(`Successfully subscribed to objects ${objectIdOrPattern} on ${serverId}`);
                            resolve();
                        }
                    });
                }),
                5000,
                `Object subscribe timeout for ${objectIdOrPattern}`
            );
        }, `subscribeObjects(${objectIdOrPattern})`);
    }

    async unsubscribeObjects(serverId, objectIdOrPattern) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                return;
            }

            this.log.debug(`Unsubscribing from objects ${objectIdOrPattern} on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('unsubscribeObjects', objectIdOrPattern, () => {
                        this.log.debug(`Unsubscribed from objects ${objectIdOrPattern} on ${serverId}`);
                        resolve();
                    });
                }),
                3000,
                `Unsubscribe objects timeout for ${objectIdOrPattern}`
            );
        }, `unsubscribeObjects(${objectIdOrPattern})`);
    }

    async subscribeToLogs(serverId, logLevel = 'info', callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`Subscribing to live logs (level: ${logLevel}) on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('requireLog', true, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            if (!client.handlers['log'] || client.handlers['log'].length === 0) {
                                client.on('log', callback);
                            }
                            this.log.debug(`Successfully subscribed to live logs on ${serverId}`);
                            resolve();
                        }
                    });
                }),
                5000,
                `Log subscribe timeout for level ${logLevel}`
            );
        }, `subscribeToLogs(${logLevel})`);
    }

    async unsubscribeFromLogs(serverId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                return;
            }

            this.log.debug(`Unsubscribing from live logs on ${serverId}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('requireLog', false, () => {
                        if (client.handlers['log']) {
                            client.handlers['log'] = [];
                        }
                        this.log.debug(`Unsubscribed from live logs on ${serverId}`);
                        resolve();
                    });
                }),
                3000,
                'Unsubscribe from logs timeout'
            );
        }, `unsubscribeFromLogs`);
    }

    getQueueStatus(serverId) {
        return this.queueProcessor.getQueueStatus(serverId);
    }

    async sendToAdapter(serverId, adapter, command, message, timeout = 10000) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            if (timeout === null) {
                // Fire-and-forget mode
                this.log.info(`Sending fire-and-forget command to ${adapter}${command ? `.${command}` : ''} on ${serverId}`);
            } else {
                // With response mode
                this.log.info(`Sending command to ${adapter}${command ? `.${command}` : ''} on ${serverId} (waiting for response)`);
            }

            return new Promise((resolve, reject) => {
                if (timeout === null) {
                    try {
                        if (command && command.trim()) {
                            client.emit('sendTo', adapter, command, message);
                            this.log.debug(`Fire-and-forget sendTo: ${adapter}.${command}`);
                        } else {
                            client.emit('sendTo', adapter, message);
                            this.log.debug(`Fire-and-forget sendTo: ${adapter} (no command)`);
                        }
                        resolve(null);
                    } catch (error) {
                        reject(error);
                    }
                } else {
                    const timeoutHandle = setTimeout(() => {
                        reject(new Error(`SendTo timeout after ${timeout}ms`));
                    }, timeout);

                    const callback = (result) => {
                        clearTimeout(timeoutHandle);
                        this.log.info(`SendTo response received from ${adapter}${command ? `.${command}` : ''}`);
                        this.log.debug(`SendTo response: ${JSON.stringify(result).substring(0, 200)}`);
                        resolve(result);
                    };

                    try {
                        if (command && command.trim()) {
                            client.emit('sendTo', adapter, command, message, callback);
                            this.log.debug(`SendTo with response: ${adapter}.${command} - waiting for response`);
                        } else {
                            client.emit('sendTo', adapter, message, callback);
                            this.log.debug(`SendTo with response: ${adapter} (no command) - waiting for response`);
                        }
                    } catch (error) {
                        clearTimeout(timeoutHandle);
                        reject(error);
                    }
                }
            });
        }, `sendTo(${adapter}${command ? `, ${command}` : ''})`);
    }

    cleanupServer(serverId) {
        this.log.debug(`Cleaning up operation queues for ${serverId}`);
        this.queueProcessor.clearQueue(serverId, new Error('Server cleanup'));
        this.queueProcessors.delete(serverId);
    }

    cleanup() {
        const cleanupHandler = ManagerHelpers.createCleanupHandler('OperationManager', [
            {
                name: 'Operation queues',
                cleanup: () => {
                    for (const [serverId] of this.operationQueues) {
                        this.queueProcessor.clearQueue(serverId, new Error('Manager cleanup'));
                    }
                    this.operationQueues.clear();
                }
            },
            {
                name: 'Queue processors',
                cleanup: () => {
                    this.queueProcessors.clear();
                }
            }
        ]);

        cleanupHandler();
    }
}

module.exports = OperationManager;