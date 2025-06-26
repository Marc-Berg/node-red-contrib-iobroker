/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Manages connection pooling, sharing, and lifecycle
 */

const { SocketClient } = require('../client/socket-client');
const NodeRegistry = require('./node-registry');
const crypto = require('crypto');

class WebSocketManager {
    constructor() {
        this.connections = new Map();
        this.configHashes = new Map();
        this.connectionMutex = new Map();
        this.nodeRegistry = new NodeRegistry(this);
        this.connectionId = 0;
        
        process.on('uncaughtException', this.handleUncaughtException.bind(this));
        process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
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

    generateConnectionId() {
        return ++this.connectionId;
    }

    generateConfigHash(config) {
        const configForHash = {
            iobhost: config.iobhost,
            iobport: config.iobport,
            user: config.user || '',
            password: config.password || '',
            usessl: config.usessl || false
        };
        return crypto.createHash('md5').update(JSON.stringify(configForHash)).digest('hex');
    }

    async getConnection(serverId, config) {
        const configHash = this.generateConfigHash(config);
        const oldHash = this.configHashes.get(serverId);
        
        if (oldHash && oldHash !== configHash) {
            this.log(`Configuration changed for ${serverId} (SSL: ${config.usessl ? 'enabled' : 'disabled'})`);
            await this.closeConnection(serverId);
            this.connectionMutex.delete(serverId);
        }
        
        this.configHashes.set(serverId, configHash);

        const existing = this.connections.get(serverId);
        if (existing && existing.isClientReady()) {
            this.log(`Reusing ready connection for ${serverId}`);
            return existing;
        }

        let connectionPromise = this.connectionMutex.get(serverId);
        if (!connectionPromise) {
            this.log(`Creating new connection for ${serverId}`);
            connectionPromise = this.createConnection(serverId, config);
            this.connectionMutex.set(serverId, connectionPromise);
        } else {
            this.log(`Connection already being created for ${serverId}, waiting...`);
        }

        return await connectionPromise;
    }

    async createConnection(serverId, config) {
        const connectionId = this.generateConnectionId();
        const useAuth = !!(config.user && config.user.trim());
        const useSSL = config.usessl || false;
        
        this.log(`Creating connection ${connectionId} to ${serverId} (${useSSL ? 'SSL' : 'non-SSL'}, ${useAuth ? 'OAuth2' : 'no-auth'})`);
        
        try {
            const client = new SocketClient();

            // Setup event handlers
            client.on('error', (err) => {
                this.handleConnectionError(serverId, err);
            });

            client.on('connect', () => {
                this.handleConnectionSuccess(serverId, connectionId);
            });

            client.on('disconnect', () => {
                this.handleConnectionDisconnect(serverId, connectionId);
            });

            client.on('reconnect', () => {
                this.handleConnectionReconnect(serverId, connectionId);
            });

            client.on('ready', () => {
                this.handleClientReady(serverId, client, connectionId);
            });

            client.on('stateChange', (id, state) => {
                this.nodeRegistry.handleStateChange(id, state);
            });

            client.on('tokenRefresh', (newToken, oldToken) => {
                this.handleTokenRefresh(serverId, newToken, oldToken);
            });

            // Configure connection options
            const connectOptions = {
                name: `NodeRED-${connectionId}`,
                connectMaxAttempt: 0, // Let SocketClient handle retries
                connectTimeout: 8000,
                host: config.iobhost,
                port: config.iobport,
                pingInterval: 5000,
                pongTimeout: 30000,
                useSSL: useSSL
            };

            if (useAuth) {
                if (!config.password) {
                    throw new Error('Password required for authentication');
                }
                connectOptions.username = config.user;
                connectOptions.password = config.password;
            }

            // Store connection
            this.connections.set(serverId, client);

            // Attempt connection
            const protocol = useSSL ? 'wss' : 'ws';
            const wsUrl = `${protocol}://${config.iobhost}:${config.iobport}`;
            
            await client.connect(wsUrl, connectOptions);
            
            this.log(`Connection ${connectionId} established to ${serverId} - now available for sharing`);
            return client;

        } catch (error) {
            this.error(`Failed to create connection to ${serverId}: ${error.message}`);
            
            // Clean up failed connection
            this.connections.delete(serverId);
            this.connectionMutex.delete(serverId);
            throw error;
        }
    }

    handleConnectionSuccess(serverId, connectionId) {
        this.log(`Connected to ${serverId} (connection ${connectionId})`);
        this.nodeRegistry.updateNodeStatus(serverId, 'connected');
    }

    handleConnectionDisconnect(serverId, connectionId) {
        this.log(`Disconnected from ${serverId} (connection ${connectionId})`);
        this.nodeRegistry.updateNodeStatus(serverId, 'disconnected');
    }

    handleConnectionReconnect(serverId, connectionId) {
        this.log(`Reconnected to ${serverId} (connection ${connectionId})`);
        this.nodeRegistry.updateNodeStatus(serverId, 'connected');
    }

    handleConnectionError(serverId, error) {
        this.connectionMutex.delete(serverId);
        this.error(`Connection error for ${serverId}: ${error.message || error}`);
        this.nodeRegistry.updateNodeStatus(serverId, 'disconnected');
    }

    handleTokenRefresh(serverId, newToken, oldToken) {
        this.log(`Token refreshed for ${serverId}`);
        this.nodeRegistry.updateNodeStatus(serverId, 'connected');
    }

    async handleClientReady(serverId, client, connectionId) {
        this.log(`Client ready for ${serverId} (connection ${connectionId}) - processing subscriptions`);
        
        this.connectionMutex.delete(serverId);
        this.nodeRegistry.updateNodeStatus(serverId, 'ready');
        
        const hadRecoveryCallbacks = this.nodeRegistry.hasRecoveryCallbacks(serverId);
        this.nodeRegistry.executeRecoveryCallbacks(serverId);
        
        // Simple resubscription for reconnects
        if (!hadRecoveryCallbacks) {
            setTimeout(async () => {
                await this.nodeRegistry.resubscribeStates(serverId, client);
            }, 100);
        }
    }

    async closeConnection(serverId) {
        this.connectionMutex.delete(serverId);
        
        const client = this.connections.get(serverId);
        if (client) {
            try {
                client.destroy();
                this.log(`Connection closed for ${serverId}`);
            } catch (err) {
                this.error(`Error closing connection for ${serverId}: ${err.message}`);
            }
        }
        
        this.connections.delete(serverId);
        this.nodeRegistry.updateNodeStatus(serverId, 'disconnected');
    }

    // Forward methods to NodeRegistry
    registerNode(nodeId, serverId, type) {
        return this.nodeRegistry.registerNode(nodeId, serverId, type);
    }

    unregisterNode(nodeId) {
        const serverId = this.nodeRegistry.unregisterNode(nodeId);
        if (serverId) {
            const remainingNodes = this.nodeRegistry.getRemainingNodesForServer(serverId);
            if (remainingNodes === 0) {
                this.closeConnection(serverId);
                this.configHashes.delete(serverId);
            }
        }
    }

    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false) {
        return await this.nodeRegistry.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery, this);
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false) {
        return await this.nodeRegistry.registerForEvents(nodeId, serverId, callback, config, isRecovery, this);
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern) {
        return await this.nodeRegistry.unsubscribe(nodeId, serverId, stateIdOrPattern, this);
    }

    unregisterFromEvents(nodeId) {
        return this.nodeRegistry.unregisterFromEvents(nodeId);
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        await this.closeConnection(oldServerId);
        this.connections.delete(oldServerId);
        this.configHashes.delete(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.configHashes.set(newServerId, newHash);
    }

    // State management methods
    async getState(serverId, stateId) {
        const client = this.connections.get(serverId);
        if (!client || !client.isClientReady()) {
            throw new Error(`No ready connection for ${serverId}`);
        }
        
        return await client.getState(stateId);
    }

    async setState(serverId, stateId, value, ack = true) {
        const client = this.connections.get(serverId);
        if (!client || !client.isClientReady()) {
            throw new Error(`No ready connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
            const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };
            
            client.emit('setState', stateId, state, (err) => {
                clearTimeout(timeout);
                if (err) {
                    reject(new Error(err));
                } else {
                    resolve();
                }
            });
        });
    }

    async getStates(serverId) {
        const client = this.connections.get(serverId);
        if (!client || !client.isClientReady()) {
            throw new Error(`No ready connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get states timeout')), 15000);
            
            client.emit('getStates', '*', (err, states) => {
                clearTimeout(timeout);
                if (err) {
                    reject(new Error(err));
                } else {
                    resolve(states);
                }
            });
        });
    }

    async getObject(serverId, objectId) {
        const client = this.connections.get(serverId);
        if (!client || !client.isClientReady()) {
            throw new Error(`No ready connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);
            
            client.emit('getObject', objectId, (err, obj) => {
                clearTimeout(timeout);
                if (err) {
                    reject(new Error(err));
                } else {
                    resolve(obj);
                }
            });
        });
    }

    async setObject(serverId, objectId, objectDef) {
        const client = this.connections.get(serverId);
        if (!client || !client.isClientReady()) {
            throw new Error(`No ready connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set object timeout')), 10000);
            
            client.emit('setObject', objectId, objectDef, (err) => {
                clearTimeout(timeout);
                if (err) {
                    reject(new Error(err));
                } else {
                    resolve();
                }
            });
        });
    }

    getConnectionStatus(serverId) {
        const client = this.connections.get(serverId);
        const hasRecoveryCallbacks = this.nodeRegistry.hasRecoveryCallbacks(serverId);
        
        if (!client) {
            if (hasRecoveryCallbacks) {
                return {
                    connected: false,
                    status: 'retrying',
                    serverId: serverId,
                    lastError: 'Connection failed, recovery pending',
                    recoveryMode: true
                };
            }
            
            return {
                connected: false,
                status: 'not_configured',
                serverId: serverId
            };
        }

        const stats = client.getConnectionStats();
        
        let status = 'disconnected';
        let connected = false;
        let detailedStatus = {};
        
        if (this.connectionMutex.has(serverId)) {
            status = 'connecting';
        } else if (client.isClientReady()) {
            status = 'ready';
            connected = true;
        } else if (client.connected) {
            status = 'connected';
            connected = true;
        } else if (stats.permanentFailure) {
            status = 'failed_permanently';
            detailedStatus.reason = stats.lastError || 'Authentication failed';
        } else if (stats.productionMode) {
            status = 'retrying_production';
            detailedStatus.nextRetryIn = 'up to 65 seconds';
            detailedStatus.lastError = stats.lastError;
        } else if (stats.retryAttempts > 0 || hasRecoveryCallbacks) {
            status = 'retrying';
            detailedStatus.attempts = `${stats.retryAttempts || 0}/${stats.maxRetryAttempts || 50}`;
            detailedStatus.lastError = stats.lastError;
        }

        return {
            connected: connected,
            ready: stats.ready,
            status: status,
            serverId: serverId,
            ssl: {
                enabled: stats.useSSL || false,
                protocol: stats.useSSL ? 'wss/https' : 'ws/http'
            },
            authentication: {
                method: stats.useAuthentication ? 'oauth2' : 'none',
                authenticated: stats.authenticated
            },
            connectionInfo: {
                created: Date.now(),
                isConnecting: this.connectionMutex.has(serverId)
            },
            retryInfo: {
                isRetrying: stats.retryAttempts > 0 || hasRecoveryCallbacks,
                attempts: stats.retryAttempts || 0,
                maxAttempts: stats.maxRetryAttempts || 50,
                productionMode: stats.productionMode || false,
                permanentFailure: stats.permanentFailure || false,
                lastError: stats.lastError || null,
                connectionRecoveryEnabled: stats.connectionRecoveryEnabled !== false
            },
            clientStats: stats,
            detailedStatus: detailedStatus,
            recoveryMode: hasRecoveryCallbacks
        };
    }

    handleUncaughtException(error) {
        this.error(`Uncaught Exception: ${error.message}`);
        if (error.message && error.message.includes('Authentication failed')) {
            this.error('Authentication error caught - continuing operation');
            return;
        }
        this.error('Critical error occurred - cleaning up connections');
        this.cleanup();
    }

    handleUnhandledRejection(reason, promise) {
        this.error(`Unhandled Rejection: ${reason}`);
        if (reason && reason.message && reason.message.includes('Authentication failed')) {
            this.error('Authentication rejection handled gracefully');
            return;
        }
    }

    async cleanup() {
        this.log('Cleanup started');
        
        this.connectionMutex.clear();
        
        for (const [serverId, client] of this.connections) {
            if (client) {
                try {
                    client.destroy();
                } catch (err) {
                    this.error(`Error destroying ${serverId}: ${err.message}`);
                }
            }
        }
        
        this.connections.clear();
        this.configHashes.clear();
        this.nodeRegistry.cleanup();
        
        this.log('Cleanup completed');
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;