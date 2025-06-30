/*!
 * Operation Manager for ioBroker Node-RED Integration
 * Handles state and object operations with queueing and type filtering
 */

const { CONNECTION_STATES } = require('./connection-manager');

class OperationManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.operationQueues = new Map();      // serverId -> array of queued operations
        this.queueProcessors = new Map();      // serverId -> processing state

        // Callbacks for external managers
        this.onTriggerReconnection = null;

        this.log = this.createLogger('OperationManager');
    }

    createLogger(component) {
        return {
            info: (msg) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.log(`${day} ${month} ${time} - [info] [${component}] ${msg}`);
            },
            error: (msg) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.error(`${day} ${month} ${time} - [error] [${component}] ${msg}`);
            }
        };
    }

    // Operation queueing system
    queueOperation(serverId, operation, operationName = 'operation', timeout = 10000) {
        if (!this.operationQueues.has(serverId)) {
            this.operationQueues.set(serverId, []);
        }

        const queue = this.operationQueues.get(serverId);
        const queueItem = {
            operation,
            operationName,
            timestamp: Date.now(),
            timeout: timeout,
            promise: null
        };

        queueItem.promise = new Promise((resolve, reject) => {
            queueItem.resolve = resolve;
            queueItem.reject = reject;

            // Set timeout for queued operation
            setTimeout(() => {
                const index = queue.indexOf(queueItem);
                if (index !== -1) {
                    queue.splice(index, 1);
                    reject(new Error(`Operation ${operationName} timeout after ${timeout}ms in queue`));
                }
            }, timeout);
        });

        queue.push(queueItem);
        this.log.info(`Queued ${operationName} for ${serverId} (queue size: ${queue.length})`);

        return queueItem.promise;
    }

    processQueuedOperations(serverId) {
        const queue = this.operationQueues.get(serverId);
        if (!queue || queue.length === 0) {
            return;
        }

        this.log.info(`Processing ${queue.length} queued operations for ${serverId}`);

        // Process all queued operations
        const operationsToProcess = [...queue];
        this.operationQueues.set(serverId, []); // Clear queue

        // Process operations with slight delay between each
        operationsToProcess.forEach((queueItem, index) => {
            setTimeout(async () => {
                try {
                    const result = await queueItem.operation();
                    queueItem.resolve(result);
                } catch (error) {
                    this.log.error(`Queued operation ${queueItem.operationName} failed: ${error.message}`);
                    queueItem.reject(error);
                }
            }, index * 50); // 50ms delay between operations
        });
    }

    clearOperationQueue(serverId, error) {
        const queue = this.operationQueues.get(serverId);
        if (!queue || queue.length === 0) {
            return;
        }

        this.log.info(`Clearing ${queue.length} queued operations for ${serverId} due to: ${error.message}`);

        // Reject all queued operations
        queue.forEach(queueItem => {
            queueItem.reject(error);
        });

        this.operationQueues.set(serverId, []);
    }

    async executeOperation(serverId, operation, operationName = 'operation') {
        // Check if connection is ready
        if (this.connectionManager.isConnectionReady(serverId)) {
            return await operation();
        }

        const state = this.connectionManager.getConnectionState(serverId);

        // If connection is being established, queue the operation
        if (state === CONNECTION_STATES.CONNECTING) {
            this.log.info(`Queueing ${operationName} for ${serverId} - connection in progress`);
            return await this.queueOperation(serverId, operation, operationName);
        }

        // If in retry state, queue with longer timeout
        if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
            this.log.info(`Queueing ${operationName} for ${serverId} - connection retry in progress`);
            return await this.queueOperation(serverId, operation, operationName, 15000);
        }

        // If idle, trigger automatic reconnection if we have stored config
        if (state === CONNECTION_STATES.IDLE) {
            const storedConfig = this.connectionManager.getStoredConfig(serverId);
            if (storedConfig) {
                this.log.info(`Triggering automatic reconnection for ${serverId} due to ${operationName}`);
                // Start reconnection in background
                this.triggerReconnection(serverId);
                // Queue the operation
                this.log.info(`Queueing ${operationName} for ${serverId} - triggering reconnection`);
                return await this.queueOperation(serverId, operation, operationName, 15000);
            } else {
                this.log.info(`No stored config for ${serverId} - cannot auto-reconnect`);
                throw new Error(`No ready connection for ${serverId} and no stored config for auto-reconnect`);
            }
        }

        // For permanent failures, throw error immediately
        throw new Error(`No ready connection for ${serverId} (state: ${state})`);
    }

    triggerReconnection(serverId) {
        // Delegate to recovery manager via callback
        if (this.onTriggerReconnection) {
            this.onTriggerReconnection(serverId);
        }
    }

    // State operations
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

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Get states timeout')), 15000);

                client.emit('getStates', '*', (err, states) => {
                    clearTimeout(timeout);
                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve(states);
                    }
                });
            });
        }, 'getStates');
    }

    // Object operations
    async getObject(serverId, objectId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);

                client.emit('getObject', objectId, (err, obj) => {
                    clearTimeout(timeout);
                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve(obj);
                    }
                });
            });
        }, `getObject(${objectId})`);
    }

    // Simplified getObjects with reliable client-side type filtering
    async getObjects(serverId, pattern = '*', objectType = null) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            this.log.info(`getObjects called with pattern: ${pattern}, objectType: ${objectType}`);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Get objects timeout')), 25000);

                if (pattern && pattern.includes('*')) {
                    // Method 1: Try getObjects (Admin adapter) - always without type parameter
                    client.emit('getObjects', (err, result) => {
                        if (!err && result && typeof result === 'object') {
                            clearTimeout(timeout);
                            const objects = this.filterObjectsByPattern(result, pattern, objectType);
                            this.log.info(`Method 1 (getObjects + filter): Found ${objects.length} objects for pattern: ${pattern}${objectType ? ` (type: ${objectType})` : ''}`);
                            resolve(objects);
                            return;
                        }

                        // Method 2: Try getForeignObjects (WebSocket/Web adapters) - without type parameter
                        client.emit('getForeignObjects', pattern, (err2, result2) => {
                            clearTimeout(timeout);
                            if (err2) {
                                reject(new Error(`All methods failed for pattern: ${pattern}. Errors: ${err} | ${err2}`));
                            } else {
                                const objects = this.filterObjectsByType(result2 || {}, objectType);
                                this.log.info(`Method 2 (getForeignObjects + filter): Found ${objects.length} objects for pattern: ${pattern}${objectType ? ` (type: ${objectType})` : ''}`);
                                resolve(objects);
                            }
                        });
                    });
                } else {
                    // Single object retrieval
                    client.emit('getObject', pattern, (err, obj) => {
                        clearTimeout(timeout);
                        if (err) {
                            reject(new Error(err));
                        } else {
                            let result = obj ? [obj] : [];

                            // Apply type filter for single objects
                            if (objectType && obj && obj.type !== objectType) {
                                result = [];
                                this.log.info(`Single object ${pattern} filtered out: found type '${obj.type}', wanted '${objectType}'`);
                            } else if (obj) {
                                this.log.info(`Single object ${pattern} matches: type '${obj.type}'${objectType ? ` (filter: ${objectType})` : ''}`);
                            }

                            resolve(result);
                        }
                    });
                }
            });
        }, `getObjects(${pattern}${objectType ? `, type: ${objectType}` : ''})`);
    }

    // Helper method for filtering objects by pattern and type
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
                    // Apply type filter if specified
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
                this.log.info(`Pattern filtering: ${totalMatched} objects matched pattern, ${typeFiltered} filtered by type '${objectType}', ${objects.length} final results`);
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    // Helper method for filtering objects from getForeignObjects result
    filterObjectsByType(allObjects, objectType = null) {
        const objects = [];
        if (allObjects && typeof allObjects === 'object') {
            let totalObjects = 0;
            let typeFiltered = 0;

            for (const [objectId, objectData] of Object.entries(allObjects)) {
                if (objectData) {
                    totalObjects++;
                    // Apply type filter if specified
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
                this.log.info(`Type filtering: ${totalObjects} total objects, ${typeFiltered} filtered by type '${objectType}', ${objects.length} final results`);
            }
        }

        objects.sort((a, b) => (a._id || '').localeCompare(b._id || ''));
        return objects;
    }

    // Helper method for filtering objects by pattern (for Admin adapter)
    filterObjectsByPattern(allObjects, pattern, objectType = null) {
        const objects = [];
        if (allObjects && typeof allObjects === 'object') {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            const regex = new RegExp(`^${regexPattern}$`);

            for (const [objectId, objectData] of Object.entries(allObjects)) {
                if (objectData && regex.test(objectId)) {
                    // Apply type filter if specified
                    if (!objectType || objectData.type === objectType) {
                        objects.push({
                            _id: objectId,
                            ...objectData
                        });
                    }
                }
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

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Set object timeout')), 10000);

                client.emit('setObject', objectId, objectDef, (err) => {
                    clearTimeout(timeout);
                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve();
                    }
                });
            });
        }, `setObject(${objectId})`);
    }
    // History operations
    async getHistory(serverId, historyAdapter, stateId, options) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('History query timeout')), 30000);

                client.emit('sendTo', historyAdapter, 'getHistory', {
                    id: stateId,
                    options: options
                }, (result) => {
                    clearTimeout(timeout);

                    if (result && result.error) {
                        reject(new Error(`History query failed: ${result.error}`));
                    } else if (result && result.result) {
                        resolve(result.result);
                    } else {
                        // Some adapters return data directly
                        resolve(result || []);
                    }
                });
            });
        }, `getHistory(${stateId})`);
    }

    // Subscribe operation (special case)
    async subscribe(serverId, stateIdOrPattern, callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Subscribe timeout for ${stateIdOrPattern}`));
                }, 5000);

                client.emit('subscribe', stateIdOrPattern, (err) => {
                    clearTimeout(timeout);

                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve();
                    }
                });
            });
        }, `subscribe(${stateIdOrPattern})`);
    }

    async unsubscribe(serverId, stateIdOrPattern) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                // For unsubscribe, don't fail if connection is not ready
                return;
            }

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve(); // Don't fail on unsubscribe timeout
                }, 3000);

                client.emit('unsubscribe', stateIdOrPattern, () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }, `unsubscribe(${stateIdOrPattern})`);
    }

    // Object subscription operations
    async subscribeObjects(serverId, objectIdOrPattern, callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Object subscribe timeout for ${objectIdOrPattern}`));
                }, 5000);

                client.emit('subscribeObjects', objectIdOrPattern, (err) => {
                    clearTimeout(timeout);

                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve();
                    }
                });
            });
        }, `subscribeObjects(${objectIdOrPattern})`);
    }

    async unsubscribeObjects(serverId, objectIdOrPattern) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                // For unsubscribe, don't fail if connection is not ready
                return;
            }

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve(); // Don't fail on unsubscribe timeout
                }, 3000);

                client.emit('unsubscribeObjects', objectIdOrPattern, () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }, `unsubscribeObjects(${objectIdOrPattern})`);
    }

    // Log subscription operations
    async subscribeToLogs(serverId, logLevel = 'info', callback) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Log subscribe timeout for level ${logLevel}`));
                }, 5000);

                // Subscribe to logs with specified minimum level
                client.emit('requireLog', true, (err) => {
                    clearTimeout(timeout);

                    if (err) {
                        reject(new Error(err));
                    } else {
                        // Setup log event handler if not already done
                        if (!client.handlers['log'] || client.handlers['log'].length === 0) {
                            client.on('log', callback);
                        }
                        resolve();
                    }
                });
            });
        }, `subscribeToLogs(${logLevel})`);
    }

    async unsubscribeFromLogs(serverId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connectionManager.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                // For unsubscribe, don't fail if connection is not ready
                return;
            }

            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve(); // Don't fail on unsubscribe timeout
                }, 3000);

                client.emit('requireLog', false, () => {
                    clearTimeout(timeout);

                    // Remove log event handlers
                    if (client.handlers['log']) {
                        client.handlers['log'] = [];
                    }

                    resolve();
                });
            });
        }, `unsubscribeFromLogs`);
    }

    // Queue status
    getQueueStatus(serverId) {
        const queue = this.operationQueues.get(serverId);
        return {
            queuedOperations: queue ? queue.length : 0,
            operations: queue ? queue.map(item => ({
                name: item.operationName,
                timestamp: item.timestamp,
                age: Date.now() - item.timestamp
            })) : []
        };
    }

    // Cleanup for specific server
    cleanupServer(serverId) {
        this.clearOperationQueue(serverId, new Error('Server cleanup'));
        this.queueProcessors.delete(serverId);
    }

    // Full cleanup
    cleanup() {
        this.log.info('Operation Manager cleanup started');

        // Clear all operation queues
        for (const [serverId] of this.operationQueues) {
            this.clearOperationQueue(serverId, new Error('Manager cleanup'));
        }
        this.operationQueues.clear();
        this.queueProcessors.clear();

        this.log.info('Operation Manager cleanup completed');
    }
}

module.exports = OperationManager;