/*!
 * Manager Helper Functions for ioBroker Node-RED Integration
 * Shared utilities for Manager classes to reduce code duplication
 */

const { Logger } = require('./logger');

class ManagerHelpers {
    /**
     * Create standardized cleanup functionality
     */
    static createCleanupHandler(managerName, cleanupItems = []) {
        return function() {
            const log = new Logger(managerName);
            log.info(`${managerName} cleanup started`);

            cleanupItems.forEach(({ name, cleanup }) => {
                try {
                    cleanup();
                    log.debug(`${name} cleanup completed`);
                } catch (error) {
                    log.error(`${name} cleanup error: ${error.message}`);
                }
            });

            log.info(`${managerName} cleanup completed`);
        };
    }

    /**
     * Standard queue operation pattern
     */
    static createQueueProcessor(operationQueues, queueProcessors, log) {
        return {
            enqueue: (serverId, operation, operationName = 'operation', timeout = 10000) => {
                if (!operationQueues.has(serverId)) {
                    operationQueues.set(serverId, []);
                }

                const queue = operationQueues.get(serverId);
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

                    setTimeout(() => {
                        const index = queue.indexOf(queueItem);
                        if (index !== -1) {
                            queue.splice(index, 1);
                            reject(new Error(`Operation ${operationName} timeout after ${timeout}ms in queue`));
                        }
                    }, timeout);
                });

                queue.push(queueItem);
                log.debug(`Queued ${operationName} for ${serverId} (queue size: ${queue.length})`);

                return queueItem.promise;
            },

            processQueue: (serverId) => {
                const queue = operationQueues.get(serverId);
                if (!queue || queue.length === 0) {
                    return;
                }

                log.info(`Processing ${queue.length} queued operations for ${serverId}`);

                const operationsToProcess = [...queue];
                operationQueues.set(serverId, []);

                operationsToProcess.forEach((queueItem, index) => {
                    setTimeout(async () => {
                        try {
                            const result = await queueItem.operation();
                            queueItem.resolve(result);
                        } catch (error) {
                            log.error(`Queued operation ${queueItem.operationName} failed: ${error.message}`);
                            queueItem.reject(error);
                        }
                    }, index * 50);
                });
            },

            clearQueue: (serverId, error) => {
                const queue = operationQueues.get(serverId);
                if (!queue || queue.length === 0) {
                    return;
                }

                log.info(`Clearing ${queue.length} queued operations for ${serverId} due to: ${error.message}`);

                queue.forEach(queueItem => {
                    queueItem.reject(error);
                });

                operationQueues.set(serverId, []);
            },

            getQueueStatus: (serverId) => {
                const queue = operationQueues.get(serverId);
                return {
                    queuedOperations: queue ? queue.length : 0,
                    operations: queue ? queue.map(item => ({
                        name: item.operationName,
                        timestamp: item.timestamp,
                        age: Date.now() - item.timestamp
                    })) : []
                };
            }
        };
    }

    /**
     * Standard timeout handling pattern
     */
    static createTimeoutHandler(defaultTimeout = 10000) {
        return {
            withTimeout: (promise, timeout = defaultTimeout, errorMessage = 'Operation timeout') => {
                return Promise.race([
                    promise,
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error(errorMessage)), timeout);
                    })
                ]);
            },

        };
    }
}

module.exports = {
    ManagerHelpers
};