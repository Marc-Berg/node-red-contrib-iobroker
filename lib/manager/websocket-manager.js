/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Coordinating manager using ConnectionManager, OperationManager, and RecoveryManager
 * FIXED VERSION with proper manager integration and debug logs
 */

const { ConnectionManager } = require('./connection-manager');
const OperationManager = require('./operation-manager');
const RecoveryManager = require('./recovery-manager');
const NodeRegistry = require('./node-registry');

class WebSocketManager {
    constructor() {
        // Initialize sub-managers
        this.connectionManager = new ConnectionManager();
        this.operationManager = new OperationManager(this.connectionManager);
        this.recoveryManager = new RecoveryManager(this.connectionManager);
        this.nodeRegistry = new NodeRegistry(this);
        
        // Setup inter-manager communication
        this.setupManagerIntegration();
        
        this.log = this.createLogger('WebSocketManager');
        
        // Global error handling
        process.on('uncaughtException', this.handleUncaughtException.bind(this));
        process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
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

    setupManagerIntegration() {
        // ConnectionManager callbacks
        this.connectionManager.onClientReady = (serverId, client) => {
            this.recoveryManager.handleConnectionSuccess(serverId, client);
            this.operationManager.processQueuedOperations(serverId);
            this.handleClientReady(serverId, client);
        };

        this.connectionManager.onStateChange = (id, state) => {
            this.nodeRegistry.handleStateChange(id, state);
        };

        // Disconnect Handler
        this.connectionManager.onDisconnect = (serverId, error) => {
            this.recoveryManager.handleConnectionError(serverId, error || new Error('Connection lost'), this.connectionManager.statusChangeCallback);
        };

        // Error Handler
        this.connectionManager.onError = (serverId, error) => {
            this.recoveryManager.handleConnectionError(serverId, error, this.connectionManager.statusChangeCallback);
        };

        // OperationManager callbacks
        this.operationManager.onTriggerReconnection = (serverId) => {
            this.recoveryManager.scheduleImmediateRetry(serverId, (serverId, status) => {
                this.nodeRegistry.updateNodeStatus(serverId, status);
            });
        };

        // RecoveryManager callbacks
        this.recoveryManager.onConnectionReady = (serverId, client) => {
            this.operationManager.processQueuedOperations(serverId);
        };

        // Setup status change callback for connection manager
        const statusChangeCallback = (serverId, status) => {
            this.nodeRegistry.updateNodeStatus(serverId, status);
            
            // Handle specific state changes
            switch (status) {
                case 'ready':
                    this.recoveryManager.executeRecoveryCallbacks(serverId);
                    break;
                case 'retrying':
                case 'failed_permanently':
                    this.operationManager.clearOperationQueue(serverId, new Error(`Connection ${status}`));
                    break;
                case 'network_error':
                    const nodeCount = this.recoveryManager.getNodeCount(serverId);
                    if (nodeCount > 0) {
                        this.recoveryManager.scheduleRetry(serverId, statusChangeCallback);
                    }
                    break;
            }
        };

        // Make status callback available to connection manager
        this.connectionManager.statusChangeCallback = statusChangeCallback;
    }

    async handleClientReady(serverId, client) {
        // Resubscribe states after short delay
        setTimeout(async () => {
            await this.nodeRegistry.resubscribeStates(serverId, client);
        }, 100);
    }

    // Delegate server ID methods to connection manager
    getServerId(config) {
        return this.connectionManager.getServerId(config);
    }

    generateServerId(config) {
        return this.connectionManager.generateServerId(config);
    }

    // Connection state methods
    getConnectionState(serverId) {
        return this.connectionManager.getConnectionState(serverId);
    }

    async getConnection(serverId, config) {
        return await this.connectionManager.getConnection(serverId, config);
    }

    // Node lifecycle methods (delegate to NodeRegistry)
    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false) {
        this.recoveryManager.incrementNodeCount(serverId);
        
        try {
            return await this.nodeRegistry.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery, this);
        } catch (error) {
            // Register for recovery on failure
            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.log.info(`Attempting recovery subscription for node ${nodeId} to ${stateIdOrPattern}`);
                    this.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, true)
                        .catch(retryError => {
                            this.log.error(`Recovery subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.recoveryManager.registerRecoveryCallback(serverId, recoveryCallback);
                this.recoveryManager.handleConnectionError(serverId, error, this.connectionManager.statusChangeCallback);
            }
            throw error;
        }
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false) {
        this.recoveryManager.incrementNodeCount(serverId);
        
        try {
            return await this.nodeRegistry.registerForEvents(nodeId, serverId, callback, config, isRecovery, this);
        } catch (error) {
            // Register for recovery on failure
            if (!isRecovery) {
                const recoveryCallback = () => {
                    this.log.info(`Attempting recovery event registration for node ${nodeId}`);
                    this.registerForEvents(nodeId, serverId, callback, config, true)
                        .catch(retryError => {
                            this.log.error(`Recovery event registration failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.recoveryManager.registerRecoveryCallback(serverId, recoveryCallback);
                this.recoveryManager.handleConnectionError(serverId, error, this.connectionManager.statusChangeCallback);
            }
            throw error;
        }
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern) {
        const result = await this.nodeRegistry.unsubscribe(nodeId, serverId, stateIdOrPattern, this);
        
        const remainingNodes = this.recoveryManager.decrementNodeCount(serverId);
        if (remainingNodes === 0) {
            this.log.info(`No more nodes for ${serverId}, closing connection`);
            this.connectionManager.closeConnection(serverId);
        }
        
        return result;
    }

    unregisterFromEvents(nodeId) {
        const serverId = this.nodeRegistry.unregisterFromEvents(nodeId);
        if (serverId) {
            const remainingNodes = this.recoveryManager.decrementNodeCount(serverId);
            if (remainingNodes === 0) {
                this.log.info(`No more nodes for ${serverId}, closing connection`);
                this.connectionManager.closeConnection(serverId);
            }
        }
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        await this.connectionManager.forceServerSwitch(oldServerId, newServerId, newConfig);
        
        // Transfer node counts
        const oldNodeCount = this.recoveryManager.getNodeCount(oldServerId);
        if (oldNodeCount > 0) {
            this.recoveryManager.cleanupServerRecovery(oldServerId);
            // Set initial count for new server (will be managed by actual registrations)
        }
    }

    // State and object operations (delegate to OperationManager)
    async getState(serverId, stateId) {
        return await this.operationManager.getState(serverId, stateId);
    }

    async setState(serverId, stateId, value, ack = true) {
        return await this.operationManager.setState(serverId, stateId, value, ack);
    }

    async getStates(serverId) {
        return await this.operationManager.getStates(serverId);
    }

    async getObject(serverId, objectId) {
        return await this.operationManager.getObject(serverId, objectId);
    }

    async setObject(serverId, objectId, objectDef) {
        return await this.operationManager.setObject(serverId, objectId, objectDef);
    }

    // Status reporting
    getConnectionStatus(serverId) {
        const connectionStatus = this.connectionManager.getConnectionStatus(serverId);
        const operationStatus = this.operationManager.getQueueStatus(serverId);
        const recoveryStatus = this.recoveryManager.getRecoveryStatus(serverId);
        
        return {
            ...connectionStatus,
            ...operationStatus,
            recovery: recoveryStatus
        };
    }

    // Error handling
    handleUncaughtException(error) {
        this.log.error(`Uncaught Exception: ${error.message}`);
        this.cleanup();
    }

    handleUnhandledRejection(reason, promise) {
        this.log.error(`Unhandled Rejection: ${reason}`);
    }

    // Cleanup
    async cleanup() {
        this.log.info('WebSocket Manager cleanup started');
        
        // Cleanup in reverse order of dependency
        this.nodeRegistry.cleanup();
        this.recoveryManager.cleanup();
        this.operationManager.cleanup();
        await this.connectionManager.cleanup();
        
        this.log.info('WebSocket Manager cleanup completed');
    }
}

// Create singleton instance
const manager = new WebSocketManager();

// Global cleanup handlers
process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;