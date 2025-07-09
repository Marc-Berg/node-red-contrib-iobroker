/*!
 * Operation Manager for ioBroker Node-RED Integration
 * Handles state and object operations with queueing and type filtering
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

    async executeOperation(serverId, operation, operationName = 'operation') {
        if (this.connectionManager.isConnectionReady(serverId)) {
            return await this.operationExecutor.executeOperation(serverId, operation, operationName);
        }

        const state = this.connectionManager.getConnectionState(serverId);

        if (state === CONNECTION_STATES.CONNECTING) {
            this.log.debug(`Queueing ${operationName} for ${serverId} - connection in progress`);
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
            return await client.getState(stateId);
        }, `getState(${stateId})`);
    }

    async setState(serverId, stateId, value, ack = true) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
                const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };

                client.emit('setState', stateId, state, (err) => {
                    clearTimeout(timeout);
                    if (err) {
                        reject(new Error(err));
                    } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('getStates', '*', (err, states) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('getObject', objectId, (err, obj) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
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

            this.log.debug(`getObjects called with pattern: ${pattern}, objectType: ${objectType}`);

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    if (pattern && pattern.includes('*')) {
                        client.emit('getObjects', (err, result) => {
                            if (!err && result && typeof result === 'object') {
                                const objects = this.filterObjectsByPattern(result, pattern, objectType);
                                this.log.debug(`Method 1 (getObjects + filter): Found ${objects.length} objects for pattern: ${pattern}${objectType ? ` (type: ${objectType})` : ''}`);
                                resolve(objects);
                                return;
                            }

                            client.emit('getForeignObjects', pattern, (err2, result2) => {
                                if (err2) {
                                    reject(new Error(`All methods failed for pattern: ${pattern}. Errors: ${err} | ${err2}`));
                                } else {
                                    const objects = this.filterObjectsByType(result2 || {}, objectType);
                                    this.log.debug(`Method 2 (getForeignObjects + filter): Found ${objects.length} objects for pattern: ${pattern}${objectType ? ` (type: ${objectType})` : ''}`);
                                    resolve(objects);
                                }
                            });
                        });
                    } else {
                        client.emit('getObject', pattern, (err, obj) => {
                            if (err) {
                                reject(new Error(err));
                            } else {
                                let result = obj ? [obj] : [];

                                if (objectType && obj && obj.type !== objectType) {
                                    result = [];
                                    this.log.debug(`Single object ${pattern} filtered out: found type '${obj.type}', wanted '${objectType}'`);
                                } else if (obj) {
                                    this.log.debug(`Single object ${pattern} matches: type '${obj.type}'${objectType ? ` (filter: ${objectType})` : ''}`);
                                }

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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('setObject', objectId, objectDef, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('sendTo', historyAdapter, 'getHistory', {
                        id: stateId,
                        options: options
                    }, (result) => {
                        if (result && result.error) {
                            reject(new Error(`History query failed: ${result.error}`));
                        } else if (result && result.result) {
                            resolve(result.result);
                        } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('subscribe', stateIdOrPattern, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('unsubscribe', stateIdOrPattern, () => {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('subscribeObjects', objectIdOrPattern, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('unsubscribeObjects', objectIdOrPattern, () => {
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve, reject) => {
                    client.emit('requireLog', true, (err) => {
                        if (err) {
                            reject(new Error(err));
                        } else {
                            if (!client.handlers['log'] || client.handlers['log'].length === 0) {
                                client.on('log', callback);
                            }
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

            return this.timeoutHandler.withTimeout(
                new Promise((resolve) => {
                    client.emit('requireLog', false, () => {
                        if (client.handlers['log']) {
                            client.handlers['log'] = [];
                        }
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
                        this.log.debug(`SendTo response received from ${adapter}: ${JSON.stringify(result).substring(0, 200)}`);
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