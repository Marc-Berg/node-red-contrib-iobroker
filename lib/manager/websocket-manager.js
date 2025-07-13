/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Orchestrates connection, operation, recovery and node management
 */

const { ConnectionManager } = require('./connection-manager');
const OperationManager = require('./operation-manager');
const RecoveryManager = require('./recovery-manager');
const NodeRegistry = require('./node-registry');
const { Logger } = require('../utils/logger');

class WebSocketManager {
    constructor() {
        this.connectionManager = new ConnectionManager();
        this.operationManager = new OperationManager(this.connectionManager);
        this.recoveryManager = new RecoveryManager(this.connectionManager);
        this.nodeRegistry = new NodeRegistry(this);

        this.coordinationState = new Map();
        this.lastSuccessfulConnection = new Map();

        this.setupManagerInteractions();

        process.on('uncaughtException', this.handleUncaughtException.bind(this));
        process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));

        this.log = new Logger('WebSocketManager');
    }

    isRecoveryInProgress(serverId) {
        const state = this.coordinationState.get(serverId);
        return state && state.recoveryInProgress;
    }

    setRecoveryInProgress(serverId, inProgress) {
        if (!this.coordinationState.has(serverId)) {
            this.coordinationState.set(serverId, {});
        }
        const state = this.coordinationState.get(serverId);
        state.recoveryInProgress = inProgress;

        if (inProgress) {
            state.recoveryStartTime = Date.now();
        } else {
            state.recoveryStartTime = null;
            this.lastSuccessfulConnection.set(serverId, Date.now());
        }
    }

    wasRecentlySuccessful(serverId, withinMs = 30000) {
        const lastSuccess = this.lastSuccessfulConnection.get(serverId);
        if (!lastSuccess) return false;
        return (Date.now() - lastSuccess) < withinMs;
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
            if (this.wasRecentlySuccessful(serverId, 5000)) {
                this.log.debug(`Ignoring error for ${serverId} - connection was recently successful`);
                return;
            }

            if (!this.isRecoveryInProgress(serverId)) {
                this.setRecoveryInProgress(serverId, true);
                this.recoveryManager.handleConnectionError(serverId, error);
            } else {
                this.log.debug(`Recovery already in progress for ${serverId}, ignoring duplicate error`);
            }
        };

        this.connectionManager.onDisconnect = (serverId, error) => {
            if (!this.isRecoveryInProgress(serverId)) {
                this.setRecoveryInProgress(serverId, true);
                this.recoveryManager.handleConnectionError(serverId, error);
            } else {
                this.log.debug(`Recovery already in progress for ${serverId}, ignoring duplicate disconnect`);
            }
        };

        this.connectionManager.statusChangeCallback = (serverId, nodeStatus) => {
            this.nodeRegistry.updateNodeStatus(serverId, nodeStatus);

            if (nodeStatus === 'ready') {
                this.log.debug(`Processing queued operations for ${serverId} due to ready status`);
                this.operationManager.processQueuedOperations(serverId);
                this.setRecoveryInProgress(serverId, false);
            }

            if (nodeStatus === 'failed_permanently') {
                this.log.debug(`Clearing operation queue for ${serverId} due to permanent failure`);
                this.operationManager.clearOperationQueue(serverId, new Error('Authentication failed permanently'));
                this.setRecoveryInProgress(serverId, false);
            }
        };

        this.recoveryManager.onConnectionReady = (serverId, client) => {
            this.log.debug(`Recovery manager notified connection ready for ${serverId}`);
            this.operationManager.processQueuedOperations(serverId);
            this.setRecoveryInProgress(serverId, false);
        };

        this.recoveryManager.onRecoveryCallback = (serverId) => {
            this.log.debug(`Recovery manager executing callbacks for ${serverId}`);
            this.nodeRegistry.executeRecoveryCallbacks(serverId);
        };

        this.operationManager.onTriggerReconnection = (serverId) => {
            if (this.wasRecentlySuccessful(serverId, 10000)) {
                this.log.debug(`Ignoring operation reconnection request for ${serverId} - was recently successful`);
                return;
            }

            if (!this.isRecoveryInProgress(serverId)) {
                this.log.debug(`Operation manager requesting immediate retry for ${serverId}`);
                this.setRecoveryInProgress(serverId, true);
                this.recoveryManager.scheduleImmediateRetry(serverId);
            } else {
                this.log.debug(`Recovery already in progress for ${serverId}, operation manager request ignored`);
            }
        };
    }

    async handleClientReady(serverId, client) {
        const nodeCount = this.nodeRegistry.getRemainingNodesForServer(serverId);
        this.log.info(`Client ready for ${serverId} - processing ${nodeCount} nodes`);
        this.log.debug(`Force-syncing node statuses for ${serverId}`);
        this.nodeRegistry.syncAllNodeStatuses(serverId);
        this.log.debug(`Executing recovery callbacks for ${serverId}`);
        this.nodeRegistry.executeRecoveryCallbacks(serverId);
        setTimeout(async () => {
            try {
                const currentState = this.connectionManager.getConnectionState(serverId);
                if (currentState !== 'connected') {
                    this.log.warn(`Skipping resubscription for ${serverId} - state changed to ${currentState}`);
                    return;
                }

                this.log.info(`Starting resubscription process for ${serverId}`);

                await this.nodeRegistry.resubscribeStates(serverId, client);

                await new Promise(resolve => setTimeout(resolve, 100));
                await this.nodeRegistry.resubscribeObjects(serverId, client);

                await new Promise(resolve => setTimeout(resolve, 100));
                await this.nodeRegistry.resubscribeLogs(serverId, client);

                this.log.debug(`Final status sync for ${serverId} after resubscription`);
                this.nodeRegistry.syncAllNodeStatuses(serverId);

                this.log.info(`Resubscription process completed for ${serverId}`);
                this.setRecoveryInProgress(serverId, false);

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

                this.coordinationState.delete(serverId);
                this.lastSuccessfulConnection.delete(serverId);
                this.connectionManager.closeConnection(serverId);
            }
        }
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        this.log.info(`Force server switch requested: ${oldServerId} -> ${newServerId}`);

        this.coordinationState.delete(oldServerId);
        this.lastSuccessfulConnection.delete(oldServerId);

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

    async getObjectView(serverId, designId, searchId, params = {}) {
        return await this.operationManager.getObjectView(serverId, designId, searchId, params);
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
        const coordinationStatus = this.coordinationState.get(serverId) || {};
        const lastSuccess = this.lastSuccessfulConnection.get(serverId);

        return {
            ...connectionStatus,
            queuedOperations: queueStatus.queuedOperations,
            operations: queueStatus.operations,
            recovery: {
                ...recoveryStatus,
                coordinationInProgress: coordinationStatus.recoveryInProgress || false,
                recoveryStartTime: coordinationStatus.recoveryStartTime,
                lastSuccessfulConnection: lastSuccess,
                timeSinceLastSuccess: lastSuccess ? Date.now() - lastSuccess : null
            }
        };
    }

    handleUncaughtException(error) {
        this.log.error(`Uncaught Exception: ${error.message}`);
        this.log.debug(`Stack trace: ${error.stack}`);
        this.cleanup();
    }

    handleUnhandledRejection(reason, promise) {
        this.log.error(`Unhandled Rejection: ${reason}`);
        this.log.debug(`Promise: ${promise}`);
    }

    async cleanup() {
        this.log.info('WebSocket Manager cleanup started');

        this.coordinationState.clear();
        this.lastSuccessfulConnection.clear();

        this.log.debug('Cleaning up node registry...');
        this.nodeRegistry.cleanup();

        this.log.debug('Cleaning up recovery manager...');
        this.recoveryManager.cleanup();

        this.log.debug('Cleaning up operation manager...');
        this.operationManager.cleanup();

        this.log.debug('Cleaning up connection manager...');
        await this.connectionManager.cleanup();

        this.log.info('WebSocket Manager cleanup completed');
    }

    async destroy() {
        this.log.debug(`Destroying WebSocket Manager`);

        this.destroyed = true;

        await this.cleanup();
        this.removeAllEventListeners();
        this.clearAllCollections();
        this.nullifyReferences();

        this.log.debug(`WebSocket Manager destroyed completely`);
    }

    removeAllEventListeners() {
        try {
            process.removeAllListeners('uncaughtException');
            process.removeAllListeners('unhandledRejection');
            process.removeAllListeners('SIGTERM');
            process.removeAllListeners('SIGINT');
        } catch (error) {
            this.log.debug(`Process event listener cleanup warning: ${error.message}`);
        }
    }

    clearAllCollections() {
        if (this.coordinationState instanceof Map) {
            this.coordinationState.clear();
        }
        if (this.lastSuccessfulConnection instanceof Map) {
            this.lastSuccessfulConnection.clear();
        }
    }

    nullifyReferences() {
        this.connectionManager = null;
        this.operationManager = null;
        this.recoveryManager = null;
        this.nodeRegistry = null;
        this.coordinationState = null;
        this.lastSuccessfulConnection = null;
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => {
    manager.log.info('SIGTERM received, starting graceful shutdown');
    manager.cleanup();
});

process.on('SIGINT', () => {
    manager.log.info('SIGINT received, starting graceful shutdown');
    manager.cleanup();
});

module.exports = manager;