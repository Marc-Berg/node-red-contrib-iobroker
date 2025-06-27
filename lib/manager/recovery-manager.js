/*!
 * Recovery Manager for ioBroker Node-RED Integration
 * Handles connection recovery, retry logic, and failure recovery
 * FIXED VERSION with debug logs and proper error handling
 */

class RecoveryManager {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.retryTimers = new Map();           // serverId -> timer
        this.recoveryCallbacks = new Map();     // serverId -> Set<callback>
        this.nodeCounters = new Map();          // serverId -> number of nodes
        
        // Callbacks for external managers
        this.onConnectionReady = null;
        
        this.log = this.createLogger('RecoveryManager');
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

    // Node counting for determining when to stop retries
    incrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        this.nodeCounters.set(serverId, current + 1);
        this.log.info(`Node count for ${serverId}: ${current + 1}`);
    }

    decrementNodeCount(serverId) {
        const current = this.nodeCounters.get(serverId) || 0;
        const newCount = Math.max(0, current - 1);
        this.nodeCounters.set(serverId, newCount);
        
        if (newCount === 0) {
            this.log.info(`No nodes left for ${serverId}, cleaning up recovery`);
            this.cleanupServerRecovery(serverId);
        } else {
            this.log.info(`Node count for ${serverId}: ${newCount}`);
        }
        
        return newCount;
    }

    getNodeCount(serverId) {
        return this.nodeCounters.get(serverId) || 0;
    }

    // Recovery callback management
    registerRecoveryCallback(serverId, callback) {
        if (!this.recoveryCallbacks.has(serverId)) {
            this.recoveryCallbacks.set(serverId, new Set());
        }
        this.recoveryCallbacks.get(serverId).add(callback);
        this.log.info(`Registered recovery callback for ${serverId} (total: ${this.recoveryCallbacks.get(serverId).size})`);
    }

    removeRecoveryCallback(serverId, callback) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.recoveryCallbacks.delete(serverId);
            }
            this.log.info(`Removed recovery callback for ${serverId} (remaining: ${callbacks.size})`);
        }
    }

    hasRecoveryCallbacks(serverId) {
        return this.recoveryCallbacks.has(serverId) && this.recoveryCallbacks.get(serverId).size > 0;
    }

    executeRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks && callbacks.size > 0) {
            this.log.info(`Executing ${callbacks.size} recovery callbacks for ${serverId}`);
            
            const callbacksToExecute = Array.from(callbacks);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
            
            callbacksToExecute.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.log.error(`Recovery callback error for ${serverId}: ${error.message}`);
                }
            });
        }
    }

    clearRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            this.log.info(`Clearing ${callbacks.size} recovery callbacks for ${serverId}`);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
        }
    }

    // Retry scheduling and management
    scheduleRetry(serverId, statusChangeCallback = null) {
        // Clear any existing retry timer
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Only schedule retry if we have registered nodes for this server
        const remainingNodes = this.getNodeCount(serverId);
        
        if (remainingNodes === 0) {
            this.log.info(`No nodes left for ${serverId}, not scheduling retry`);
            return;
        }

        // Update connection state via connection manager
        if (this.connectionManager.setConnectionState) {
            this.connectionManager.setConnectionState(serverId, 'retry_scheduled');
        }
        
        const retryDelay = 5000 + (Math.random() * 2000); // 5-7 seconds with jitter
        
        this.log.info(`Scheduling retry for ${serverId} in ${Math.round(retryDelay/1000)}s`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            
            // Check if we still have nodes and should retry
            const currentNodes = this.getNodeCount(serverId);
            
            if (currentNodes > 0 && this.connectionManager.getConnectionState(serverId) === 'retry_scheduled') {
                this.log.info(`Executing scheduled retry for ${serverId}`);
                
                try {
                    const client = await this.connectionManager.attemptReconnection(serverId);
                    if (client && client.isClientReady && client.isClientReady()) {
                        this.handleConnectionSuccess(serverId, client);
                    }
                } catch (error) {
                    this.log.error(`Scheduled retry failed for ${serverId}: ${error.message}`);
                    
                    // Schedule another retry if this one failed and error is retryable
                    if (this.isRetryableError(error.message)) {
                        setTimeout(() => {
                            if (this.getNodeCount(serverId) > 0) {
                                this.scheduleRetry(serverId, statusChangeCallback);
                            }
                        }, 10000);
                    }
                }
            }
        }, retryDelay);
        
        this.retryTimers.set(serverId, timer);
    }

    scheduleImmediateRetry(serverId, statusChangeCallback = null) {
        // Clear any existing retry timer
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        if (this.connectionManager.setConnectionState) {
            this.connectionManager.setConnectionState(serverId, 'retry_scheduled');
        }
        
        this.log.info(`Scheduling immediate retry for ${serverId}`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            
            try {
                const client = await this.connectionManager.attemptReconnection(serverId);
                if (client && client.isClientReady && client.isClientReady()) {
                    this.handleConnectionSuccess(serverId, client);
                }
            } catch (error) {
                // Fall back to normal retry schedule
                this.scheduleRetry(serverId, statusChangeCallback);
            }
        }, 100); // Very short delay
        
        this.retryTimers.set(serverId, timer);
    }

    cancelRetry(serverId) {
        const timer = this.retryTimers.get(serverId);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(serverId);
            this.log.info(`Cancelled scheduled retry for ${serverId}`);
        }
    }

    // Handle connection state changes
    handleConnectionError(serverId, error, statusChangeCallback = null) {
        const errorMsg = error.message || error.toString();
        this.log.error(`Handling connection error for ${serverId}: ${errorMsg}`);
        
        // Only schedule retry for retryable errors
        if (this.isRetryableError(errorMsg)) {
            this.scheduleRetry(serverId, statusChangeCallback);
        } else {
            this.log.error(`Non-retryable error for ${serverId}, not scheduling retry`);
            this.clearRecoveryCallbacks(serverId);
        }
    }

    handleConnectionSuccess(serverId, client) {
        this.log.info(`Connection recovered for ${serverId}`);
        
        // Cancel any pending retry
        this.cancelRetry(serverId);
        
        // Execute recovery callbacks
        this.executeRecoveryCallbacks(serverId);
        
        // Notify operation manager to process queued operations
        if (this.onConnectionReady) {
            this.onConnectionReady(serverId, client);
        }
    }

    isRetryableError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        
        // Network errors that should always be retryable
        const networkErrors = [
            'timeout',
            'refused',
            'network',
            'disconnected',
            'econnreset',
            'enotfound',
            'ehostunreach',
            'socket hang up',
            'connection closed',
            'client network socket disconnected',
            'connection terminated',
            'socket is closed',
            'connect etimedout',
            'connect econnrefused',
            'connection lost'
        ];
        
        // If it's a network error, it's always retryable
        if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
            return true;
        }
        
        // Authentication errors that are permanent
        const genuineAuthErrors = [
            'invalid grant',
            'invalid_grant',
            'unauthorized',
            'invalid credentials',
            'user credentials are invalid',
            'wrong username or password',
            'access denied',
            'authentication required',
            'invalid user',
            'bad credentials'
        ];
        
        // Only treat as permanent auth failure if it's a genuine auth error
        if (genuineAuthErrors.some(authError => lowerErrorMsg.includes(authError))) {
            this.log.info(`Genuine authentication error detected: ${errorMsg}`);
            return false;
        }
        
        // Special case: "Authentication failed" that contains network errors should be retryable
        if (lowerErrorMsg.includes('authentication failed')) {
            // Check if the authentication failed due to a network issue
            if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
                this.log.info(`Authentication failed due to network error, will retry: ${errorMsg}`);
                return true;
            }
            
            // If authentication failed without clear network cause, treat as permanent
            this.log.info(`Genuine authentication failure detected: ${errorMsg}`);
            return false;
        }
        
        // Default retryable errors
        const generalRetryableErrors = [
            'handshake',
            'websocket',
            'connection',
            'server error',
            'service unavailable'
        ];
        
        return generalRetryableErrors.some(retryError => 
            lowerErrorMsg.includes(retryError)
        );
    }

    // Recovery status
    getRecoveryStatus(serverId) {
        const hasTimer = this.retryTimers.has(serverId);
        const callbackCount = this.recoveryCallbacks.get(serverId)?.size || 0;
        const nodeCount = this.getNodeCount(serverId);
        
        return {
            retryScheduled: hasTimer,
            recoveryCallbacks: callbackCount,
            nodeCount: nodeCount,
            active: hasTimer || callbackCount > 0
        };
    }

    // Cleanup for specific server
    cleanupServerRecovery(serverId) {
        this.log.info(`Cleaning up recovery for ${serverId}`);
        
        // Cancel retry timer
        this.cancelRetry(serverId);
        
        // Clear recovery callbacks
        this.clearRecoveryCallbacks(serverId);
        
        // Remove node counter
        this.nodeCounters.delete(serverId);
    }

    // Full cleanup
    cleanup() {
        this.log.info('Recovery Manager cleanup started');
        
        // Clear all timers
        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();
        
        // Clear all recovery callbacks
        for (const [serverId] of this.recoveryCallbacks) {
            this.clearRecoveryCallbacks(serverId);
        }
        
        // Clear node counters
        this.nodeCounters.clear();
        
        this.log.info('Recovery Manager cleanup completed');
    }
}

module.exports = RecoveryManager;