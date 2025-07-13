/*!
 * Recovery Manager for ioBroker Node-RED Integration
 * Handles connection recovery, retry logic, and failure recovery
 */

const { CONNECTION_STATES } = require('./connection-manager');
const { Logger } = require('../utils/logger');
const { ErrorClassifier } = require('../utils/error-classifier');

class RecoveryManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.retryTimers = new Map();
        this.nodeCounters = new Map();
        this.retryLocks = new Map();
        this.retryAttempts = new Map();
        this.backoffTimers = new Map();

        this.onConnectionReady = null;
        this.onRecoveryCallback = null;

        this.log = new Logger('RecoveryManager');
    }

    incrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        this.nodeCounters.set(serverId, current + 1);
        this.log.debug(`Node count for ${serverId}: ${current + 1}`);
        return current + 1;
    }

    decrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        const newCount = Math.max(0, current - 1);
        this.nodeCounters.set(serverId, newCount);
        this.log.debug(`Node count for ${serverId}: ${newCount}`);

        if (newCount === 0) {
            this.log.info(`No nodes left for ${serverId}, cleaning up recovery`);
            this.cleanupServerRecovery(serverId);
        }

        return newCount;
    }

    getNodeCount(serverId) {
        return this.nodeCounters.get(serverId) || 0;
    }

    isRetryInProgress(serverId) {
        return this.retryLocks.has(serverId);
    }

    markRetryInProgress(serverId) {
        this.retryLocks.set(serverId, {
            startTime: Date.now(),
            type: 'normal'
        });
    }

    clearRetryLock(serverId) {
        this.retryLocks.delete(serverId);
    }

    clearAllTimersForServer(serverId) {
        const timer = this.retryTimers.get(serverId);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(serverId);
            this.log.debug(`Cleared retry timer for ${serverId}`);
        }

        const backoffTimer = this.backoffTimers.get(serverId);
        if (backoffTimer) {
            clearTimeout(backoffTimer);
            this.backoffTimers.delete(serverId);
            this.log.debug(`Cleared backoff timer for ${serverId}`);
        }
    }

    scheduleRetry(serverId, isImmediate = false) {
        if (this.isRetryInProgress(serverId)) {
            this.log.debug(`Retry already in progress for ${serverId}, skipping duplicate`);
            return;
        }

        const currentNodes = this.getNodeCount(serverId);
        if (currentNodes === 0) {
            this.log.debug(`No nodes left for ${serverId}, not scheduling retry`);
            return;
        }

        this.clearAllTimersForServer(serverId);

        const attempts = this.retryAttempts.get(serverId) || 0;
        const baseDelay = isImmediate ? 500 : 6000;
        const backoffDelay = Math.min(baseDelay * Math.pow(1.5, attempts), 60000);
        const jitterDelay = backoffDelay + (Math.random() * 2000);

        this.log.info(`Scheduling ${isImmediate ? 'immediate' : 'normal'} retry for ${serverId} in ${Math.round(jitterDelay / 1000)}s (attempt ${attempts + 1})`);

        this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        this.markRetryInProgress(serverId);

        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);

            if (this.getNodeCount(serverId) === 0) {
                this.log.debug(`No nodes left for ${serverId} at retry execution time`);
                this.clearRetryLock(serverId);
                return;
            }

            const currentState = this.connectionManager.getConnectionState(serverId);
            if (currentState !== CONNECTION_STATES.RETRY_SCHEDULED) {
                this.log.debug(`State changed for ${serverId} (now ${currentState}), aborting retry`);
                this.clearRetryLock(serverId);
                return;
            }

            await this.executeRetry(serverId);

        }, jitterDelay);

        this.retryTimers.set(serverId, timer);
        this.retryAttempts.set(serverId, attempts + 1);
    }

    async executeRetry(serverId) {
        try {
            this.log.info(`Executing scheduled retry for ${serverId}`);

            const client = await this.connectionManager.attemptReconnection(serverId);

            if (client) {
                const isReady = await this.waitForClientReady(client, serverId);

                if (isReady) {
                    this.retryAttempts.set(serverId, 0);
                    this.clearAllTimersForServer(serverId);
                    this.handleConnectionSuccess(serverId, client);
                } else {
                    this.log.warn(`Retry for ${serverId} completed but client not ready after timeout`);
                    this.handleRetryFailure(serverId, new Error('Client not ready after timeout'));
                }
            } else {
                this.handleRetryFailure(serverId, new Error('No client returned from reconnection'));
            }

        } catch (error) {
            this.log.error(`Scheduled retry failed for ${serverId}: ${error.message}`);
            this.handleRetryFailure(serverId, error);

        } finally {
            this.clearRetryLock(serverId);
        }
    }

    async waitForClientReady(client, serverId, timeout = 5000) {
        if (!client || !client.isClientReady) {
            return false;
        }

        if (client.isClientReady()) {
            this.log.debug(`Client ready immediately for ${serverId}`);
            return true;
        }

        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (client.isClientReady()) {
                const waitTime = Date.now() - startTime;
                this.log.debug(`Client ready for ${serverId} after ${waitTime}ms`);
                return true;
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.log.warn(`Client not ready for ${serverId} after ${timeout}ms timeout`);
        return false;
    }

    handleRetryFailure(serverId, error) {
        if (ErrorClassifier.isRetryableError(error.message)) {
            const attempts = this.retryAttempts.get(serverId) || 0;

            if (attempts < 10) {
                this.log.debug(`Will schedule next retry for ${serverId} due to retryable error (attempt ${attempts})`);

                const backoffTimer = setTimeout(() => {
                    this.backoffTimers.delete(serverId);
                    if (this.getNodeCount(serverId) > 0) {
                        this.scheduleRetry(serverId, false);
                    }
                }, 1000 * (attempts + 1));

                this.backoffTimers.set(serverId, backoffTimer);
            } else {
                this.log.error(`Maximum retry attempts reached for ${serverId}, giving up`);
                this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
                this.clearAllTimersForServer(serverId);
            }
        } else {
            this.log.error(`Non-retryable error for ${serverId}, stopping retries`);
            this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            this.clearAllTimersForServer(serverId);
        }
    }

    scheduleImmediateRetry(serverId) {
        this.scheduleRetry(serverId, true);
    }

    cancelRetry(serverId) {
        this.clearAllTimersForServer(serverId);
        this.clearRetryLock(serverId);
        this.log.debug(`Cancelled all retry operations for ${serverId}`);
    }

    handleConnectionError(serverId, error) {
        const errorMsg = error.message || error.toString();
        this.log.error(`Handling connection error for ${serverId}: ${errorMsg}`);

        if (ErrorClassifier.isAuthenticationError(errorMsg)) {
            this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            this.log.error(`Authentication failed permanently for ${serverId}`);
            this.clearAllTimersForServer(serverId);
            this.clearRetryLock(serverId);
        } else if (ErrorClassifier.isNetworkError(errorMsg)) {
            this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);

            if (ErrorClassifier.isRetryableError(errorMsg)) {
                this.log.info(`Scheduling retry for ${serverId} due to retryable network error`);
                this.scheduleRetry(serverId);
            }
        } else {
            this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);

            if (ErrorClassifier.isRetryableError(errorMsg)) {
                this.log.info(`Scheduling retry for ${serverId} due to retryable error`);
                this.scheduleRetry(serverId);
            }
        }
    }

    handleConnectionSuccess(serverId, client) {
        this.log.info(`Connection recovered successfully for ${serverId}`);

        this.retryAttempts.set(serverId, 0);
        this.clearAllTimersForServer(serverId);
        this.clearRetryLock(serverId);

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
        const hasBackoffTimer = this.backoffTimers.has(serverId);
        const nodeCount = this.getNodeCount(serverId);
        const isInProgress = this.isRetryInProgress(serverId);
        const attempts = this.retryAttempts.get(serverId) || 0;

        return {
            retryScheduled: hasTimer,
            hasBackoffTimer: hasBackoffTimer,
            nodeCount: nodeCount,
            active: hasTimer || isInProgress || hasBackoffTimer,
            inProgress: isInProgress,
            attempts: attempts
        };
    }

    cleanupServerRecovery(serverId) {
        this.log.debug(`Cleaning up recovery for ${serverId}`);

        this.clearAllTimersForServer(serverId);
        this.clearRetryLock(serverId);
        this.nodeCounters.delete(serverId);
        this.retryAttempts.delete(serverId);
    }

    cleanup() {
        this.log.info('RecoveryManager cleanup started');

        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();

        for (const timer of this.backoffTimers.values()) {
            clearTimeout(timer);
        }
        this.backoffTimers.clear();
        this.retryLocks.clear();
        this.nodeCounters.clear();
        this.retryAttempts.clear();

        this.log.info('RecoveryManager cleanup completed');
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

        for (const timer of this.backoffTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.backoffTimers.clear();
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
        if (this.retryLocks instanceof Map) {
            this.retryLocks.clear();
        }
        if (this.retryAttempts instanceof Map) {
            this.retryAttempts.clear();
        }
        if (this.backoffTimers instanceof Map) {
            this.backoffTimers.clear();
        }
    }

    nullifyReferences() {
        this.connectionManager = null;
        this.retryTimers = null;
        this.nodeCounters = null;
        this.retryLocks = null;
        this.retryAttempts = null;
        this.backoffTimers = null;
        this.onConnectionReady = null;
        this.onRecoveryCallback = null;
    }
}

module.exports = RecoveryManager;