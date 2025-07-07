/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Orchestrates connection, operation, recovery and node management
 */

const { ConnectionManager } = require('./connection-manager');
const OperationManager = require('./operation-manager');
const RecoveryManager = require('./recovery-manager');
const NodeRegistry = require('./node-registry');
const { Logger } = require('../utils');

class WebSocketManager {
    constructor() {
        this.connectionManager = new ConnectionManager();
        this.operationManager = new OperationManager(this.connectionManager);
        this.recoveryManager = new RecoveryManager(this.connectionManager);
        this.nodeRegistry = new NodeRegistry(this);

        this.setupManagerInteractions();

        process.on('uncaughtException', this.handleUncaughtException.bind(this));
        process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));

        this.log = new Logger('WebSocketManager');
    }

    setupManagerInteractions() {
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

            if (nodeStatus === 'ready') {
                this.operationManager.processQueuedOperations(serverId);
            }

            if (nodeStatus === 'failed_permanently') {
                this.operationManager.clearOperationQueue(serverId, new Error('Authentication failed permanently'));
            }
        };

        this.recoveryManager.onConnectionReady = (serverId, client) => {
            this.operationManager.processQueuedOperations(serverId);
        };

        this.recoveryManager.onRecoveryCallback = (serverId) => {
            this.nodeRegistry.executeRecoveryCallbacks(serverId);
        };

        this.operationManager.onTriggerReconnection = (serverId) => {
            this.recoveryManager.scheduleImmediateRetry(serverId);
        };
    }

    async handleClientReady(serverId, client) {
        this.log.info(`Client ready for ${serverId} - processing ${this.nodeRegistry.getRemainingNodesForServer(serverId)} nodes`);

        this.nodeRegistry.syncAllNodeStatuses(serverId);

        this.nodeRegistry.executeRecoveryCallbacks(serverId);

        setTimeout(async () => {
            try {
                await this.nodeRegistry.resubscribeStates(serverId, client);
                await this.nodeRegistry.resubscribeObjects(serverId, client);
                await this.nodeRegistry.resubscribeLogs(serverId, client);
                this.nodeRegistry.syncAllNodeStatuses(serverId);
                
            } catch (error) {
                this.log.error(`Resubscription error for ${serverId}: ${error.message}`);
            }
        }, 50);

        this.recoveryManager.handleConnectionSuccess(serverId, client);
    }

    getServerId(config) {
        return this.connectionManager.getServerId(config);
    }

    getConnectionState(serverId) {
        return this.connectionManager.getConnectionState(serverId);
    }

    async getConnection(serverId, config) {
        return await this.connectionManager.getConnection(serverId, config);
    }

    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false) {
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }

        return await this.nodeRegistry.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery, this);
    }

    async subscribeMultiple(nodeId, serverId, stateIds, callback, config, isRecovery = false) {
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }

        return await this.nodeRegistry.subscribeMultiple(nodeId, serverId, stateIds, callback, config, isRecovery, this);
    }

    async subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery = false) {
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }

        return await this.nodeRegistry.subscribeObjects(nodeId, serverId, objectIdOrPattern, callback, config, isRecovery, this);
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false) {
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }

        return await this.nodeRegistry.registerForEvents(nodeId, serverId, callback, config, isRecovery, this);
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern) {
        return await this.nodeRegistry.unsubscribe(nodeId, serverId, stateIdOrPattern, this);
    }

    async unsubscribeMultiple(nodeId, serverId, stateIds) {
        return await this.nodeRegistry.unsubscribeMultiple(nodeId, serverId, stateIds, this);
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

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        return await this.connectionManager.forceServerSwitch(oldServerId, newServerId, newConfig);
    }

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

    async getObjects(serverId, pattern = '*', objectType = null) {
        return await this.operationManager.getObjects(serverId, pattern, objectType);
    }

    async setObject(serverId, objectId, objectDef) {
        return await this.operationManager.setObject(serverId, objectId, objectDef);
    }

    async getHistory(serverId, historyAdapter, stateId, options) {
        return await this.operationManager.getHistory(serverId, historyAdapter, stateId, options);
    }

    async sendToAdapter(serverId, adapter, command, message, timeout = 10000) {
        return await this.operationManager.sendToAdapter(serverId, adapter, command, message, timeout);
    }

    async subscribeToLiveLogs(nodeId, serverId, callback, config, logLevel = 'info', isRecovery = false) {
        if (!isRecovery) {
            this.recoveryManager.incrementNodeCount(serverId);
        }

        return await this.nodeRegistry.subscribeToLogs(nodeId, serverId, callback, config, logLevel, isRecovery, this);
    }

    async unsubscribeFromLiveLogs(nodeId, serverId) {
        return await this.nodeRegistry.unsubscribeFromLogs(nodeId, serverId, this);
    }

    getLogSubscriptionStats(serverId) {
        const client = this.connectionManager.connections.get(serverId);
        if (client && client.handlers && client.handlers['log']) {
            return {
                subscriptions: client.handlers['log'].length,
                serverId: serverId
            };
        }
        return {
            subscriptions: 0,
            serverId: serverId
        };
    }

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

    handleUncaughtException(error) {
        this.log.error(`Uncaught Exception: ${error.message}`);
        this.cleanup();
    }

    handleUnhandledRejection(reason, promise) {
        this.log.error(`Unhandled Rejection: ${reason}`);
    }

    async cleanup() {
        this.log.info('WebSocket Manager cleanup started');

        this.nodeRegistry.cleanup();
        this.recoveryManager.cleanup();
        this.operationManager.cleanup();
        await this.connectionManager.cleanup();

        this.log.info('WebSocket Manager cleanup completed');
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;