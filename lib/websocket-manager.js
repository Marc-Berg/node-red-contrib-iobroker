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
        this.lastKnownValues = new Map();
        this.recoveryCallbacks = new Map();
        this.initialStatesSent = new Map();
        this.reconnectionCount = new Map();
        
        this.deployCounter = 0;
        this.isDeployActive = false;
        this.deployTimeout = null;
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

    registerRecoveryCallback(serverId, callback) {
        if (!this.recoveryCallbacks.has(serverId)) {
            this.recoveryCallbacks.set(serverId, new Set());
        }
        this.recoveryCallbacks.get(serverId).add(callback);
        this.log(`Registered recovery callback for ${serverId} (total: ${this.recoveryCallbacks.get(serverId).size})`);
    }

    removeRecoveryCallback(serverId, callback) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.recoveryCallbacks.delete(serverId);
            }
        }
    }

    executeRecoveryCallbacks(serverId) {
        const callbacks = this.recoveryCallbacks.get(serverId);
        if (callbacks && callbacks.size > 0) {
            this.log(`Executing ${callbacks.size} recovery callbacks for ${serverId}`);
            
            const callbacksToExecute = Array.from(callbacks);
            callbacks.clear();
            this.recoveryCallbacks.delete(serverId);
            
            callbacksToExecute.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.error(`Recovery callback error for ${serverId}: ${error.message}`);
                }
            });
        }
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
            
            this.lastKnownValues.delete(serverId);
            this.initialStatesSent.delete(serverId);
            this.reconnectionCount.delete(serverId);
        }
        
        this.configHashes.set(serverId, configHash);

        const existing = this.connections.get(serverId);
        if (existing && existing.client && existing.client.connected) {
            this.log(`Reusing existing connection for ${serverId}`);
            return existing.client;
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

            client.on('stateChange', (id, state) => {
                this.handleStateChange(id, state);
            });

            client.on('tokenRefresh', (newToken, oldToken) => {
                this.handleTokenRefresh(serverId, newToken, oldToken);
            });

            // Configure connection options
            const connectOptions = {
                name: `NodeRED-${this.deployCounter}-${connectionId}`,
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

            // Store connection info
            const connectionInfo = {
                client: client,
                config: { ...config },
                connectionId: connectionId,
                createdAt: Date.now(),
                useSSL: useSSL,
                authMethod: useAuth ? 'oauth2' : 'none'
            };
            
            this.connections.set(serverId, connectionInfo);

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
            throw error;
        }
    }

    handleConnectionSuccess(serverId, connectionId) {
        this.log(`Connected to ${serverId} (connection ${connectionId}) - connection now available for sharing`);
        
        const currentReconnections = this.reconnectionCount.get(serverId) || 0;
        const isFirstConnection = currentReconnections === 0;
        this.reconnectionCount.set(serverId, currentReconnections + 1);
        
        this.connectionMutex.delete(serverId);
        this.updateNodeStatus(serverId, 'connected');
        
        const hadRecoveryCallbacks = this.recoveryCallbacks.has(serverId) && this.recoveryCallbacks.get(serverId).size > 0;
        this.executeRecoveryCallbacks(serverId);
        
        setTimeout(() => {
            if (hadRecoveryCallbacks) {
                this.log(`Recovery callbacks handled subscriptions for ${serverId}, no additional actions needed`);
                
            } else if (isFirstConnection) {
                this.log(`First normal connection to ${serverId}, performing initial state synchronization only`);
                this.synchronizeStateValues(serverId);
                
            } else {
                this.log(`Reconnection to ${serverId}, resubscribing states`);
                this.resubscribeStates(serverId);
            }
        }, 1000);
    }

    handleConnectionDisconnect(serverId, connectionId) {
        this.log(`Disconnected from ${serverId} (connection ${connectionId})`);
        this.updateNodeStatus(serverId, 'disconnected');
    }

    handleConnectionReconnect(serverId, connectionId) {
        this.log(`Reconnected to ${serverId} (connection ${connectionId})`);
        this.updateNodeStatus(serverId, 'connected');
        
        setTimeout(() => {
            this.resubscribeStates(serverId);
            this.log(`Reconnection to ${serverId}, skipping state synchronization to prevent duplicate messages`);
        }, 1000);
    }

    handleConnectionError(serverId, error) {
        // Clear the connection mutex on error
        this.connectionMutex.delete(serverId);
        
        this.error(`Connection error for ${serverId}: ${error.message || error}`);
        this.updateNodeStatus(serverId, 'disconnected');
    }

    handleTokenRefresh(serverId, newToken, oldToken) {
        this.log(`Token refreshed for ${serverId}`);
        this.updateNodeStatus(serverId, 'connected');
    }

    async closeConnection(serverId) {
        this.connectionMutex.delete(serverId);
        
        const connectionInfo = this.connections.get(serverId);
        if (connectionInfo && connectionInfo.client) {
            try {
                connectionInfo.client.destroy();
                this.log(`Connection closed for ${serverId}`);
            } catch (err) {
                this.error(`Error closing connection for ${serverId}: ${err.message}`);
            }
        }
        
        this.connections.delete(serverId);
        this.updateNodeStatus(serverId, 'disconnected');
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

    registerNode(nodeId, serverId, type, skipDeploy = false) {
        if (!skipDeploy && !this.isDeployActive) {
            this.startDeploy();
        }
        
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            registeredAt: Date.now(),
            deployNumber: this.deployCounter  // NEW: Track which deploy this node belongs to
        });
        
        if (!skipDeploy && this.deployTimeout) {
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
            
            const remainingNodes = Array.from(this.nodeRegistrations.values())
                .filter(reg => reg.serverId === registration.serverId);
            
            if (remainingNodes.length === 0) {
                this.closeConnection(registration.serverId);
                this.configHashes.delete(registration.serverId);
                this.lastKnownValues.delete(registration.serverId);
                this.initialStatesSent.delete(registration.serverId);
                this.reconnectionCount.delete(registration.serverId);
            }
        }
    }

    updateNodeStatus(serverId, status) {
        // Update all callbacks for nodes using this server
        this.callbacks.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });

        // Update all event nodes for this server
        this.eventNodes.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.error(`Status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });
    }

    processSubscriptions() {
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration) {
                    const connectionInfo = this.connections.get(registration.serverId);
                    if (connectionInfo && connectionInfo.client && connectionInfo.client.connected) {
                        this.subscribeToState(connectionInfo.client, stateId);
                    }
                }
            });
        });
    }

    async resubscribeStates(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
            return;
        }
        
        const statesToSubscribe = new Set();
        const nodeCallbacks = new Map(); // Track which callbacks belong to which states
        
        this.subscriptions.forEach((nodeIds, stateId) => {
            nodeIds.forEach(nodeId => {
                const registration = this.nodeRegistrations.get(nodeId);
                if (registration && registration.serverId === serverId) {
                    statesToSubscribe.add(stateId);
                    
                    // Track callback for this node+state combination
                    const callback = this.callbacks.get(nodeId);
                    if (callback) {
                        if (!nodeCallbacks.has(stateId)) {
                            nodeCallbacks.set(stateId, new Set());
                        }
                        nodeCallbacks.get(stateId).add(callback);
                    }
                }
            });
        });
        
        if (statesToSubscribe.size > 0) {
            this.log(`Resubscribing to ${statesToSubscribe.size} states for ${serverId}`);
            for (const stateId of statesToSubscribe) {
                try {
                    await this.subscribeToState(connectionInfo.client, stateId);
                    
                    // Trigger onSubscribed callbacks for all nodes subscribed to this state (eventgetriggert!)
                    const callbacks = nodeCallbacks.get(stateId);
                    if (callbacks) {
                        callbacks.forEach(callback => {
                            if (callback.onSubscribed) {
                                callback.onSubscribed();
                            }
                        });
                    }
                    
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
                else resolve();
            });
        });
    }

    handleStateChange(stateId, state) {
        const matchingNodeIds = new Set();
        
        // Find all nodes that match this state
        this.subscriptions.forEach((nodeIds, pattern) => {
            if (this.matchesPattern(stateId, pattern)) {
                nodeIds.forEach(nodeId => matchingNodeIds.add(nodeId));
            }
        });

        if (matchingNodeIds.size === 0) return;

        this.updateLastKnownValue(stateId, state);

        // Call callbacks for matching nodes
        matchingNodeIds.forEach(nodeId => {
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

    matchesPattern(stateId, pattern) {
        if (stateId === pattern) return true;
        
        if (pattern.includes('*')) {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(stateId);
        }
        
        return false;
    }

    updateLastKnownValue(stateId, state) {
        this.subscriptions.get(stateId)?.forEach(nodeId => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration) {
                const serverId = registration.serverId;
                if (!this.lastKnownValues.has(serverId)) {
                    this.lastKnownValues.set(serverId, new Map());
                }
                
                const serverStates = this.lastKnownValues.get(serverId);
                serverStates.set(stateId, {
                    val: state.val,
                    ack: state.ack,
                    ts: state.ts,
                    lc: state.lc
                });
            }
        });
    }

    async synchronizeStateValues(serverId) {
        try {
            const connectionInfo = this.connections.get(serverId);
            if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
                return;
            }

            const statesToSync = new Set();
            const nodesWantingInitial = new Map(); // Track which nodes want initial values
            
            this.subscriptions.forEach((nodeIds, stateId) => {
                nodeIds.forEach(nodeId => {
                    const registration = this.nodeRegistrations.get(nodeId);
                    if (registration && registration.serverId === serverId) {
                        // Check if this specific node wants initial values
                        const callback = this.callbacks.get(nodeId);
                        if (callback && callback.wantsInitialValue) {
                            statesToSync.add(stateId);
                            if (!nodesWantingInitial.has(stateId)) {
                                nodesWantingInitial.set(stateId, new Set());
                            }
                            nodesWantingInitial.get(stateId).add(nodeId);
                        }
                    }
                });
            });

            if (statesToSync.size === 0) {
                this.log(`No states requiring initial synchronization for ${serverId}`);
                return;
            }

            this.log(`Synchronizing ${statesToSync.size} states for nodes with sendInitialValue enabled on ${serverId}`);

            if (!this.initialStatesSent.has(serverId)) {
                this.initialStatesSent.set(serverId, new Set());
            }
            const sentStates = this.initialStatesSent.get(serverId);

            for (const stateId of statesToSync) {
                try {
                    const currentState = await this.getState(serverId, stateId);
                    if (currentState) {
                        // NEW: Check if this is a deploy-related initial value
                        const wantingNodes = nodesWantingInitial.get(stateId);
                        if (wantingNodes) {
                            wantingNodes.forEach(nodeId => {
                                const nodeStateKey = `${nodeId}:${stateId}`;
                                
                                // NEW: Only send if not already sent for this node or if this is a new deploy
                                const registration = this.nodeRegistrations.get(nodeId);
                                const nodeDeployNumber = registration ? registration.deployNumber : 0;
                                const isNewDeploy = nodeDeployNumber === this.deployCounter;
                                
                                if (!sentStates.has(nodeStateKey) || isNewDeploy) {
                                    const callback = this.callbacks.get(nodeId);
                                    if (callback && callback.isDeployConnection) {
                                        callback(stateId, currentState);
                                        sentStates.add(nodeStateKey);
                                        this.log(`Initial value sent for node ${nodeId} state ${stateId} (deploy #${this.deployCounter})`);
                                    }
                                }
                            });
                        }
                    }
                    await new Promise(r => setTimeout(r, 25));
                } catch (err) {
                    this.error(`Failed to sync state ${stateId}: ${err.message}`);
                }
            }
            
        } catch (error) {
            this.error(`State synchronization error for ${serverId}: ${error.message}`);
        }
    }

    // NEW: Method to send initial value for specific node (called from node logic)
    async sendInitialValueForNode(serverId, stateId, nodeId, isDeployConnection = false) {
        try {
            const connectionInfo = this.connections.get(serverId);
            if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
                this.log(`Cannot send initial value for ${stateId} - no connection to ${serverId}`);
                return;
            }

            if (!this.initialStatesSent.has(serverId)) {
                this.initialStatesSent.set(serverId, new Set());
            }
            const sentStates = this.initialStatesSent.get(serverId);
            const nodeStateKey = `${nodeId}:${stateId}`;

            // NEW: Only send initial values for deploy connections, not reconnections
            if (!isDeployConnection) {
                this.log(`Skipping initial value for node ${nodeId} state ${stateId} - this is a reconnection, not a deploy`);
                return;
            }

            if (sentStates.has(nodeStateKey)) {
                this.log(`Initial value already sent for node ${nodeId} state ${stateId}, skipping`);
                return;
            }

            const currentState = await this.getState(serverId, stateId);
            if (currentState) {
                this.updateLastKnownValue(stateId, currentState);
                
                const callback = this.callbacks.get(nodeId);
                if (callback) {
                    callback(stateId, currentState);
                    sentStates.add(nodeStateKey);
                    this.log(`Initial value sent for node ${nodeId} state ${stateId} (deploy connection)`);
                } else {
                    this.log(`No callback found for node ${nodeId}`);
                }
            } else {
                this.log(`No current state found for ${stateId}`);
            }
            
        } catch (error) {
            this.error(`Failed to send initial value for node ${nodeId} state ${stateId}: ${error.message}`);
        }
    }

    getCachedStateValue(serverId, stateId) {
        const serverStates = this.lastKnownValues.get(serverId);
        if (!serverStates || !serverStates.has(stateId)) {
            return null;
        }
        return serverStates.get(stateId);
    }

    async subscribe(nodeId, serverId, stateIdOrPattern, callback, config, isRecovery = false) {
        try {
            // Skip deploy trigger during recovery
            this.registerNode(nodeId, serverId, 'subscribe', isRecovery);
            
            const client = await this.getConnection(serverId, config);
            
            this.callbacks.set(nodeId, callback);
            
            if (!this.subscriptions.has(stateIdOrPattern)) {
                this.subscriptions.set(stateIdOrPattern, new Set());
            }
            this.subscriptions.get(stateIdOrPattern).add(nodeId);
            
            // Subscribe to state if connected
            if (client.connected) {
                await this.subscribeToState(client, stateIdOrPattern);
            }
            
            this.log(`Subscribed node ${nodeId} to ${stateIdOrPattern.includes('*') ? 'wildcard pattern' : 'single state'}: ${stateIdOrPattern}`);
            
            // Trigger onSubscribed callback immediately after successful subscription
            if (callback.onSubscribed) {
                callback.onSubscribed();
            }
            
        } catch (error) {
            this.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            
            // Register recovery callback for retry when connection becomes available
            if (!isRecovery) { // Only register recovery callback if this isn't already a recovery attempt
                const recoveryCallback = () => {
                    this.log(`Attempting recovery subscription for node ${nodeId} to ${stateIdOrPattern}`);
                    this.subscribe(nodeId, serverId, stateIdOrPattern, callback, config, true) // Mark as recovery
                        .catch(retryError => {
                            this.error(`Recovery subscription failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async registerForEvents(nodeId, serverId, callback, config, isRecovery = false) {
        try {
            // Skip deploy trigger during recovery
            this.registerNode(nodeId, serverId, 'events', isRecovery);
            
            await this.getConnection(serverId, config);
            this.eventNodes.set(nodeId, callback);
            
        } catch (error) {
            this.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            
            // Register recovery callback for retry when connection becomes available
            if (!isRecovery) { // Only register recovery callback if this isn't already a recovery attempt
                const recoveryCallback = () => {
                    this.log(`Attempting recovery event registration for node ${nodeId}`);
                    this.registerForEvents(nodeId, serverId, callback, config, true) // Mark as recovery
                        .catch(retryError => {
                            this.error(`Recovery event registration failed for node ${nodeId}: ${retryError.message}`);
                        });
                };
                
                this.registerRecoveryCallback(serverId, recoveryCallback);
            }
            throw error;
        }
    }

    async getState(serverId, stateId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get state timeout')), 10000);
            connectionInfo.client.emit('getState', stateId, (err, state) => {
                clearTimeout(timeout);
                if (err) {
                    reject(err);
                } else {
                    resolve(state);
                }
            });
        });
    }

    async setState(serverId, stateId, value, ack = true) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Set state timeout')), 8000);
            const state = { val: value, ack, from: 'system.adapter.node-red', ts: Date.now() };
            connectionInfo.client.emit('setState', stateId, state, (err) => {
                clearTimeout(timeout);
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async getStates(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get states timeout')), 15000);
            connectionInfo.client.emit('getStates', '*', (err, states) => {
                clearTimeout(timeout);
                if (err) {
                    reject(err);
                } else {
                    resolve(states);
                }
            });
        });
    }

    async getObject(serverId, objectId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.client.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);
            connectionInfo.client.emit('getObject', objectId, (err, obj) => {
                clearTimeout(timeout);
                if (err) {
                    reject(err);
                } else {
                    resolve(obj);
                }
            });
        });
    }

    async unsubscribe(nodeId, serverId, stateIdOrPattern) {
        try {
            const nodeIds = this.subscriptions.get(stateIdOrPattern);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateIdOrPattern);
                const connectionInfo = this.connections.get(serverId);
                if (connectionInfo && connectionInfo.client && connectionInfo.client.connected) {
                    connectionInfo.client.emit('unsubscribe', stateIdOrPattern, () => {});
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
        await this.closeConnection(oldServerId);
        this.connections.delete(oldServerId);
        this.configHashes.delete(oldServerId);
        this.lastKnownValues.delete(oldServerId);
        this.initialStatesSent.delete(oldServerId);
        this.reconnectionCount.delete(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.configHashes.set(newServerId, newHash);
    }

    getConnectionStatus(serverId) {
        const connectionInfo = this.connections.get(serverId);
        const hasRecoveryCallbacks = this.recoveryCallbacks.has(serverId) && 
                                    this.recoveryCallbacks.get(serverId).size > 0;
        
        // No connection info - check if we have recovery callbacks (means connection was attempted)
        if (!connectionInfo) {
            if (hasRecoveryCallbacks) {
                return {
                    connected: false,
                    status: 'retrying',
                    serverId: serverId,
                    deployNumber: this.deployCounter,
                    isDeployActive: this.isDeployActive,
                    lastError: 'Connection failed, recovery pending',
                    recoveryMode: true,
                    pendingRecoveryCallbacks: this.recoveryCallbacks.get(serverId)?.size || 0
                };
            }
            
            // Truly not configured
            return {
                connected: false,
                status: 'not_configured',
                serverId: serverId,
                deployNumber: this.deployCounter,
                isDeployActive: this.isDeployActive
            };
        }

        const client = connectionInfo.client;
        const stats = client ? client.getConnectionStats() : {};
        
        let status = 'disconnected';
        let connected = false;
        let detailedStatus = {};
        
        // Check connection info status first
        if (connectionInfo.status === 'connecting') {
            status = 'connecting';
        } else if (connectionInfo.status === 'failed') {
            if (stats.permanentFailure) {
                status = 'failed_permanently';
                detailedStatus.reason = connectionInfo.lastError || stats.lastError || 'Authentication failed';
            } else if (stats.productionMode) {
                status = 'retrying_production';
                detailedStatus.nextRetryIn = 'up to 65 seconds';
                detailedStatus.lastError = connectionInfo.lastError || stats.lastError;
            } else if (stats.retryAttempts > 0 || hasRecoveryCallbacks) {
                status = 'retrying';
                detailedStatus.attempts = `${stats.retryAttempts || 0}/${stats.maxRetryAttempts || 50}`;
                detailedStatus.lastError = connectionInfo.lastError || stats.lastError;
            } else {
                status = 'connection_failed';
                detailedStatus.lastError = connectionInfo.lastError || stats.lastError;
            }
        } else if (this.connectionMutex.has(serverId)) {
            status = 'connecting';
        } else if (client && client.connected) {
            status = 'connected';
            connected = true;
        } else if (client) {
            // Connection exists but not connected - check retry state
            if (stats.permanentFailure) {
                status = 'failed_permanently';
                detailedStatus.reason = stats.lastError || 'Authentication failed';
            } else if (stats.productionMode) {
                status = 'retrying_production';
                detailedStatus.nextRetryIn = 'up to 65 seconds';
            } else if (stats.retryAttempts > 0) {
                status = 'retrying';
                detailedStatus.attempts = `${stats.retryAttempts}/${stats.maxRetryAttempts}`;
            } else {
                status = 'disconnected';
            }
        }

        return {
            connected: connected,
            status: status,
            serverId: serverId,
            connectionId: connectionInfo.connectionId,
            deployNumber: this.deployCounter,
            isDeployActive: this.isDeployActive,
            ssl: {
                enabled: connectionInfo.useSSL || false,
                protocol: connectionInfo.useSSL ? 'wss/https' : 'ws/http'
            },
            authentication: {
                method: connectionInfo.authMethod,
                authenticated: client ? client.authenticated : false
            },
            connectionInfo: {
                created: connectionInfo.createdAt,
                failed: connectionInfo.failedAt || null,
                isConnecting: this.connectionMutex.has(serverId),
                reconnectionCount: this.reconnectionCount.get(serverId) || 0,
                internalStatus: connectionInfo.status || 'unknown'
            },
            retryInfo: {
                isRetrying: stats.retryAttempts > 0 || hasRecoveryCallbacks,
                attempts: stats.retryAttempts || 0,
                maxAttempts: stats.maxRetryAttempts || 50,
                productionMode: stats.productionMode || false,
                permanentFailure: stats.permanentFailure || false,
                lastError: connectionInfo.lastError || stats.lastError || null,
                connectionRecoveryEnabled: stats.connectionRecoveryEnabled !== false
            },
            clientStats: stats,
            detailedStatus: detailedStatus,
            recoveryMode: hasRecoveryCallbacks,
            pendingRecoveryCallbacks: hasRecoveryCallbacks ? this.recoveryCallbacks.get(serverId).size : 0
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
        
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = null;
        }
        
        this.connectionMutex.clear();
        this.recoveryCallbacks.clear();
        
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
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.lastKnownValues.clear();
        this.initialStatesSent.clear();
        this.reconnectionCount.clear();
        
        this.log('Cleanup completed');
    }
}

const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;