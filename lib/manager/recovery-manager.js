/*!
 * Recovery Manager for ioBroker Node-RED Integration
 * Handles connection recovery, retry logic, and failure recovery
 */

const { CONNECTION_STATES } = require('./connection-manager');
const { Logger, ErrorClassifier } = require('../utils');

class RecoveryManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.retryTimers = new Map();
        this.nodeCounters = new Map();
        
        this.onConnectionReady = null;
        this.onRecoveryCallback = null;
        
        this.log = new Logger('RecoveryManager');
    }

    incrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        this.nodeCounters.set(serverId, current + 1);
        this.log.debug(`Node count for ${serverId}: ${current + 1}`);
    }

    decrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        const newCount = Math.max(0, current - 1);
        this.nodeCounters.set(serverId, newCount);
        
        if (newCount === 0) {
            this.log.info(`No nodes left for ${serverId}, cleaning up recovery`);
            this.cleanupServerRecovery(serverId);
        } else {
            this.log.debug(`Node count for ${serverId}: ${newCount}`);
        }
        
        return newCount;
    }

    getNodeCount(serverId) {
        return this.nodeCounters.get(serverId) || 0;
    }

    scheduleRetry(serverId) {
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const remainingNodes = this.getNodeCount(serverId);
        
        if (remainingNodes === 0) {
            this.log.debug(`No nodes left for ${serverId}, not scheduling retry`);
            return;
        }

        this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        
        const retryDelay = 5000 + (Math.random() * 2000);
        
        this.log.info(`Scheduling retry for ${serverId} in ${Math.round(retryDelay/1000)}s`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            
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
                        setTimeout(() => {
                            if (this.getNodeCount(serverId) > 0) {
                                this.scheduleRetry(serverId);
                            }
                        }, 10000);
                    }
                }
            }
        }, retryDelay);
        
        this.retryTimers.set(serverId, timer);
    }

    scheduleImmediateRetry(serverId) {
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        this.connectionManager.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        
        this.log.info(`Scheduling immediate retry for ${serverId}`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            
            try {
                const client = await this.connectionManager.attemptReconnection(serverId);
                if (client && client.isClientReady && client.isClientReady()) {
                    this.handleConnectionSuccess(serverId, client);
                }
            } catch (error) {
                this.scheduleRetry(serverId);
            }
        }, 100);
        
        this.retryTimers.set(serverId, timer);
    }

    cancelRetry(serverId) {
        const timer = this.retryTimers.get(serverId);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(serverId);
            this.log.debug(`Cancelled scheduled retry for ${serverId}`);
        }
    }

    handleConnectionError(serverId, error) {
        const errorMsg = error.message || error.toString();
        this.log.error(`Handling connection error for ${serverId}: ${errorMsg}`);
        
        if (ErrorClassifier.isRetryableError(errorMsg)) {
            this.scheduleRetry(serverId);
        } else {
            this.log.error(`Non-retryable error for ${serverId}, not scheduling retry`);
        }
    }

    handleConnectionSuccess(serverId, client) {
        this.log.info(`Connection recovered for ${serverId}`);
        
        this.cancelRetry(serverId);
        
        if (this.onConnectionReady) {
            this.onConnectionReady(serverId, client);
        }
        
        if (this.onRecoveryCallback) {
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
        this.log.info('Recovery Manager cleanup started');
        
        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();
        
        this.nodeCounters.clear();
        
        this.log.info('Recovery Manager cleanup completed');
    }
}

module.exports = RecoveryManager;