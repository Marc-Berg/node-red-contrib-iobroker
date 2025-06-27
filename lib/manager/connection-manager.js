/*!
 * Connection Manager for ioBroker Node-RED Integration
 * Handles connection pooling, sharing, and lifecycle management
 */

const { SocketClient } = require('../client/socket-client');
const crypto = require('crypto');

// Connection states
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
        this.connections = new Map();           // serverId -> SocketClient
        this.connectionStates = new Map();      // serverId -> state
        this.connectionConfigs = new Map();     // serverId -> config hash
        this.connectionMutex = new Map();       // serverId -> Promise (prevent concurrent connections)
        this.storedConfigs = new Map();        // serverId -> config (for reconnection)
        this.connectionId = 0;
        
        // Callbacks for external managers
        this.onClientReady = null;
        this.onStateChange = null;
        this.onDisconnect = null;
        this.onError = null;
        this.statusChangeCallback = null;
        
        this.log = this.createLogger('ConnectionManager');
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

    // Server ID and config management
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

    // Connection state management
    getConnectionState(serverId) {
        return this.connectionStates.get(serverId) || CONNECTION_STATES.IDLE;
    }

    setConnectionState(serverId, state) {
        const oldState = this.connectionStates.get(serverId);
        this.connectionStates.set(serverId, state);
        
        if (oldState !== state) {
            this.log.info(`Connection state changed for ${serverId}: ${oldState || 'undefined'} -> ${state}`);
            
            // Notify external listeners via callback
            if (this.statusChangeCallback) {
                const nodeStatus = this.mapStateToNodeStatus(state);
                this.statusChangeCallback(serverId, nodeStatus);
            }
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

    // Connection status checks
    shouldAttemptConnection(serverId) {
        const state = this.getConnectionState(serverId);
        return state === CONNECTION_STATES.IDLE || 
               state === CONNECTION_STATES.NETWORK_ERROR;
    }

    isConnectionReady(serverId) {
        const state = this.getConnectionState(serverId);
        const client = this.connections.get(serverId);
        
        return state === CONNECTION_STATES.CONNECTED && 
               client && 
               client.isClientReady();
    }

    // Main connection management
    async getConnection(serverId, config) {
        // Store config for reconnection
        this.storedConfigs.set(serverId, { ...config });
        
        const configHash = this.generateConfigHash(config);
        const oldHash = this.connectionConfigs.get(serverId);
        
        // Check for configuration changes
        if (oldHash && oldHash !== configHash) {
            this.log.info(`Configuration changed for ${serverId} - forcing cleanup`);
            await this.forceCleanupConnection(serverId);
        }
        
        this.connectionConfigs.set(serverId, configHash);

        // Return existing ready connection
        if (this.isConnectionReady(serverId)) {
            this.log.info(`Reusing ready connection for ${serverId}`);
            return this.connections.get(serverId);
        }

        // Return existing connection promise if already connecting
        let connectionPromise = this.connectionMutex.get(serverId);
        if (connectionPromise) {
            this.log.info(`Connection already in progress for ${serverId}, waiting...`);
            return await connectionPromise;
        }

        // Check if we should attempt a new connection
        if (!this.shouldAttemptConnection(serverId)) {
            const state = this.getConnectionState(serverId);
            
            // For event-only nodes, we can wait for connection recovery
            if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
                this.log.info(`Connection in retry state for ${serverId} - node will be registered for recovery`);
                // Return a "dummy" client that will trigger recovery callback registration
                return { isClientReady: () => false, connected: false };
            }
            
            throw new Error(`Connection not possible in state: ${state}`);
        }

        // Create new connection
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
            
            this.log.info(`Connection ${connectionId} established to ${serverId}`);
            return client;

        } catch (error) {
            this.handleConnectionError(serverId, error);
            throw error;
        }
    }

    setupClientEventHandlers(client, serverId, connectionId) {
        client.on('error', (err) => {
            this.handleConnectionError(serverId, err);
        });

        client.on('connect', () => {
            this.log.info(`Connected to ${serverId} (connection ${connectionId})`);
        });

        client.on('disconnect', () => {
            this.log.info(`Disconnected from ${serverId} (connection ${connectionId})`);
            this.handleDisconnection(serverId);
        });

        client.on('reconnect', () => {
            this.log.info(`Reconnected to ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);
        });

        client.on('ready', () => {
            this.log.info(`Client ready for ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);
            
            // Notify external handler
            if (this.onClientReady) {
                this.onClientReady(serverId, client);
            }
        });

        client.on('stateChange', (id, state) => {
            // Forward state changes to external handlers
            if (this.onStateChange) {
                this.onStateChange(id, state);
            }
        });

        client.on('tokenRefresh', (newToken, oldToken) => {
            this.log.info(`Token refreshed for ${serverId}`);
        });
    }

    // Error handling
    handleConnectionError(serverId, error) {
        // Prevent duplicate error handling for the same connection attempt
        if (this.connectionMutex.has(serverId)) {
            this.connectionMutex.delete(serverId);
        } else {
            // This is a duplicate error event, ignore it
            return;
        }
        
        const errorMsg = error.message || error.toString();
        this.log.error(`Connection error for ${serverId}: ${errorMsg}`);
        
        // Classify error type
        if (this.isAuthenticationError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            this.log.error(`Authentication failed permanently for ${serverId}`);
        } else if (this.isNetworkError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        } else {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
        }
        
        // Notify external error handler
        if (this.onError) {
            this.onError(serverId, error);
        }
    }

    handleDisconnection(serverId) {
        const state = this.getConnectionState(serverId);
        
        // Only change state if we were connected and it's not intentional destruction
        if (state === CONNECTION_STATES.CONNECTED) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
            
            // Notify external disconnect handler
            if (this.onDisconnect) {
                this.onDisconnect(serverId, new Error('Connection lost'));
            }
        }
    }

    isAuthenticationError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        const authErrors = [
            'invalid grant',
            'invalid_grant', 
            'unauthorized',
            'invalid credentials',
            'wrong username or password',
            'access denied',
            'authentication required',
            'invalid user',
            'bad credentials'
        ];
        
        return authErrors.some(authError => lowerErrorMsg.includes(authError));
    }

    isNetworkError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        const networkErrors = [
            'timeout',
            'refused',
            'network',
            'econnreset',
            'enotfound',
            'ehostunreach',
            'socket hang up',
            'connection closed',
            'connect etimedout',
            'connect econnrefused'
        ];
        
        return networkErrors.some(netError => lowerErrorMsg.includes(netError));
    }

    // Connection management
    async forceCleanupConnection(serverId) {
        this.log.info(`Force cleanup for ${serverId}`);
        
        this.setConnectionState(serverId, CONNECTION_STATES.DESTROYING);
        
        // Clear connection promise
        this.connectionMutex.delete(serverId);
        
        // Destroy client
        const client = this.connections.get(serverId);
        if (client) {
            try {
                client.setConnectionRecovery(false);
                client.destroy();
            } catch (error) {
                this.log.error(`Error destroying client for ${serverId}: ${error.message}`);
            }
        }
        
        // Clean up references
        this.connections.delete(serverId);
        this.connectionConfigs.delete(serverId);
        // NOTE: Keep storedConfigs for potential reconnection
        
        // Reset to idle state
        this.setConnectionState(serverId, CONNECTION_STATES.IDLE);
        
        this.log.info(`Cleanup completed for ${serverId}`);
    }

    async closeConnection(serverId) {
        this.log.info(`Closing connection for ${serverId}`);
        await this.forceCleanupConnection(serverId);
        
        // Only remove stored config when explicitly closing (not just cleaning up)
        this.storedConfigs.delete(serverId);
    }

    async forceServerSwitch(oldServerId, newServerId, newConfig) {
        this.log.info(`Force server switch: ${oldServerId} -> ${newServerId}`);
        
        await this.forceCleanupConnection(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.connectionConfigs.set(newServerId, newHash);
        
        this.log.info(`Server switch completed: ${oldServerId} -> ${newServerId}`);
    }

    // Status reporting
    getConnectionStatus(serverId) {
        const state = this.getConnectionState(serverId);
        const client = this.connections.get(serverId);
        
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

    // Get stored config for reconnection
    getStoredConfig(serverId) {
        return this.storedConfigs.get(serverId);
    }

    // Attempt reconnection with stored config
    async attemptReconnection(serverId) {
        const storedConfig = this.storedConfigs.get(serverId);
        if (!storedConfig) {
            this.log.info(`No stored config for ${serverId}, cannot reconnect`);
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            return null;
        }

        try {
            this.log.info(`Attempting reconnection to ${serverId} with stored config`);
            this.setConnectionState(serverId, CONNECTION_STATES.IDLE);
            return await this.getConnection(serverId, storedConfig);
        } catch (error) {
            this.log.error(`Reconnection failed for ${serverId}: ${error.message}`);
            this.handleConnectionError(serverId, error);
            return null;
        }
    }

    // Cleanup
    async cleanup() {
        this.log.info('Cleanup started');
        
        // Clear connection promises
        this.connectionMutex.clear();
        
        // Destroy all connections
        for (const [serverId, client] of this.connections) {
            try {
                client.setConnectionRecovery(false);
                client.destroy();
            } catch (error) {
                this.log.error(`Error destroying client for ${serverId}: ${error.message}`);
            }
        }
        
        this.connections.clear();
        this.connectionStates.clear();
        this.connectionConfigs.clear();
        this.storedConfigs.clear();
        
        this.log.info('Cleanup completed');
    }
}

module.exports = { ConnectionManager, CONNECTION_STATES };