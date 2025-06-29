/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Orchestrates connection, operation, recovery and node management
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
        
        // Setup cross-manager interactions
        this.setupManagerInteractions();
        
        // Setup process handlers
        process.on('uncaughtException', this.handleUncaughtException.bind(this));
        process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
        
        this.log = this.createLogger('WebSocketManager');
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

    setupManagerInteractions() {
        // Connection Manager callbacks
        this.connectionManager.onClientReady = (serverId, client) => {
            this.handleClientReady(serverId, client);
        };
        
        this.connectionManager.onStateChange = (id, state) => {
            this.nodeRegistry.handleStateChange(id, state);
        };
        
        this.connectionManager.onObjectChange = (id, objectData, operation) => {
            this.nodeRegistry.handleObjectChange(id, objectData, operation);
        };
        
        this.connectionManager.onError = (serverId, error) => {
            this.recoveryManager.handleConnectionError(serverId, error);
        };
        
        this.connectionManager.onDisconnect = (serverId, error) => {
            this.recoveryManager.handleConnectionError(serverId, error);
        };
        
        this.connectionManager.statusChangeCallback = (serverId, nodeStatus) => {
            this.nodeRegistry.updateNodeStatus(serverId, nodeStatus);
            
            // Process queued operations when connection becomes ready
            if (nodeStatus === 'ready') {
                this.operationManager.processQueuedOperations(serverId);
            }
            
            // Clear queue on permanent failure
            if (nodeStatus === 'failed_permanently') {
                this.operationManager.clearOperationQueue(serverId, new Error('Authentication failed permanently'));
            }
        };
        
        // Recovery Manager callbacks
        this.recoveryManager.onConnectionReady = (serverId, client) => {
            this.operationManager.processQueuedOperations(serverId);
        };
        
        this.recoveryManager.onRecoveryCallback = (serverId) => {
            this.nodeRegistry.executeRecoveryCallbacks(serverId);
        };
        
        // Operation Manager callbacks
        this.operationManager.onTriggerReconnection = (serverId) => {
            this.recoveryManager.scheduleImmediateRetry(serverId);
        };
    }

    async handleClientReady(serverId, client) {
        // Execute any pending recovery callbacks
        this.nodeRegistry.executeRecoveryCallbacks(serverId);
        
        // Resubscribe states and objects after short delay
        setTimeout(async () => {
            await this.nodeRegistry.resubscribeStates(serverId, client);
            await this.nodeRegistry.resubscribeObjects(serverId, client);
        }, 100);
        
        // Notify recovery manager about successful connection
        this.recoveryManager.handleConnectionSuccess(serverId, client);
    }

    // Delegate server ID generation to connection manager
    getServerId(config) {
        return this.connectionManager.getServerId(config);
    }

    // Delegate connection state to connection manager
    getConnectionState(serverId) {
        return this.connectionManager.getConnectionState(serverId);
    }

    // Delegate connection retrieval to connection manager
    async getConnection(serverId, config) {
        return await this.connectionManager.getConnection(serverId, config);
    }

    // Node lifecycle methods - delegate to node registry
    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false) {
        // Track node count for recovery
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }
        
        return await this.nodeRegistry.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery, this);
    }

    async subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery = false) {
        // Track node count for recovery
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }
        
        return await this.nodeRegistry.subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery, this);
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false) {
        // Track node count for recovery
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }
        
        return await this.nodeRegistry.registerForEvents(nodeId, serverId, callback, config, isRecovery, this);
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern) {
        return await this.nodeRegistry.unsubscribe(nodeId, serverId, stateIdOrPattern, this);
    }

    async unsubscribeObjects(nodeId, serverId, objectIdOrPattern) {
        return await this.nodeRegistry.unsubscribeObjects(nodeId, serverId, objectIdOrPattern, this);
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

    // Force server switch - delegate to connection manager
    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        return await this.connectionManager.forceServerSwitch(oldServerId, newServerId, newConfig);
    }

    // State operations - delegate to operation manager
    async getState(serverId, stateId) {
        return await this.operationManager.getState(serverId, stateId);
    }

    async setState(serverId, stateId, value, ack = true) {
        return await this.operationManager.setState(serverId, stateId, value, ack);
    }

    async getStates(serverId) {
        return await this.operationManager.getStates(serverId);
    }

    // Object operations - delegate to operation manager
    async getObject(serverId, objectId) {
        return await this.operationManager.getObject(serverId, objectId);
    }

    // Get multiple objects with wildcard pattern support
    async getObjects(serverId, pattern = '*', objectType = null) {
        return await this.operationManager.getObjects(serverId, pattern, objectType);
    }

    async setObject(serverId, objectId, objectDef) {
        return await this.operationManager.setObject(serverId, objectId, objectDef);
    }

    // Status reporting - combine information from all managers
    getConnectionStatus(serverId) {
        const connectionStatus = this.connectionManager.getConnectionStatus(serverId);
        const queueStatus = this.operationManager.getQueueStatus(serverId);
        const recoveryStatus = this.recoveryManager.getRecoveryStatus(serverId);
        
        return {
            ...connectionStatus,
            queuedOperations: queueStatus.queuedOperations,
            operations: queueStatus.operations,
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

    // Cleanup - coordinate cleanup across all managers
    async cleanup() {
        this.log.info('WebSocket Manager cleanup started');
        
        // Cleanup in reverse order of dependencies
        this.nodeRegistry.cleanup();
        this.recoveryManager.cleanup();
        this.operationManager.cleanup();
        await this.connectionManager.cleanup();
        
        this.log.info('WebSocket Manager cleanup completed');
    }
}

// Create singleton instance
const manager = new WebSocketManager();

// Setup process handlers
process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;