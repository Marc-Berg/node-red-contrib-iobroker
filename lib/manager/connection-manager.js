/*!
 * Connection Manager for ioBroker Node-RED Integration
 * Handles connection pooling, sharing, and lifecycle management
 */

const { SocketClient } = require('../client/socket-client');
const { Logger } = require('../utils/logger');
const { ErrorClassifier } = require('../utils/error-classifier');
const crypto = require('crypto');

const CONNECTION_STATES = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    AUTH_FAILED: 'auth_failed',
    NETWORK_ERROR: 'network_error',
    RETRY_SCHEDULED: 'retry_scheduled',
    DESTROYING: 'destroying'
};

class ConnectionManager {
    constructor() {
        this.connections = new Map();
        this.connectionStates = new Map();
        this.connectionConfigs = new Map();
        this.connectionMutex = new Map();
        this.storedConfigs = new Map();
        this.connectionId = 0;
        this.reconnectionAttempts = new Map();

        this.onClientReady = null;
        this.onStateChange = null;
        this.onObjectChange = null;
        this.onDisconnect = null;
        this.onError = null;
        this.statusChangeCallback = null;

        this.log = new Logger('ConnectionManager');
    }

    generateServerId(config) {
        return `${config.iobhost}:${config.iobport}`;
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

    getServerId(config) {
        return this.generateServerId(config);
    }

    getConnectionState(serverId) {
        // Be resilient during/after cleanup when maps may be nullified
        try {
            if (this.destroyed || !this.connectionStates || typeof this.connectionStates.get !== 'function') {
                return CONNECTION_STATES.IDLE;
            }
            return this.connectionStates.get(serverId) || CONNECTION_STATES.IDLE;
        } catch (e) {
            // Defensive default, avoid throwing during shutdown
            return CONNECTION_STATES.IDLE;
        }
    }

    setConnectionState(serverId, state) {
        // Ignore state changes if manager is destroyed or state map is unavailable
        if (this.destroyed || !this.connectionStates || typeof this.connectionStates.get !== 'function' || typeof this.connectionStates.set !== 'function') {
            this.log && this.log.debug && this.log.debug(`Ignoring state change ${state} for ${serverId} after cleanup`);
            return;
        }

        const oldState = this.connectionStates.get(serverId);
        
        if (oldState === state) {
            return;
        }

        if (oldState === CONNECTION_STATES.DESTROYING && state !== CONNECTION_STATES.IDLE) {
            this.log.warn(`Ignoring state change from DESTROYING to ${state} for ${serverId}`);
            return;
        }

        this.connectionStates.set(serverId, state);

            const nodeCount = this.getNodeCountForServer ? this.getNodeCountForServer(serverId) : 'unknown';
            this.log.info(`Connection state changed for ${serverId}: ${oldState || 'undefined'} -> ${state} (${nodeCount} nodes affected)`);

            const timestamp = Date.now();
        this.lastStateChange = { serverId, state, timestamp, oldState };

            const cb = this && this.statusChangeCallback;
            if (typeof cb === 'function') {
                const nodeStatus = this.mapStateToNodeStatus(state);
                setTimeout(() => {
                    try {
                        if (!this.destroyed && typeof this.statusChangeCallback === 'function') {
                            this.statusChangeCallback(serverId, nodeStatus);
                        }
                    } catch (err) {
                        this.log && this.log.debug && this.log.debug(`Status callback threw after state change for ${serverId}: ${err.message}`);
                    }
                }, 0);
            }
    }

    mapStateToNodeStatus(connectionState) {
        switch (connectionState) {
            case CONNECTION_STATES.IDLE: return 'disconnected';
            case CONNECTION_STATES.CONNECTING: return 'connecting';
            case CONNECTION_STATES.CONNECTED: return 'ready';
            case CONNECTION_STATES.AUTH_FAILED: return 'failed_permanently';
            case CONNECTION_STATES.NETWORK_ERROR: return 'retrying';
            case CONNECTION_STATES.RETRY_SCHEDULED: return 'retrying';
            case CONNECTION_STATES.DESTROYING: return 'disconnected';
            default: return 'disconnected';
        }
    }

    shouldAttemptConnection(serverId) {
        const state = this.getConnectionState(serverId);
        return state === CONNECTION_STATES.IDLE ||
            state === CONNECTION_STATES.NETWORK_ERROR ||
            state === CONNECTION_STATES.RETRY_SCHEDULED;
    }

    isConnectionReady(serverId) {
        try {
            if (this.destroyed) return false;
            const state = this.getConnectionState(serverId);
            const client = (this.connections && typeof this.connections.get === 'function') ? this.connections.get(serverId) : null;
            return state === CONNECTION_STATES.CONNECTED &&
                client &&
                typeof client.isClientReady === 'function' &&
                client.isClientReady();
        } catch (e) {
            // Safe default during shutdown
            return false;
        }
    }

    async getConnection(serverId, config) {
        this.storedConfigs.set(serverId, { ...config });

        const configHash = this.generateConfigHash(config);
        const oldHash = this.connectionConfigs.get(serverId);

        if (oldHash && oldHash !== configHash) {
            this.log.info(`Configuration changed for ${serverId} - forcing cleanup`);
            await this.forceCleanupConnection(serverId);
        }

        this.connectionConfigs.set(serverId, configHash);

        if (this.isConnectionReady(serverId)) {
            this.log.debug(`Reusing ready connection for ${serverId}`);
            return this.connections.get(serverId);
        }

        let connectionPromise = this.connectionMutex.get(serverId);
        if (connectionPromise) {
            this.log.debug(`Connection already in progress for ${serverId}, waiting...`);
            return await connectionPromise;
        }

        if (!this.shouldAttemptConnection(serverId)) {
            const state = this.getConnectionState(serverId);

            if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
                this.log.debug(`Connection in retry state for ${serverId} - node will be registered for recovery`);
                return { isClientReady: () => false, connected: false };
            }

            throw new Error(`Connection not possible in state: ${state}`);
        }

        this.log.info(`Creating new connection for ${serverId}`);
        connectionPromise = this.createConnection(serverId, config);
        this.connectionMutex.set(serverId, connectionPromise);

        try {
            const client = await connectionPromise;
            return client;
        } finally {
            this.connectionMutex.delete(serverId);
        }
    }

    async createConnection(serverId, config) {
        const connectionId = ++this.connectionId;
        const useAuth = !!(config.user && config.user.trim());
        const useSSL = config.usessl || false;

        this.log.info(`Creating connection ${connectionId} to ${serverId} (${useSSL ? 'SSL' : 'non-SSL'}, ${useAuth ? 'OAuth2' : 'no-auth'})`);

        this.setConnectionState(serverId, CONNECTION_STATES.CONNECTING);

        try {
            const client = new SocketClient();
            this.setupClientEventHandlers(client, serverId, connectionId);

            const connectOptions = {
                name: `NodeRED-${connectionId}`,
                connectMaxAttempt: 0,
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

            const protocol = useSSL ? 'wss' : 'ws';
            const wsUrl = `${protocol}://${config.iobhost}:${config.iobport}`;

            await client.connect(wsUrl, connectOptions);

            this.connections.set(serverId, client);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);

            this.reconnectionAttempts.delete(serverId);

            this.log.info(`Connection ${connectionId} established to ${serverId}`);
            return client;

        } catch (error) {
            this.handleConnectionError(serverId, error);
            throw error;
        }
    }

    async attemptReconnection(serverId) {
        const storedConfig = this.storedConfigs.get(serverId);
        if (!storedConfig) {
            this.log.debug(`No stored config for ${serverId}, cannot reconnect`);
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            return null;
        }

        const attempts = this.reconnectionAttempts.get(serverId) || 0;
        this.reconnectionAttempts.set(serverId, attempts + 1);

        try {
            this.log.info(`Attempting reconnection to ${serverId} with stored config (attempt ${attempts + 1})`);
            
            const client = await this.getConnection(serverId, storedConfig);
            
            if (client && client.connected !== false) {
                this.log.info(`Reconnection successful for ${serverId}`);
                return client;
            } else {
                this.log.warn(`Reconnection to ${serverId} returned invalid client`);
                return null;
            }
            
        } catch (error) {
            this.log.error(`Reconnection failed for ${serverId}: ${error.message}`);
            
            const attempts = this.reconnectionAttempts.get(serverId) || 0;
            
            if (ErrorClassifier.isAuthenticationError(error.message)) {
                this.log.error(`Authentication error during reconnection to ${serverId}, stopping attempts`);
                this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            } else if (attempts >= 5) {
                this.log.error(`Maximum reconnection attempts reached for ${serverId}, marking as failed`);
                this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            } else {
                this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
            }
            
            this.handleConnectionError(serverId, error);
            return null;
        }
    }

    setupClientEventHandlers(client, serverId, connectionId) {
        client.on('error', (err) => {
            this.handleConnectionError(serverId, err);
        });

        client.on('connect', () => {
            this.log.debug(`Connected to ${serverId} (connection ${connectionId})`);
        });

        client.on('disconnect', () => {
            this.log.debug(`Disconnected from ${serverId} (connection ${connectionId})`);
            this.handleDisconnection(serverId);
        });

        client.on('reconnect', () => {
            this.log.debug(`Reconnected to ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);
        });

        client.on('ready', () => {
            this.log.info(`Client ready for ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);

            if (this.onClientReady) {
                this.onClientReady(serverId, client);
            }
        });

        client.on('stateChange', (id, state) => {
            if (this.onStateChange) {
                this.onStateChange(id, state);
            }
        });

        client.on('objectChange', (id, objectData, operation) => {
            if (this.onObjectChange) {
                this.onObjectChange(id, objectData, operation);
            }
        });

        client.on('tokenRefresh', (newToken, oldToken) => {
            this.log.debug(`Token refreshed for ${serverId}`);
        });
    }

    handleConnectionError(serverId, error) {
        const hasMutex = this.connectionMutex.has(serverId);
        
        if (hasMutex) {
            this.connectionMutex.delete(serverId);
            this.log.debug(`Handling error during connection attempt for ${serverId}`);
        } else {
            this.log.debug(`Handling error from existing connection for ${serverId}`);
        }

        const errorMsg = error.message || error.toString();
        this.log.error(`Connection error for ${serverId}: ${errorMsg}`);

        if (ErrorClassifier.isAuthenticationError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            this.log.error(`Authentication failed permanently for ${serverId}`);
        } else if (ErrorClassifier.isNetworkError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        } else {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        }

        if (this.onError) {
            this.onError(serverId, error);
        }
    }

    handleDisconnection(serverId) {
        const state = this.getConnectionState(serverId);

        if (state === CONNECTION_STATES.CONNECTED) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);

            if (this.onDisconnect) {
                this.onDisconnect(serverId, new Error('Connection lost'));
            }
        }
    }

    async forceCleanupConnection(serverId) {
        this.log.info(`Starting force cleanup for ${serverId}`);

        this.setConnectionState(serverId, CONNECTION_STATES.DESTROYING);

        this.connectionMutex.delete(serverId);

        const client = this.connections.get(serverId);
        if (client) {
            try {
                client.setConnectionRecovery(false);
                client.destroy();
                this.log.debug(`Client destroyed for ${serverId}`);
            } catch (error) {
                this.log.error(`Error destroying client for ${serverId}: ${error.message}`);
            }
        }

        this.connections.delete(serverId);
        this.connectionConfigs.delete(serverId);
        this.reconnectionAttempts.delete(serverId);

        this.setConnectionState(serverId, CONNECTION_STATES.IDLE);

        this.log.info(`Force cleanup completed for ${serverId}`);
    }

    async closeConnection(serverId) {
        this.log.info(`Closing connection for ${serverId}`);
        await this.forceCleanupConnection(serverId);
        this.storedConfigs.delete(serverId);
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        this.log.info(`Force server switch: ${oldServerId} -> ${newServerId}`);

        await this.forceCleanupConnection(oldServerId);

        const newHash = this.generateConfigHash(newConfig);
        this.connectionConfigs.set(newServerId, newHash);

        this.log.info(`Server switch completed: ${oldServerId} -> ${newServerId}`);
    }

    getConnectionStatus(serverId) {
    const state = this.getConnectionState(serverId);
    const client = (this.connections && typeof this.connections.get === 'function') ? this.connections.get(serverId) : null;
    const attempts = (this.reconnectionAttempts && typeof this.reconnectionAttempts.get === 'function') ? (this.reconnectionAttempts.get(serverId) || 0) : 0;

        let connected = false;
        let ready = false;

        if (client) {
            connected = client.connected;
            ready = client.isClientReady();
        }

        return {
            connected: connected,
            ready: ready,
            status: state,
            serverId: serverId,
            connectionState: state,
            reconnectionAttempts: attempts,
            ssl: {
                enabled: client ? client.useSSL : false,
                protocol: client ? (client.useSSL ? 'wss/https' : 'ws/http') : 'unknown'
            },
            authentication: {
                method: client ? (client.useAuthentication ? 'oauth2' : 'none') : 'unknown',
                authenticated: client ? client.authenticated : false
            },
            clientStats: client ? client.getConnectionStats() : null
        };
    }

    getStoredConfig(serverId) {
        return this.storedConfigs.get(serverId);
    }

    async cleanup() {
        this.log.info('ConnectionManager cleanup started');

        this.destroyed = true;

        this.clearAllTimers();
        this.removeAllEventListeners();
        await this.clearAllCollections();
        this.nullifyReferences();

        this.log.info('ConnectionManager cleanup completed');
    }

    async destroy() {
        this.log.debug(`Destroying ConnectionManager`);

        this.destroyed = true;

        await this.cleanup();
        this.clearAllTimers();
        this.removeAllEventListeners();
        this.nullifyReferences();

        this.log.debug(`ConnectionManager destroyed completely`);
    }

    clearAllTimers() {
        this.connectionMutex.clear();
    }

    removeAllEventListeners() {
        this.onClientReady = null;
        this.onStateChange = null;
        this.onObjectChange = null;
        this.onDisconnect = null;
        this.onError = null;
        this.statusChangeCallback = null;
    }

    async clearAllCollections() {
        for (const [serverId, client] of this.connections) {
            try {
                await this.forceCleanupConnection(serverId);
            } catch (error) {
                this.log.error(`Error cleaning up connection for ${serverId}: ${error.message}`);
            }
        }

        this.connections.clear();
        this.connectionStates.clear();
        this.connectionConfigs.clear();
        this.storedConfigs.clear();
        this.connectionMutex.clear();
        this.reconnectionAttempts.clear();
    }

    nullifyReferences() {
        this.connections = null;
        this.connectionStates = null;
        this.connectionConfigs = null;
        this.storedConfigs = null;
        this.connectionMutex = null;
        this.reconnectionAttempts = null;

        this.onClientReady = null;
        this.onStateChange = null;
        this.onObjectChange = null;
        this.onDisconnect = null;
        this.onError = null;
        this.statusChangeCallback = null;
    }
}

module.exports = { ConnectionManager, CONNECTION_STATES };