/*!
 * WebSocket Manager for ioBroker Node-RED Integration
 * Manages connection pooling, sharing, and lifecycle
 */

const { SocketClient } = require('../client/socket-client');
const NodeRegistry = require('./node-registry');
const crypto = require('crypto');

// Connection states for centralized management
const CONNECTION_STATES = {
    IDLE: 'idle',                    
    CONNECTING: 'connecting',        
    CONNECTED: 'connected',          
    AUTH_FAILED: 'auth_failed',      
    NETWORK_ERROR: 'network_error',  
    RETRY_SCHEDULED: 'retry_scheduled',
    DESTROYING: 'destroying'         
};

class WebSocketManager {
    constructor() {
        this.connections = new Map();           
        this.connectionStates = new Map();      
        this.connectionConfigs = new Map();     
        this.connectionMutex = new Map();       
        this.retryTimers = new Map();           
        this.operationQueues = new Map();      
        this.queueProcessors = new Map();      
        this.storedConfigs = new Map();        // Store configs for reconnection
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
            // Note: _isReconnectConfig is intentionally excluded from hash
        };
        return crypto.createHash('md5').update(JSON.stringify(configForHash)).digest('hex');
    }

    getServerId(config) {
        return this.generateServerId(config);
    }

    // Find configuration for a server from registered nodes
    findConfigForServer(serverId) {
        // We need to reconstruct the config from the serverId and stored config hash
        // This is a bit tricky, but we can try to find it from Node-RED's config nodes
        
        try {
            // Try to find the config from the stored configuration
            // The serverId format is "host:port"
            const [host, port] = serverId.split(':');
            
            // We should store the actual config when nodes register
            // For now, create a basic config that should work for reconnection
            const storedConfigHash = this.connectionConfigs.get(serverId);
            if (!storedConfigHash) {
                this.log(`No stored config found for ${serverId}`);
                return null;
            }
            
            // Create a basic config for reconnection
            // This is not ideal, but better than failing completely
            const basicConfig = {
                iobhost: host,
                iobport: parseInt(port),
                user: '', // Will be filled from stored config if needed
                password: '', // Will be filled from stored config if needed  
                usessl: port === '8443' || port === '443' || port === '8084' // Guess SSL from port
            };
            
            this.log(`Using basic config for reconnection to ${serverId}`);
            return basicConfig;
            
        } catch (error) {
            this.error(`Failed to reconstruct config for ${serverId}: ${error.message}`);
            return null;
        }
    }

    getConnectionState(serverId) {
        return this.connectionStates.get(serverId) || CONNECTION_STATES.IDLE;
    }

    setConnectionState(serverId, state) {
        const oldState = this.connectionStates.get(serverId);
        this.connectionStates.set(serverId, state);
        
        if (oldState !== state) {
            this.log(`Connection state changed for ${serverId}: ${oldState || 'undefined'} -> ${state}`);
            this.nodeRegistry.updateNodeStatus(serverId, this.mapStateToNodeStatus(state));
            
            // Process queued operations when connection becomes ready
            if (state === CONNECTION_STATES.CONNECTED) {
                this.processQueuedOperations(serverId);
            }
            
            // Clear queue on permanent failure
            if (state === CONNECTION_STATES.AUTH_FAILED) {
                this.clearOperationQueue(serverId, new Error('Authentication failed permanently'));
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

    // NEW: Operation queueing during reconnect
    queueOperation(serverId, operation, timeout = 10000) {
        if (!this.operationQueues.has(serverId)) {
            this.operationQueues.set(serverId, []);
        }
        
        const queue = this.operationQueues.get(serverId);
        const queueItem = {
            operation,
            timestamp: Date.now(),
            timeout: timeout,
            promise: null
        };
        
        queueItem.promise = new Promise((resolve, reject) => {
            queueItem.resolve = resolve;
            queueItem.reject = reject;
            
            // Set timeout for queued operation
            setTimeout(() => {
                const index = queue.indexOf(queueItem);
                if (index !== -1) {
                    queue.splice(index, 1);
                    reject(new Error(`Operation timeout after ${timeout}ms in queue`));
                }
            }, timeout);
        });
        
        queue.push(queueItem);
        this.log(`Queued operation for ${serverId} (queue size: ${queue.length})`);
        
        return queueItem.promise;
    }

    processQueuedOperations(serverId) {
        const queue = this.operationQueues.get(serverId);
        if (!queue || queue.length === 0) {
            return;
        }
        
        this.log(`Processing ${queue.length} queued operations for ${serverId}`);
        
        // Process all queued operations
        const operationsToProcess = [...queue];
        this.operationQueues.set(serverId, []); // Clear queue
        
        // Process operations with slight delay between each
        operationsToProcess.forEach((queueItem, index) => {
            setTimeout(async () => {
                try {
                    const result = await queueItem.operation();
                    queueItem.resolve(result);
                } catch (error) {
                    queueItem.reject(error);
                }
            }, index * 50); // 50ms delay between operations
        });
    }

    clearOperationQueue(serverId, error) {
        const queue = this.operationQueues.get(serverId);
        if (!queue || queue.length === 0) {
            return;
        }
        
        this.log(`Clearing ${queue.length} queued operations for ${serverId} due to: ${error.message}`);
        
        // Reject all queued operations
        queue.forEach(queueItem => {
            queueItem.reject(error);
        });
        
        this.operationQueues.set(serverId, []);
    }

    async executeOperation(serverId, operation, operationName = 'operation') {
        // Check if connection is ready
        if (this.isConnectionReady(serverId)) {
            return await operation();
        }
        
        const state = this.getConnectionState(serverId);
        
        // If connection is being established, queue the operation
        if (state === CONNECTION_STATES.CONNECTING) {
            this.log(`Queueing ${operationName} for ${serverId} - connection in progress`);
            return await this.queueOperation(serverId, operation);
        }
        
        // If in retry state, queue with longer timeout
        if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
            this.log(`Queueing ${operationName} for ${serverId} - connection retry in progress`);
            return await this.queueOperation(serverId, operation, 15000);
        }
        
        // If idle, trigger automatic reconnection if we have stored config
        if (state === CONNECTION_STATES.IDLE) {
            const storedConfig = this.storedConfigs.get(serverId);
            if (storedConfig) {
                this.log(`Triggering automatic reconnection for ${serverId} due to ${operationName}`);
                // Start reconnection in background
                this.scheduleImmediateRetry(serverId);
                // Queue the operation
                this.log(`Queueing ${operationName} for ${serverId} - triggering reconnection`);
                return await this.queueOperation(serverId, operation, 15000);
            } else {
                this.log(`No stored config for ${serverId} - cannot auto-reconnect`);
                throw new Error(`No ready connection for ${serverId} and no stored config for auto-reconnect`);
            }
        }
        
        // For permanent failures, throw error immediately
        throw new Error(`No ready connection for ${serverId} (state: ${state})`);
    }

    // Schedule immediate retry (for triggered reconnections)
    scheduleImmediateRetry(serverId) {
        // Clear any existing retry timer
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        this.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        
        this.log(`Scheduling immediate retry for ${serverId}`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            await this.attemptReconnection(serverId);
        }, 100); // Very short delay
        
        this.retryTimers.set(serverId, timer);
    }

    // Attempt reconnection with stored config
    async attemptReconnection(serverId) {
        const currentNodes = this.nodeRegistry.getRemainingNodesForServer(serverId);
        if (currentNodes === 0) {
            this.log(`No nodes left for ${serverId}, skipping reconnection`);
            return;
        }

        const storedConfig = this.storedConfigs.get(serverId);
        if (!storedConfig) {
            this.log(`No stored config for ${serverId}, cannot reconnect`);
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            return;
        }

        try {
            this.log(`Attempting reconnection to ${serverId} with stored config`);
            this.setConnectionState(serverId, CONNECTION_STATES.IDLE);
            await this.getConnection(serverId, storedConfig);
        } catch (error) {
            this.error(`Reconnection failed for ${serverId}: ${error.message}`);
            this.handleConnectionError(serverId, error);
        }
    }

    async getConnection(serverId, config) {
        // Store config for reconnection
        this.storedConfigs.set(serverId, { ...config });
        
        const configHash = this.generateConfigHash(config);
        const oldHash = this.connectionConfigs.get(serverId);
        
        // Check for configuration changes
        if (oldHash && oldHash !== configHash) {
            this.log(`Configuration changed for ${serverId} - forcing cleanup`);
            await this.forceCleanupConnection(serverId);
        }
        
        this.connectionConfigs.set(serverId, configHash);

        // Return existing ready connection
        if (this.isConnectionReady(serverId)) {
            this.log(`Reusing ready connection for ${serverId}`);
            return this.connections.get(serverId);
        }

        // Return existing connection promise if already connecting
        let connectionPromise = this.connectionMutex.get(serverId);
        if (connectionPromise) {
            this.log(`Connection already in progress for ${serverId}, waiting...`);
            return await connectionPromise;
        }

        // Check if we should attempt a NEW connection
        if (!this.shouldAttemptConnection(serverId)) {
            const state = this.getConnectionState(serverId);
            
            // For event-only nodes, we can wait for connection recovery
            if (state === CONNECTION_STATES.RETRY_SCHEDULED || state === CONNECTION_STATES.NETWORK_ERROR) {
                this.log(`Connection in retry state for ${serverId} - node will be registered for recovery`);
                // Return a "dummy" client that will trigger recovery callback registration
                return { isClientReady: () => false, connected: false };
            }
            
            throw new Error(`Connection not possible in state: ${state}`);
        }

        // Create new connection
        this.log(`Creating new connection for ${serverId}`);
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
        
        this.log(`Creating connection ${connectionId} to ${serverId} (${useSSL ? 'SSL' : 'non-SSL'}, ${useAuth ? 'OAuth2' : 'no-auth'})`);
        
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
            
            this.log(`Connection ${connectionId} established to ${serverId}`);
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
            this.log(`Connected to ${serverId} (connection ${connectionId})`);
        });

        client.on('disconnect', () => {
            this.log(`Disconnected from ${serverId} (connection ${connectionId})`);
            this.handleDisconnection(serverId);
        });

        client.on('reconnect', () => {
            this.log(`Reconnected to ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);
        });

        client.on('ready', () => {
            this.log(`Client ready for ${serverId} (connection ${connectionId})`);
            this.setConnectionState(serverId, CONNECTION_STATES.CONNECTED);
            this.handleClientReady(serverId, client);
        });

        client.on('stateChange', (id, state) => {
            this.nodeRegistry.handleStateChange(id, state);
        });

        client.on('tokenRefresh', (newToken, oldToken) => {
            this.log(`Token refreshed for ${serverId}`);
        });
    }

    handleConnectionError(serverId, error) {
        // Prevent duplicate error handling for the same connection attempt
        if (this.connectionMutex.has(serverId)) {
            this.connectionMutex.delete(serverId);
        } else {
            // This is a duplicate error event, ignore it
            return;
        }
        
        const errorMsg = error.message || error.toString();
        this.error(`Connection error for ${serverId}: ${errorMsg}`);
        
        // Classify error type
        if (this.isAuthenticationError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.AUTH_FAILED);
            this.error(`Authentication failed permanently for ${serverId}`);
        } else if (this.isNetworkError(errorMsg)) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
            this.scheduleRetry(serverId);
        } else {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
            this.scheduleRetry(serverId);
        }
    }

    handleDisconnection(serverId) {
        const state = this.getConnectionState(serverId);
        
        // Only schedule retry if we were connected and it's not intentional destruction
        if (state === CONNECTION_STATES.CONNECTED) {
            this.setConnectionState(serverId, CONNECTION_STATES.NETWORK_ERROR);
            this.scheduleRetry(serverId);
        }
    }

    async handleClientReady(serverId, client) {
        // Execute any pending recovery callbacks
        this.nodeRegistry.executeRecoveryCallbacks(serverId);
        
        // Resubscribe states after short delay (includes initial values processing)
        setTimeout(async () => {
            await this.nodeRegistry.resubscribeStates(serverId, client);
        }, 100);
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

    scheduleRetry(serverId) {
        // Clear any existing retry timer
        const existingTimer = this.retryTimers.get(serverId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Only schedule retry if we have registered nodes for this server
        const remainingNodes = this.nodeRegistry.getRemainingNodesForServer(serverId);
        if (remainingNodes === 0) {
            this.log(`No nodes left for ${serverId}, not scheduling retry`);
            return;
        }

        this.setConnectionState(serverId, CONNECTION_STATES.RETRY_SCHEDULED);
        
        const retryDelay = 5000 + (Math.random() * 2000); // 5-7 seconds with jitter
        
        this.log(`Scheduling retry for ${serverId} in ${Math.round(retryDelay/1000)}s`);
        
        const timer = setTimeout(async () => {
            this.retryTimers.delete(serverId);
            
            // Check if we still have nodes and should retry
            const currentNodes = this.nodeRegistry.getRemainingNodesForServer(serverId);
            if (currentNodes > 0 && this.getConnectionState(serverId) === CONNECTION_STATES.RETRY_SCHEDULED) {
                this.log(`Executing scheduled retry for ${serverId}`);
                
                try {
                    await this.attemptReconnection(serverId);
                } catch (error) {
                    this.error(`Scheduled retry failed for ${serverId}: ${error.message}`);
                    // Schedule another retry if this one failed
                    setTimeout(() => {
                        if (this.nodeRegistry.getRemainingNodesForServer(serverId) > 0) {
                            this.scheduleRetry(serverId);
                        }
                    }, 10000);
                }
            }
        }, retryDelay);
        
        this.retryTimers.set(serverId, timer);
    }

    async forceCleanupConnection(serverId) {
        this.log(`Force cleanup for ${serverId}`);
        
        this.setConnectionState(serverId, CONNECTION_STATES.DESTROYING);
        
        // Clear timers
        const timer = this.retryTimers.get(serverId);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(serverId);
        }
        
        // Clear queued operations
        this.clearOperationQueue(serverId, new Error('Connection destroyed'));
        
        // Clear connection promise
        this.connectionMutex.delete(serverId);
        
        // Destroy client
        const client = this.connections.get(serverId);
        if (client) {
            try {
                client.setConnectionRecovery(false);
                client.destroy();
            } catch (error) {
                this.error(`Error destroying client for ${serverId}: ${error.message}`);
            }
        }
        
        // Clean up references
        this.connections.delete(serverId);
        this.connectionConfigs.delete(serverId);
        // NOTE: Keep storedConfigs for potential reconnection
        this.nodeRegistry.clearRecoveryCallbacks(serverId);
        
        // Reset to idle state
        this.setConnectionState(serverId, CONNECTION_STATES.IDLE);
        
        this.log(`Cleanup completed for ${serverId}`);
    }

    async closeConnection(serverId) {
        this.log(`Closing connection for ${serverId}`);
        await this.forceCleanupConnection(serverId);
        
        // Only remove stored config when explicitly closing (not just cleaning up)
        this.storedConfigs.delete(serverId);
    }

    // Node lifecycle methods
    registerNode(nodeId, serverId, type) {
        return this.nodeRegistry.registerNode(nodeId, serverId, type);
    }

    unregisterNode(nodeId) {
        const serverId = this.nodeRegistry.unregisterNode(nodeId);
        if (serverId) {
            const remainingNodes = this.nodeRegistry.getRemainingNodesForServer(serverId);
            if (remainingNodes === 0) {
                this.log(`No more nodes for ${serverId}, closing connection`);
                this.closeConnection(serverId);
            }
        }
    }

    // Node operations with improved error handling
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
        this.log(`Force server switch: ${oldServerId} -> ${newServerId}`);
        
        await this.forceCleanupConnection(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.connectionConfigs.set(newServerId, newHash);
        
        this.log(`Server switch completed: ${oldServerId} -> ${newServerId}`);
    }

    // State operations with queueing support
    async getState(serverId, stateId) {
        return await this.executeOperation(serverId, async () => {
            const client = this.connections.get(serverId);
            if (!client || !client.isClientReady()) {
                throw new Error(`No ready connection for ${serverId}`);
            }
            return await client.getState(stateId);
        }, `getState(${stateId})`);
    }

    async setState(serverId, stateId, value, ack = true) {
        return await this.executeOperation(serverId, async () => {
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
        }, `setState(${stateId})`);
    }

    async getStates(serverId) {
        return await this.executeOperation(serverId, async () => {
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
        }, 'getStates');
    }

    async getObject(serverId, objectId) {
        return await this.executeOperation(serverId, async () => {
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
        }, `getObject(${objectId})`);
    }

    async setObject(serverId, objectId, objectDef) {
        return await this.executeOperation(serverId, async () => {
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
        }, `setObject(${objectId})`);
    }

    getConnectionStatus(serverId) {
        const state = this.getConnectionState(serverId);
        const client = this.connections.get(serverId);
        const queueSize = this.operationQueues.get(serverId)?.length || 0;
        
        let connected = false;
        let ready = false;
        let status = state;
        
        if (client) {
            connected = client.connected;
            ready = client.isClientReady();
        }
        
        return {
            connected: connected,
            ready: ready,
            status: status,
            serverId: serverId,
            connectionState: state,
            queuedOperations: queueSize,
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

    handleUncaughtException(error) {
        this.error(`Uncaught Exception: ${error.message}`);
        this.cleanup();
    }

    handleUnhandledRejection(reason, promise) {
        this.error(`Unhandled Rejection: ${reason}`);
    }

    async cleanup() {
        this.log('Cleanup started');
        
        // Clear all timers
        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();
        
        // Clear all operation queues
        for (const [serverId] of this.operationQueues) {
            this.clearOperationQueue(serverId, new Error('Manager cleanup'));
        }
        this.operationQueues.clear();
        
        // Clear connection promises
        this.connectionMutex.clear();
        
        // Destroy all connections
        for (const [serverId, client] of this.connections) {
            try {
                client.setConnectionRecovery(false);
                client.destroy();
            } catch (error) {
                this.error(`Error destroying client for ${serverId}: ${error.message}`);
            }
        }
        
        this.connections.clear();
        this.connectionStates.clear();
        this.connectionConfigs.clear();
        this.storedConfigs.clear();
        this.nodeRegistry.cleanup();
        
        this.log('Cleanup completed');
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;