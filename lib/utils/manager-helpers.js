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
     * Standard error handling with retryable error detection
     */
    static handleConnectionError(serverId, error, errorClassifier, setConnectionState, CONNECTION_STATES) {
        const errorMsg = error.message || error.toString();
        
        if (errorClassifier.isAuthenticationError(errorMsg)) {
            setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
        } else if (errorClassifier.isNetworkError(errorMsg)) {
            setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        } else {
            setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        }
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
     * Standard subscription management pattern
     */
    static createSubscriptionManager(subscriptions, callbacks, log, type = 'subscription') {
        return {
            add: (pattern, nodeId, callback) => {
                if (!subscriptions.has(pattern)) {
                    subscriptions.set(pattern, new Set());
                }
                subscriptions.get(pattern).add(nodeId);
                callbacks.set(nodeId, callback);
                log.debug(`Added ${type} for node ${nodeId} to pattern ${pattern}`);
            },

            remove: (pattern, nodeId) => {
                const nodeIds = subscriptions.get(pattern);
                if (nodeIds) {
                    nodeIds.delete(nodeId);
                    if (nodeIds.size === 0) {
                        subscriptions.delete(pattern);
                        log.debug(`Removed empty ${type} pattern: ${pattern}`);
                    }
                }
                callbacks.delete(nodeId);
                log.debug(`Removed ${type} for node ${nodeId} from pattern ${pattern}`);
            },

            getMatchingNodes: (itemId, patternMatcher) => {
                const matchingNodeIds = new Set();
                
                subscriptions.forEach((nodeIds, pattern) => {
                    if (patternMatcher.matches(itemId, pattern)) {
                        nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
                    }
                });

                return matchingNodeIds;
            },

            clear: () => {
                const subscriptionCount = subscriptions.size;
                const callbackCount = callbacks.size;
                subscriptions.clear();
                callbacks.clear();
                log.info(`Cleared ${subscriptionCount} ${type} patterns and ${callbackCount} callbacks`);
            },

            getStats: () => {
                return {
                    patterns: subscriptions.size,
                    totalNodes: callbacks.size,
                    patternDetails: Array.from(subscriptions.entries()).map(([pattern, nodeIds]) => ({
                        pattern,
                        nodeCount: nodeIds.size
                    }))
                };
            }
        };
    }

    /**
     * Standard connection state management
     */
    static createConnectionStateManager(connectionStates, log, statusChangeCallback) {
        return {
            getState: (serverId) => {
                return connectionStates.get(serverId) || 'idle';
            },

            setState: (serverId, state) => {
                const oldState = connectionStates.get(serverId);
                connectionStates.set(serverId, state);

                if (oldState !== state) {
                    log.info(`Connection state changed for ${serverId}: ${oldState || 'undefined'} -> ${state}`);

                    if (statusChangeCallback) {
                        setTimeout(() => {
                            statusChangeCallback(serverId, state);
                        }, 0);
                    }
                }
            },

            mapStateToNodeStatus: (connectionState) => {
                switch (connectionState) {
                    case 'idle': return 'disconnected';
                    case 'connecting': return 'connecting';
                    case 'connected': return 'ready';
                    case 'auth_failed': return 'failed_permanently';
                    case 'network_error': return 'retrying';
                    case 'retry_scheduled': return 'retrying';
                    case 'destroying': return 'disconnected';
                    default: return 'disconnected';
                }
            },

            clear: () => {
                const stateCount = connectionStates.size;
                connectionStates.clear();
                log.info(`Cleared ${stateCount} connection states`);
            }
        };
    }

    /**
     * Standard retry management pattern
     */
    static createRetryManager(retryTimers, nodeCounters, log) {
        return {
            scheduleRetry: (serverId, retryFunction, delay = 5000) => {
                const existingTimer = retryTimers.get(serverId);
                if (existingTimer) {
                    clearTimeout(existingTimer);
                }

                const remainingNodes = nodeCounters.get(serverId) || 0;
                if (remainingNodes === 0) {
                    log.debug(`No nodes left for ${serverId}, not scheduling retry`);
                    return;
                }

                const actualDelay = delay + (Math.random() * 2000);
                log.info(`Scheduling retry for ${serverId} in ${Math.round(actualDelay/1000)}s`);

                const timer = setTimeout(async () => {
                    retryTimers.delete(serverId);
                    
                    if ((nodeCounters.get(serverId) || 0) > 0) {
                        log.info(`Executing scheduled retry for ${serverId}`);
                        
                        try {
                            await retryFunction(serverId);
                        } catch (error) {
                            log.error(`Scheduled retry failed for ${serverId}: ${error.message}`);
                        }
                    }
                }, actualDelay);

                retryTimers.set(serverId, timer);
            },

            cancelRetry: (serverId) => {
                const timer = retryTimers.get(serverId);
                if (timer) {
                    clearTimeout(timer);
                    retryTimers.delete(serverId);
                    log.debug(`Cancelled scheduled retry for ${serverId}`);
                }
            },

            incrementNodeCount: (serverId) => {
                const current = nodeCounters.get(serverId) || 0;
                nodeCounters.set(serverId, current + 1);
                log.debug(`Node count for ${serverId}: ${current + 1}`);
            },

            decrementNodeCount: (serverId) => {
                const current = nodeCounters.get(serverId) || 0;
                const newCount = Math.max(0, current - 1);
                nodeCounters.set(serverId, newCount);
                log.debug(`Node count for ${serverId}: ${newCount}`);
                return newCount;
            },

            cleanup: () => {
                for (const timer of retryTimers.values()) {
                    clearTimeout(timer);
                }
                retryTimers.clear();
                nodeCounters.clear();
                log.info('Retry manager cleanup completed');
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

            createTimeoutPromise: (timeout, errorMessage) => {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        reject(new Error(errorMessage));
                    }, timeout);

                    return {
                        promise: new Promise((res, rej) => {
                            resolve = res;
                            reject = rej;
                        }),
                        clear: () => clearTimeout(timer),
                        resolve,
                        reject
                    };
                });
            }
        };
    }

    /**
     * Standard async operation executor with error handling
     */
    static createOperationExecutor(connectionManager, log) {
        return {
            executeOperation: async (serverId, operation, operationName = 'operation') => {
                try {
                    log.debug(`Executing ${operationName} for ${serverId}`);
                    const result = await operation();
                    log.debug(`${operationName} completed for ${serverId}`);
                    return result;
                } catch (error) {
                    log.error(`${operationName} failed for ${serverId}: ${error.message}`);
                    throw error;
                }
            },

            withRetry: async (operation, maxRetries = 3, delay = 1000) => {
                let lastError;
                
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        return await operation();
                    } catch (error) {
                        lastError = error;
                        
                        if (attempt < maxRetries) {
                            log.debug(`Operation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${error.message}`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                            delay *= 2; // Exponential backoff
                        }
                    }
                }
                
                throw lastError;
            }
        };
    }
}

module.exports = {
    ManagerHelpers
};