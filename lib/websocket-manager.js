// WebSocket Manager for ioBroker Node-RED Integration
const { SocketClient } = require('./iobroker-ws-client-nodejs');
const crypto = require('crypto');

class WebSocketManager {
    constructor() {
        this.connections = new Map();
        this.configHashes = new Map();
        this.connectionMutex = new Map();
        
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.eventNodes = new Map();
        this.nodeRegistrations = new Map();
        
        this.deployCounter = 0;
        this.isDeployActive = false;
        this.deployTimeout = null;
    }

    log(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [info] [WebSocket Manager] ${msg}`);
    }

    error(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.error(`${day} ${month} ${time} - [error] [WebSocket Manager] ${msg}`);
    }

    generateConfigHash(config) {
        return crypto.createHash('md5').update(JSON.stringify({
            iobhost: config.iobhost,
            iobport: config.iobport,
            user: config.user || '',
            password: config.password || ''
        })).digest('hex');
    }

    startDeploy() {
        this.deployCounter++;
        this.isDeployActive = true;
        this.log(`Deploy #${this.deployCounter} started`);
        
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
        }
        this.deployTimeout = setTimeout(() => {
            this.completeDeploy();
        }, 2000);
    }

    completeDeploy() {
        this.isDeployActive = false;
        this.deployTimeout = null;
        this.log(`Deploy #${this.deployCounter} completed`);
        this.processSubscriptions();
    }

    async getConnection(serverId, config) {
        const configHash = this.generateConfigHash(config);
        
        const oldHash = this.configHashes.get(serverId);
        if (oldHash && oldHash !== configHash) {
            this.log(`Configuration changed for ${serverId}, resetting connection`);
            await this.closeConnection(serverId);
        }
        this.configHashes.set(serverId, configHash);

        const existing = this.connections.get(serverId);
        if (existing && existing.connected && existing.client) {
            return existing.client;
        }

        if (this.connectionMutex.has(serverId)) {
            this.log(`Waiting for existing connection attempt to ${serverId}`);
            return await this.connectionMutex.get(serverId);
        }

        const connectionPromise = this.createConnection(serverId, config);
        this.connectionMutex.set(serverId, connectionPromise);
        
        try {
            const client = await connectionPromise;
            return client;
        } finally {
            this.connectionMutex.delete(serverId);
        }
    }

    async createConnection(serverId, config) {
        this.log(`Creating connection to ${serverId}`);
        
        const useAuth = !!(config.user && config.user.trim());
        const authMode = useAuth ? `OAuth2 (${config.user})` : 'no-auth';
        
        const connectionInfo = {
            client: null,
            config: { ...config },
            connected: false,
            connecting: true,
            createdAt: Date.now()
        };
        this.connections.set(serverId, connectionInfo);

        try {
            const client = new SocketClient();
            connectionInfo.client = client;

            client.on('connect', () => {
                this.log(`Connected to ${serverId} with ${authMode}`);
                connectionInfo.connected = true;
                connectionInfo.connecting = false;
                this.updateNodeStatus(serverId, 'connected');
                this.resubscribeStates(serverId);
            });

            client.on('disconnect', () => {
                this.log(`Disconnected from ${serverId}`);
                connectionInfo.connected = false;
                this.updateNodeStatus(serverId, 'disconnected');
                this.scheduleReconnect(serverId);
            });

            client.on('reconnect', () => {
                this.log(`Reconnected to ${serverId}`);
                connectionInfo.connected = true;
                this.updateNodeStatus(serverId, 'connected');
                this.resubscribeStates(serverId);
            });

            client.on('stateChange', (id, state) => {
                this.handleStateChange(id, state);
            });

            client.on('error', (err) => {
                this.error(`Connection error for ${serverId}: ${err}`);
                connectionInfo.connected = false;
                this.updateNodeStatus(serverId, 'disconnected');
                this.scheduleReconnect(serverId);
            });

            const connectOptions = {
                name: `NodeRED-${this.deployCounter}`,
                connectMaxAttempt: 3,
                connectTimeout: 8000,
                host: config.iobhost,
                port: config.iobport,
                pingInterval: 5000,
                pongTimeout: 30000
            };

            if (useAuth) {
                if (!config.password) {
                    throw new Error('Password required for authentication');
                }
                connectOptions.username = config.user;
                connectOptions.password = config.password;
            }

            this.updateNodeStatus(serverId, 'connecting');

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Connection timeout after ${connectOptions.connectTimeout}ms`));
                }, connectOptions.connectTimeout + 2000);
                
                let resolved = false;
                
                const handleConnect = () => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                };
                
                const handleError = (err) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(new Error(typeof err === 'string' ? err : err.message || 'Connection failed'));
                    }
                };

                client.on('connect', handleConnect);
                client.on('error', handleError);

                const wsUrl = `ws://${config.iobhost}:${config.iobport}`;
                this.log(`Connecting to ${wsUrl} with ${authMode}`);
                client.connect(wsUrl, connectOptions);
            });

            connectionInfo.connecting = false;
            this.log(`Connection established to ${serverId}`);
            return client;

        } catch (error) {
            this.error(`Failed to create connection to ${serverId}: ${error.message}`);
            connectionInfo.connecting = false;
            connectionInfo.connected = false;
            this.updateNodeStatus(serverId, 'disconnected');
            throw error;
        }
    }

    async closeConnection(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (connectionInfo && connectionInfo.client) {
            try {
                connectionInfo.client.destroy();
            } catch (err) {
                this.error(`Error closing connection to ${serverId}: ${err.message}`);
            }
            connectionInfo.client = null;
            connectionInfo.connected = false;
        }
        this.updateNodeStatus(serverId, 'disconnected');
    }

    registerNode(nodeId, serverId, type, config) {
        if (!this.isDeployActive) {
            this.startDeploy();
        }
        
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            config: { ...config },
            registeredAt: Date.now()
        });
        this.log(`Node ${nodeId} registered for ${serverId} (type: ${type})`);
        
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = setTimeout(() => {
                this.completeDeploy();
            }, 2000);
        }
    }

    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);
            this.log(`Node ${nodeId} unregistered from ${registration.serverId}`);
            
            const remainingNodes = Array.from(this.nodeRegistrations.values())
                .filter(reg => reg.serverId === registration.serverId);
            
            if (remainingNodes.length === 0) {
                this.log(`Last node removed for ${registration.serverId}, closing connection`);
                this.closeConnection(registration.serverId);
                this.connections.delete(registration.serverId);
                this.configHashes.delete(registration.serverId);
            }
        }
    }

    updateNodeStatus(serverId, status) {
        let nodeCount = 0;
        
        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                nodeCount++;
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        this.eventNodes.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                nodeCount++;
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });
        
        if (nodeCount > 0) {
            this.log(`Status '${status}' sent to ${nodeCount} nodes on ${serverId}`);
        }
    }

    processSubscriptions() {
        this.log('Processing subscriptions after deploy');
        
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration) {
                    const connectionInfo = this.connections.get(registration.serverId);
                    if (connectionInfo && connectionInfo.connected && !stateId.startsWith('_dummy_')) {
                        this.subscribeToState(connectionInfo.client, stateId);
                    }
                }
            });
        });
    }

    async resubscribeStates(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.connected) return;
        
        const statesToSubscribe = new Set();
        
        this.subscriptions.forEach((nodeIds, stateId) => {
            if (stateId.startsWith('_dummy_')) return;
            
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    statesToSubscribe.add(stateId);
                }
            });
        });
        
        if (statesToSubscribe.size > 0) {
            this.log(`Resubscribing to ${statesToSubscribe.size} states on ${serverId}`);
            for (const stateId of statesToSubscribe) {
                try {
                    await this.subscribeToState(connectionInfo.client, stateId);
                    await new Promise(r => setTimeout(r, 50));
                } catch (err) {
                    this.error(`Resubscribe failed for ${stateId}: ${err.message}`);
                }
            }
        }
    }

    subscribeToState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 5000);
            client.emit('subscribe', stateId, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Subscribed to state ${stateId}`);
                    resolve();
                }
            });
        });
    }

    handleStateChange(stateId, state) {
        const nodeIds = this.subscriptions.get(stateId);
        if (!nodeIds) return;

        nodeIds.forEach(nodeId => {
            const callback = this.callbacks.get(nodeId);
            if (callback) {
                try {
                    callback(stateId, state);
                } catch (err) {
                    this.error(`State callback error for ${nodeId}: ${err.message}`);
                }
            }
        });
    }

    scheduleReconnect(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || connectionInfo.connecting) return;

        const hasNodes = Array.from(this.nodeRegistrations.values())
            .some(reg => reg.serverId === serverId);
        
        if (!hasNodes) {
            this.log(`No nodes registered for ${serverId}, skipping reconnect`);
            return;
        }

        this.log(`Scheduling reconnect for ${serverId} in 5 seconds`);
        
        setTimeout(async () => {
            try {
                if (!connectionInfo.connected && !connectionInfo.connecting) {
                    this.log(`Attempting reconnect to ${serverId}`);
                    await this.createConnection(serverId, connectionInfo.config);
                }
            } catch (err) {
                this.error(`Reconnect failed for ${serverId}: ${err.message}`);
            }
        }, 5000);
    }

    // Public API

    async subscribe(nodeId, serverId, stateId, callback, config) {
        try {
            this.registerNode(nodeId, serverId, 'subscribe', config);
            
            const client = await this.getConnection(serverId, config);
            
            this.callbacks.set(nodeId, callback);
            
            if (!this.subscriptions.has(stateId)) {
                this.subscriptions.set(stateId, new Set());
            }
            this.subscriptions.get(stateId).add(nodeId);
            
            const connectionInfo = this.connections.get(serverId);
            if (connectionInfo && connectionInfo.connected && !stateId.startsWith('_dummy_')) {
                await this.subscribeToState(client, stateId);
            }
            
            this.log(`Node ${nodeId} subscribed to ${stateId} on ${serverId}`);
            
        } catch (error) {
            this.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    async registerForEvents(nodeId, serverId, callback, config) {
        try {
            this.registerNode(nodeId, serverId, 'events', config);
            
            await this.getConnection(serverId, config);
            this.eventNodes.set(nodeId, callback);
            this.log(`Node ${nodeId} registered for events on ${serverId}`);
            
        } catch (error) {
            this.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    async getState(serverId, stateId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get state timeout')), 10000);
            connectionInfo.client.emit('getState', stateId, (err, state) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(state);
            });
        });
    }

    async setState(serverId, stateId, value, ack = true) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
            const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };
            connectionInfo.client.emit('setState', stateId, state, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    this.log(`Set state ${stateId} = ${value} (ack: ${ack}) on ${serverId}`);
                    resolve();
                }
            });
        });
    }

    async getStates(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get states timeout')), 15000);
            connectionInfo.client.emit('getStates', '*', (err, states) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(states);
            });
        });
    }

    async getObject(serverId, objectId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);
            connectionInfo.client.emit('getObject', objectId, (err, obj) => {
                clearTimeout(timeout);
                err ? reject(err) : resolve(obj);
            });
        });
    }

    async unsubscribe(nodeId, serverId, stateId) {
        try {
            const nodeIds = this.subscriptions.get(stateId);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateId);
                const connectionInfo = this.connections.get(serverId);
                if (connectionInfo && connectionInfo.client && connectionInfo.connected && !stateId.startsWith('_dummy_')) {
                    connectionInfo.client.emit('unsubscribe', stateId, () => {});
                }
            }
            
            this.callbacks.delete(nodeId);
            this.unregisterNode(nodeId);
            
        } catch (error) {
            this.error(`Unsubscribe error for node ${nodeId}: ${error.message}`);
        }
    }

    unregisterFromEvents(nodeId) {
        try {
            this.eventNodes.delete(nodeId);
            this.unregisterNode(nodeId);
        } catch (error) {
            this.error(`Unregister events error for node ${nodeId}: ${error.message}`);
        }
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        this.log(`Server switch: ${oldServerId} -> ${newServerId}`);
        
        await this.closeConnection(oldServerId);
        this.connections.delete(oldServerId);
        this.configHashes.delete(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.configHashes.set(newServerId, newHash);
    }

    getConnectionStatus(serverId) {
        const connectionInfo = this.connections.get(serverId);
        
        return {
            connected: connectionInfo?.connected || false,
            status: connectionInfo?.connected ? 'connected' : 'disconnected',
            serverId: serverId,
            subscriptions: this.subscriptions.size,
            eventNodes: this.eventNodes.size,
            deployNumber: this.deployCounter,
            isDeployActive: this.isDeployActive
        };
    }

    async cleanup() {
        this.log('Cleanup started');
        
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = null;
        }
        
        for (const [serverId, connectionInfo] of this.connections) {
            if (connectionInfo.client) {
                try {
                    connectionInfo.client.destroy();
                } catch (err) {
                    this.error(`Error destroying ${serverId}: ${err.message}`);
                }
            }
        }
        
        this.connections.clear();
        this.configHashes.clear();
        this.connectionMutex.clear();
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        
        this.log('Cleanup completed');
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    manager.cleanup();
});

module.exports = manager;