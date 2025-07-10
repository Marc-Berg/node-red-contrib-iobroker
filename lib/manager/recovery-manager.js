/*!
 * Recovery Manager for ioBroker Node-RED Integration
 * Handles connection recovery, retry logic, and failure recovery
 */

const { CONNECTION_STATES } = require('./connection-manager');
const { Logger } = require('../utils/logger');
const { ErrorClassifier } = require('../utils/error-classifier');
const { ManagerHelpers } = require('../utils/manager-helpers');

class RecoveryManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.retryTimers = new Map();
        this.nodeCounters = new Map();

        this.onConnectionReady = null;
        this.onRecoveryCallback = null;

        this.log = new Logger('RecoveryManager');

        this.retryManager = ManagerHelpers.createRetryManager(
            this.retryTimers,
            this.nodeCounters,
            this.log
        );
    }

    incrementNodeCount(serverId) {
        return this.retryManager.incrementNodeCount(serverId);
    }

    decrementNodeCount(serverId) {
        const newCount = this.retryManager.decrementNodeCount(serverId);

        if (newCount === 0) {
            this.log.info(`No nodes left for ${serverId}, cleaning up recovery`);
            this.cleanupServerRecovery(serverId);
        }

        return newCount;
    }

    getNodeCount(serverId) {
        return this.nodeCounters.get(serverId) || 0;
    }

    scheduleRetry(serverId) {
        const retryFunction = async (serverId) => {
            const currentNodes = this.getNodeCount(serverId);

            if (currentNodes > 0 && this.connectionManager.getConnectionState(serverId) === CONNECTION_STATES.RETRY_SCHEDULED) {
                this.log.info(`Executing scheduled retry for ${serverId}`);

                try {
                    const client = await this.connectionManager.attemptReconnection(serverId);
                    if (client && client.isClientReady && client.isClientReady()) {
                        this.handleConnectionSuccess(serverId, client);
                    }
                } catch (error) {
                    this.log.error(`Scheduled retry failed for ${serverId}: ${error.message}`);

                    if (ErrorClassifier.isRetryableError(error.message)) {
                        this.log.debug(`Scheduling another retry for ${serverId} due to retryable error`);
                        setTimeout(() => {
                            if (this.getNodeCount(serverId) > 0) {
                                this.scheduleRetry(serverId);
                            }
                        }, 10000);
                    }
                }
            }
        };
        this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        this.retryManager.scheduleRetry(serverId, retryFunction);
    }

    scheduleImmediateRetry(serverId) {
        const retryFunction = async (serverId) => {
            this.log.info(`Executing immediate retry for ${serverId}`);
            try {
                const client = await this.connectionManager.attemptReconnection(serverId);
                if (client && client.isClientReady && client.isClientReady()) {
                    this.handleConnectionSuccess(serverId, client);
                }
            } catch (error) {
                this.log.debug(`Immediate retry failed for ${serverId}, scheduling normal retry: ${error.message}`);
                this.scheduleRetry(serverId);
            }
        };
        this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        this.log.info(`Scheduling immediate retry for ${serverId}`);
        this.retryManager.scheduleRetry(serverId, retryFunction, 100);
    }

    cancelRetry(serverId) {
        this.log.debug(`Cancelling retry timer for ${serverId}`);
        this.retryManager.cancelRetry(serverId);
    }

    handleConnectionError(serverId, error) {
        const errorMsg = error.message || error.toString();
        this.log.error(`Handling connection error for ${serverId}: ${errorMsg}`);

        ManagerHelpers.handleConnectionError(
            serverId,
            error,
            ErrorClassifier,
            (serverId, state) => this.connectionManager.setConnectionState(serverId, state),
            CONNECTION_STATES
        );

        if (ErrorClassifier.isRetryableError(errorMsg)) {
            this.log.info(`Scheduling retry for ${serverId} due to retryable error`);
            this.scheduleRetry(serverId);
        } else {
            this.log.error(`Non-retryable error for ${serverId}, not scheduling retry`);
        }
    }

    handleConnectionSuccess(serverId, client) {
        this.log.info(`Connection recovered successfully for ${serverId}`);

        this.cancelRetry(serverId);

        if (this.onConnectionReady) {
            this.log.debug(`Notifying connection ready handlers for ${serverId}`);
            this.onConnectionReady(serverId, client);
        }

        if (this.onRecoveryCallback) {
            this.log.debug(`Executing recovery callbacks for ${serverId}`);
            this.onRecoveryCallback(serverId);
        }
    }

    getRecoveryStatus(serverId) {
        const hasTimer = this.retryTimers.has(serverId);
        const nodeCount = this.getNodeCount(serverId);

        return {
            retryScheduled: hasTimer,
            nodeCount: nodeCount,
            active: hasTimer
        };
    }

    cleanupServerRecovery(serverId) {
        this.log.debug(`Cleaning up recovery for ${serverId}`);

        this.cancelRetry(serverId);
        this.nodeCounters.delete(serverId);
    }

    cleanup() {
        const cleanupHandler = ManagerHelpers.createCleanupHandler('RecoveryManager', [
            {
                name: 'Retry timers',
                cleanup: () => {
                    for (const timer of this.retryTimers.values()) {
                        clearTimeout(timer);
                    }
                    this.retryTimers.clear();
                }
            },
            {
                name: 'Node counters',
                cleanup: () => {
                    this.nodeCounters.clear();
                }
            }
        ]);

        cleanupHandler();
    }

    destroy() {
        this.log.debug(`Destroying RecoveryManager`);

        this.destroyed = true;

        this.cleanup();
        this.clearAllTimers();
        this.removeAllEventListeners();
        this.clearAllCollections();
        this.nullifyReferences();

        this.log.debug(`RecoveryManager destroyed completely`);
    }

    clearAllTimers() {
        for (const timer of this.retryTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.retryTimers.clear();
    }

    removeAllEventListeners() {
        this.onConnectionReady = null;
        this.onRecoveryCallback = null;
    }

    clearAllCollections() {
        if (this.retryTimers instanceof Map) {
            this.retryTimers.clear();
        }
        if (this.nodeCounters instanceof Map) {
            this.nodeCounters.clear();
        }
    }

    nullifyReferences() {
        this.connectionManager = null;
        this.retryTimers = null;
        this.nodeCounters = null;
        this.onConnectionReady = null;
        this.onRecoveryCallback = null;
        this.retryManager = null;
    }
}

module.exports = RecoveryManager;