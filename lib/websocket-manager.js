// WebSocket Manager with Proactive Token Refresh
const { SocketClient } = require('./iobroker-ws-client-nodejs');
const crypto = require('crypto');

class WebSocketManager {
    constructor() {
        this.connections = new Map();
        this.configHashes = new Map();
        this.connectionMutex = new Map();
        this.pendingConnections = new Map();
        this.reconnectTimers = new Map();
        
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.eventNodes = new Map();
        this.nodeRegistrations = new Map();
        this.authFailures = new Map();
        
        // Token refresh management
        this.tokenRefreshTimers = new Map();
        this.activeTokenRefreshes = new Map();
        
        // State value tracking for change detection
        this.lastKnownValues = new Map(); // serverId -> Map(stateId -> lastValue)
        
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

    generateConnectionId() {
        return ++this.connectionId;
    }

    generateConfigHash(config) {
        const configForHash = {
            iobhost: config.iobhost,
            iobport: config.iobport,
            user: config.user || '',
            password: config.password || ''
        };
        return crypto.createHash('md5').update(JSON.stringify(configForHash)).digest('hex');
    }

    async cancelPendingConnections(serverId, reason = 'Config change') {
        if (this.connectionMutex.has(serverId)) {
            const pendingPromise = this.connectionMutex.get(serverId);
            this.connectionMutex.delete(serverId);
            
            try {
                if (pendingPromise && typeof pendingPromise.cancel === 'function') {
                    pendingPromise.cancel();
                }
            } catch (error) {
                // Silent fail for cancelled connections
            }
        }
        
        if (this.pendingConnections.has(serverId)) {
            const pending = this.pendingConnections.get(serverId);
            
            pending.forEach(({ client, cancel }) => {
                try {
                    if (cancel && typeof cancel === 'function') {
                        cancel();
                    }
                    if (client && typeof client.destroy === 'function') {
                        client.destroy();
                    }
                } catch (error) {
                    // Silent fail for cleanup
                }
            });
            
            this.pendingConnections.delete(serverId);
        }

        // Clear any pending reconnect timers
        if (this.reconnectTimers.has(serverId)) {
            clearTimeout(this.reconnectTimers.get(serverId));
            this.reconnectTimers.delete(serverId);
        }

        // Clear token refresh timers and active refreshes
        this.clearTokenRefreshState(serverId);
    }

    clearTokenRefreshState(serverId) {
        if (this.tokenRefreshTimers.has(serverId)) {
            clearTimeout(this.tokenRefreshTimers.get(serverId));
            this.tokenRefreshTimers.delete(serverId);
        }
        
        if (this.activeTokenRefreshes.has(serverId)) {
            this.activeTokenRefreshes.delete(serverId);
        }
    }

    async handleTokenRefresh(serverId, client, oldToken, newToken) {
        try {
            this.log(`Token and session refreshed for ${serverId}`);
            
            const connectionInfo = this.connections.get(serverId);
            if (connectionInfo) {
                connectionInfo.lastTokenRefresh = Date.now();
                if (connectionInfo.authenticationInfo) {
                    connectionInfo.authenticationInfo.lastTokenRefresh = Date.now();
                    connectionInfo.authenticationInfo.tokenRefreshCount = (connectionInfo.authenticationInfo.tokenRefreshCount || 0) + 1;
                }
                connectionInfo.connectionStats.totalTokenRefreshes = (connectionInfo.connectionStats.totalTokenRefreshes || 0) + 1;
            }

            // Clear any existing refresh timer since client handles its own scheduling
            this.clearTokenRefreshState(serverId);
            
            // Update all related nodes about successful token refresh
            this.updateNodeStatus(serverId, 'connected');
            
            // Trigger resubscription and state synchronization after connection rebuild
            setTimeout(() => {
                this.resubscribeStates(serverId);
                // Synchronize current state values to catch any missed updates during reconnection
                this.synchronizeStateValues(serverId);
            }, 1000);
            
        } catch (error) {
            this.error(`Token refresh handling error for ${serverId}: ${error.message}`);
        }
    }

    async synchronizeStateValues(serverId, isInitialConnection = false) {
        try {
            const actionType = isInitialConnection ? 'initial connection' : 'session renewal';
            this.log(`Synchronizing state values after ${actionType} for ${serverId}`);
            
            const connectionInfo = this.connections.get(serverId);
            if (!connectionInfo || !connectionInfo.connected) {
                return;
            }

            // Get all states that this server has subscriptions for
            const statesToSync = new Set();
            
            this.subscriptions.forEach((nodeIds, stateId) => {
                if (stateId.startsWith('_dummy_')) return;
                
                nodeIds.forEach(nodeId => {
                    const registration = this.nodeRegistrations.get(nodeId);
                    if (registration && registration.serverId === serverId) {
                        statesToSync.add(stateId);
                    }
                });
            });

            if (statesToSync.size === 0) {
                this.log(`No states to synchronize for ${serverId}`);
                return;
            }

            this.log(`Synchronizing ${statesToSync.size} states for ${serverId} (${actionType})`);

            let changedStates = 0;
            let unchangedStates = 0;
            let initialStates = 0;

            // Query current value for each subscribed state
            for (const stateId of statesToSync) {
                try {
                    const currentState = await this.getState(serverId, stateId);
                    if (currentState) {
                        if (isInitialConnection) {
                            // Initial connection: Just store values without triggering callbacks
                            this.updateLastKnownValue(stateId, currentState);
                            initialStates++;
                        } else {
                            // Session renewal: Only trigger callbacks if value actually changed
                            if (this.hasValueChanged(serverId, stateId, currentState)) {
                                this.handleStateChange(stateId, currentState);
                                changedStates++;
                            } else {
                                // Update last known value without triggering callbacks
                                this.updateLastKnownValue(stateId, currentState);
                                unchangedStates++;
                            }
                        }
                    }
                    // Small delay to avoid overwhelming the server
                    await new Promise(r => setTimeout(r, 25));
                } catch (err) {
                    this.error(`Failed to sync state ${stateId}: ${err.message}`);
                }
            }

            if (isInitialConnection) {
                this.log(`Initial state synchronization completed for ${serverId}: ${initialStates} states stored`);
            } else {
                this.log(`State synchronization completed for ${serverId}: ${changedStates} changed, ${unchangedStates} unchanged`);
            }
            
        } catch (error) {
            this.error(`State synchronization error for ${serverId}: ${error.message}`);
        }
    }

    async getConnection(serverId, config) {
        const configHash = this.generateConfigHash(config);
        const oldHash = this.configHashes.get(serverId);
        
        if (oldHash && oldHash !== configHash) {
            this.log(`Configuration changed for ${serverId}`);
            
            await this.cancelPendingConnections(serverId, 'Configuration change');
            await this.closeConnection(serverId);
            
            this.connections.delete(serverId);
            this.configHashes.delete(serverId);
            this.authFailures.delete(serverId);
            
            this.clearAuthFailures(serverId);
        }
        
        this.configHashes.set(serverId, configHash);

        const existing = this.connections.get(serverId);
        if (existing && existing.connected && existing.client) {
            return existing.client;
        }

        if (this.connectionMutex.has(serverId)) {
            try {
                return await this.connectionMutex.get(serverId);
            } catch (error) {
                this.connectionMutex.delete(serverId);
            }
        }

        const connectionPromise = this.createConnection(serverId, config);
        this.connectionMutex.set(serverId, connectionPromise);
        
        try {
            const client = await connectionPromise;
            return client;
        } catch (error) {
            throw error;
        } finally {
            this.connectionMutex.delete(serverId);
        }
    }

    async createConnection(serverId, config) {
        const connectionId = this.generateConnectionId();
        const useAuth = !!(config.user && config.user.trim());
        
        this.log(`Creating connection ${connectionId} to ${serverId} (${useAuth ? 'OAuth2 with proactive refresh' : 'no-auth'})`);
        
        const connectionInfo = {
            connectionId,
            client: null,
            config: { ...config },
            connected: false,
            connecting: true,
            createdAt: Date.now(),
            lastConnectTime: null,
            lastDisconnectTime: null,
            lastTokenRefresh: null,
            authenticationInfo: {
                method: useAuth ? 'oauth2' : 'none',
                username: useAuth ? config.user : null,
                authenticated: false,
                lastAuthError: null,
                tokenRefreshCount: 0,
                lastTokenRefresh: null
            },
            connectionStats: {
                totalConnects: 0,
                totalDisconnects: 0,
                totalReconnects: 0,
                totalAuthFailures: 0,
                totalTokenRefreshes: 0
            }
        };
        
        this.connections.set(serverId, connectionInfo);

        if (!this.pendingConnections.has(serverId)) {
            this.pendingConnections.set(serverId, []);
        }

        let cancelled = false;
        const cancelFunction = () => {
            cancelled = true;
        };

        const pendingEntry = {
            connectionId,
            client: null,
            cancel: cancelFunction
        };
        
        this.pendingConnections.get(serverId).push(pendingEntry);

        try {
            if (cancelled) {
                throw new Error('Connection cancelled before start');
            }

            const client = new SocketClient();
            connectionInfo.client = client;
            pendingEntry.client = client;

            client.on('error', (err) => {
                if (cancelled) return;
                this.handleConnectionError(serverId, err, connectionInfo);
            });

            client.on('connect', () => {
                if (cancelled) {
                    client.destroy();
                    return;
                }
                this.handleConnectionSuccess(serverId, connectionInfo);
            });

            client.on('disconnect', () => {
                if (cancelled) return;
                this.handleConnectionDisconnect(serverId, connectionInfo);
            });

            client.on('reconnect', () => {
                if (cancelled) return;
                this.handleConnectionReconnect(serverId, connectionInfo);
            });

            client.on('stateChange', (id, state) => {
                if (!cancelled) {
                    this.handleStateChange(id, state);
                }
            });

            // Handle token refresh events
            client.on('tokenRefresh', (newToken, oldToken) => {
                if (!cancelled) {
                    this.handleTokenRefresh(serverId, client, oldToken, newToken);
                }
            });

            const connectOptions = {
                name: `NodeRED-${this.deployCounter}-${connectionId}`,
                connectMaxAttempt: 0, // Disable internal reconnect - we handle it
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

            if (cancelled) {
                throw new Error('Connection cancelled before attempt');
            }

            await this.attemptConnection(client, serverId, config, connectOptions, connectionId);

            if (cancelled) {
                client.destroy();
                throw new Error('Connection cancelled after attempt');
            }

            connectionInfo.connecting = false;
            this.clearAuthFailures(serverId);
            
            this.log(`Connection ${connectionId} established to ${serverId}${useAuth ? ' with proactive token refresh' : ''}`);
            
            return client;

        } catch (error) {
            this.handleConnectionCreationError(serverId, error, connectionInfo, connectionId);
            throw error;
        } finally {
            const pendingList = this.pendingConnections.get(serverId);
            if (pendingList) {
                const index = pendingList.findIndex(p => p.connectionId === connectionId);
                if (index !== -1) {
                    pendingList.splice(index, 1);
                }
                
                if (pendingList.length === 0) {
                    this.pendingConnections.delete(serverId);
                }
            }
        }
    }

    async attemptConnection(client, serverId, config, connectOptions, connectionId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Connection ${connectionId} timeout after ${connectOptions.connectTimeout}ms`));
            }, connectOptions.connectTimeout + 2000);
            
            let resolved = false;
            
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    client.off('connect', handleConnect);
                    client.off('error', handleError);
                }
            };
            
            const handleConnect = () => {
                cleanup();
                resolve();
            };
            
            const handleError = (err) => {
                cleanup();
                const errorMsg = err.message || err.toString();
                
                if (this.isAuthenticationError(err)) {
                    reject(new Error(`Authentication failed (400): ${errorMsg}`));
                } else {
                    reject(new Error(errorMsg));
                }
            };

            client.on('connect', handleConnect);
            client.on('error', handleError);

            try {
                const wsUrl = `ws://${config.iobhost}:${config.iobport}`;
                client.connect(wsUrl, connectOptions).catch(handleError);
            } catch (syncError) {
                cleanup();
                reject(syncError);
            }
        });
    }

    handleConnectionSuccess(serverId, connectionInfo) {
        this.log(`Connected to ${serverId} (connection ${connectionInfo.connectionId})`);
        
        connectionInfo.connected = true;
        connectionInfo.connecting = false;
        connectionInfo.lastConnectTime = Date.now();
        connectionInfo.authenticationInfo.authenticated = connectionInfo.authenticationInfo.method === 'oauth2';
        connectionInfo.connectionStats.totalConnects++;
        
        // Reset failure counters on successful connection
        connectionInfo.connectionStats.totalDisconnects = 0;
        connectionInfo.connectionStats.totalAuthFailures = 0;
        
        // Clear any pending reconnect timer
        if (this.reconnectTimers.has(serverId)) {
            clearTimeout(this.reconnectTimers.get(serverId));
            this.reconnectTimers.delete(serverId);
        }
        
        this.updateNodeStatus(serverId, 'connected');
        
        // Subscribe to states and get initial values (without triggering events)
        setTimeout(() => {
            this.resubscribeStates(serverId);
            this.synchronizeStateValues(serverId, true); // true = initial connection
        }, 1000);
    }

    handleConnectionDisconnect(serverId, connectionInfo) {
        this.log(`Disconnected from ${serverId} (connection ${connectionInfo.connectionId})`);
        
        connectionInfo.connected = false;
        connectionInfo.lastDisconnectTime = Date.now();
        connectionInfo.authenticationInfo.authenticated = false;
        connectionInfo.connectionStats.totalDisconnects++;
        
        // Clear token refresh state on disconnect
        this.clearTokenRefreshState(serverId);
        
        this.updateNodeStatus(serverId, 'disconnected');
        
        const failures = this.authFailures.get(serverId);
        if (!failures || failures.count < 3) {
            this.scheduleReconnect(serverId);
        }
    }

    handleConnectionReconnect(serverId, connectionInfo) {
        this.log(`Reconnected to ${serverId} (connection ${connectionInfo.connectionId})`);
        
        connectionInfo.connected = true;
        connectionInfo.lastConnectTime = Date.now();
        connectionInfo.authenticationInfo.authenticated = true;
        connectionInfo.connectionStats.totalReconnects++;
        
        // Clear any pending reconnect timer
        if (this.reconnectTimers.has(serverId)) {
            clearTimeout(this.reconnectTimers.get(serverId));
            this.reconnectTimers.delete(serverId);
        }
        
        this.updateNodeStatus(serverId, 'connected');
        
        // Resubscribe and synchronize states after reconnection (detect changes during offline time)
        setTimeout(() => {
            this.resubscribeStates(serverId);
            this.synchronizeStateValues(serverId, false); // false = check for changes during disconnect
        }, 1000);
    }

    handleConnectionError(serverId, err, connectionInfo) {
        const errorMsg = err.message || err.toString();
        this.error(`Connection error for ${serverId} (connection ${connectionInfo.connectionId}): ${errorMsg}`);
        
        connectionInfo.connected = false;
        connectionInfo.authenticationInfo.authenticated = false;
        connectionInfo.authenticationInfo.lastAuthError = errorMsg;
        
        // Clear token refresh state on error
        this.clearTokenRefreshState(serverId);
        
        if (this.isAuthenticationError(err)) {
            connectionInfo.connectionStats.totalAuthFailures++;
            this.recordAuthFailure(serverId, err);
        }
        
        this.updateNodeStatus(serverId, 'disconnected');
        
        if (this.shouldRetryConnection(serverId, err)) {
            this.scheduleReconnect(serverId);
        }
    }

    handleConnectionCreationError(serverId, error, connectionInfo, connectionId) {
        const errorMsg = error.message || error.toString();
        this.error(`Failed to create connection ${connectionId} to ${serverId}: ${errorMsg}`);
        
        connectionInfo.connecting = false;
        connectionInfo.connected = false;
        connectionInfo.authenticationInfo.lastAuthError = errorMsg;
        
        // Clear token refresh state on creation error
        this.clearTokenRefreshState(serverId);
        
        if (this.isAuthenticationError(error)) {
            connectionInfo.connectionStats.totalAuthFailures++;
            this.recordAuthFailure(serverId, error);
        }
        
        this.updateNodeStatus(serverId, 'disconnected');
        
        // Schedule reconnect for creation errors too (unless auth failure)
        if (this.shouldRetryConnection(serverId, error)) {
            this.scheduleReconnect(serverId);
        }
    }

    async closeConnection(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (connectionInfo && connectionInfo.client) {
            const connectionId = connectionInfo.connectionId;
            
            try {
                connectionInfo.client.destroy();
            } catch (err) {
                this.error(`Error destroying connection ${connectionId} to ${serverId}: ${err.message}`);
            }
            
            connectionInfo.client = null;
            connectionInfo.connected = false;
            connectionInfo.authenticationInfo.authenticated = false;
        }

        // Clear reconnect timer
        if (this.reconnectTimers.has(serverId)) {
            clearTimeout(this.reconnectTimers.get(serverId));
            this.reconnectTimers.delete(serverId);
        }

        // Clear token refresh state
        this.clearTokenRefreshState(serverId);
        
        const hasNodes = Array.from(this.nodeRegistrations.values())
            .some(reg => reg.serverId === serverId);
        
        if (!hasNodes) {
            this.connections.delete(serverId);
            this.configHashes.delete(serverId);
            this.authFailures.delete(serverId);
            this.lastKnownValues.delete(serverId);
        }
        
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
            
            const remainingNodes = Array.from(this.nodeRegistrations.values())
                .filter(reg => reg.serverId === registration.serverId);
            
            if (remainingNodes.length === 0) {
                this.closeConnection(registration.serverId);
                this.connections.delete(registration.serverId);
                this.configHashes.delete(registration.serverId);
                this.authFailures.delete(registration.serverId);
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
    }

    processSubscriptions() {
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
                else resolve();
            });
        });
    }

    handleStateChange(stateId, state) {
        const nodeIds = this.subscriptions.get(stateId);
        if (!nodeIds) return;

        // Track the new value for change detection during sync
        this.updateLastKnownValue(stateId, state);

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

    updateLastKnownValue(stateId, state) {
        // Find which server this state belongs to by checking node registrations
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

    hasValueChanged(serverId, stateId, newState) {
        const serverStates = this.lastKnownValues.get(serverId);
        if (!serverStates || !serverStates.has(stateId)) {
            // No previous value known, consider it changed
            return true;
        }

        const lastValue = serverStates.get(stateId);
        
        // Compare value, acknowledgment status, and last change timestamp
        return (
            lastValue.val !== newState.val ||
            lastValue.ack !== newState.ack ||
            lastValue.lc !== newState.lc
        );
    }

    scheduleReconnect(serverId) {
        const connectionInfo = this.connections.get(serverId);
        if (!connectionInfo) {
            return;
        }

        // Don't schedule if already connecting or connected
        if (connectionInfo.connecting || connectionInfo.connected) {
            return;
        }

        const hasNodes = Array.from(this.nodeRegistrations.values())
            .some(reg => reg.serverId === serverId);
        
        if (!hasNodes) {
            return;
        }

        const failures = this.authFailures.get(serverId);
        if (failures && failures.count >= 3) {
            return;
        }

        const configHash = this.configHashes.get(serverId);
        if (!configHash) {
            return;
        }

        const currentNodes = Array.from(this.nodeRegistrations.values())
            .filter(reg => reg.serverId === serverId);
        
        if (currentNodes.length === 0) {
            return;
        }

        // Clear any existing reconnect timer
        if (this.reconnectTimers.has(serverId)) {
            clearTimeout(this.reconnectTimers.get(serverId));
        }

        // Calculate exponential backoff delay based on recent failures
        const now = Date.now();
        const recentFailures = connectionInfo.connectionStats.totalDisconnects + connectionInfo.connectionStats.totalAuthFailures;
        let delay = Math.min(5000 * Math.pow(1.5, Math.min(recentFailures - 1, 5)), 60000); // Max 60 seconds
        
        // If last disconnect was very recent, add extra delay
        if (connectionInfo.lastDisconnectTime && (now - connectionInfo.lastDisconnectTime) < 5000) {
            delay = Math.max(delay, 10000); // Minimum 10 seconds for very recent failures
        }

        this.log(`Scheduling reconnect for ${serverId} in ${Math.round(delay/1000)} seconds (attempt ${recentFailures})`);
        
        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(serverId);
            
            try {
                const stillHasNodes = Array.from(this.nodeRegistrations.values())
                    .some(reg => reg.serverId === serverId);
                
                const stillHasConfig = this.configHashes.has(serverId);
                const currentConnectionInfo = this.connections.get(serverId);
                
                if (!stillHasNodes || !stillHasConfig || !currentConnectionInfo) {
                    return;
                }
                
                // Only reconnect if not already connected or connecting
                if (!currentConnectionInfo.connected && !currentConnectionInfo.connecting) {
                    this.log(`Attempting reconnect to ${serverId}`);
                    
                    // Mark as connecting to prevent multiple attempts
                    currentConnectionInfo.connecting = true;
                    
                    try {
                        await this.createConnection(serverId, currentConnectionInfo.config);
                    } catch (error) {
                        currentConnectionInfo.connecting = false;
                        this.error(`Reconnect failed for ${serverId}: ${error.message}`);
                        
                        // If it's not an auth error, schedule another reconnect with longer delay
                        if (this.shouldRetryConnection(serverId, error)) {
                            // Add a small delay before scheduling next attempt to avoid rapid retries
                            setTimeout(() => {
                                this.scheduleReconnect(serverId);
                            }, 1000);
                        }
                    }
                }
            } catch (err) {
                this.error(`Reconnect error for ${serverId}: ${err.message}`);
            }
        }, delay);
        
        this.reconnectTimers.set(serverId, timer);
    }

    isAuthenticationError(error) {
        const errorMsg = error.message || error.toString();
        const authErrors = [
            'Authentication failed',
            'Invalid grant',
            'invalid_grant',
            'Unauthorized',
            'invalid credentials',
            'user credentials are invalid',
            'authentication timeout'
        ];
        
        return authErrors.some(authError => 
            errorMsg.toLowerCase().includes(authError.toLowerCase())
        );
    }

    shouldRetryConnection(serverId, error) {
        if (this.isAuthenticationError(error)) {
            this.recordAuthFailure(serverId, error);
            return false;
        }
        
        const failures = this.authFailures.get(serverId);
        if (failures && failures.count >= 3) {
            return false;
        }

        // Check for total connection attempts to prevent infinite retries
        const connectionInfo = this.connections.get(serverId);
        if (connectionInfo) {
            const totalFailures = connectionInfo.connectionStats.totalDisconnects + connectionInfo.connectionStats.totalAuthFailures;
            if (totalFailures >= 10) {
                this.error(`Too many connection failures for ${serverId} (${totalFailures}), stopping retries`);
                return false;
            }
        }
        
        const retryableErrors = ['timeout', 'refused', 'network', 'disconnected', 'econnreset', 'enotfound', 'ehostunreach'];
        const errorMsg = error.message || error.toString();
        return retryableErrors.some(retryError => 
            errorMsg.toLowerCase().includes(retryError.toLowerCase())
        );
    }

    recordAuthFailure(serverId, error) {
        if (!this.authFailures.has(serverId)) {
            this.authFailures.set(serverId, { count: 0, lastError: null, firstFailure: Date.now() });
        }
        
        const failures = this.authFailures.get(serverId);
        failures.count++;
        failures.lastError = error.message || error.toString();
        failures.lastFailure = Date.now();
        
        this.error(`Authentication failure #${failures.count} for ${serverId}: ${failures.lastError}`);
    }

    clearAuthFailures(serverId) {
        if (this.authFailures.has(serverId)) {
            this.authFailures.delete(serverId);
        }
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

    // Public API methods
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
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
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
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
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
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
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
        await this.cancelPendingConnections(oldServerId, 'Force server switch');
        await this.closeConnection(oldServerId);
        this.connections.delete(oldServerId);
        this.configHashes.delete(oldServerId);
        this.authFailures.delete(oldServerId);
        this.lastKnownValues.delete(oldServerId);
        
        const newHash = this.generateConfigHash(newConfig);
        this.configHashes.set(newServerId, newHash);
    }

    getConnectionStatus(serverId) {
        const connectionInfo = this.connections.get(serverId);
        const failures = this.authFailures.get(serverId);
        const pending = this.pendingConnections.get(serverId);
        
        if (!connectionInfo) {
            return {
                connected: false,
                status: 'not_configured',
                serverId: serverId,
                authFailures: failures ? failures.count : 0,
                lastAuthError: failures ? failures.lastError : null,
                pendingConnections: pending ? pending.length : 0,
                deployNumber: this.deployCounter,
                isDeployActive: this.isDeployActive,
                tokenRefresh: {
                    enabled: false,
                    count: 0,
                    lastRefresh: null
                }
            };
        }

        // Get token refresh information from client if available
        let tokenRefreshInfo = {
            enabled: false,
            count: connectionInfo.connectionStats.totalTokenRefreshes || 0,
            lastRefresh: connectionInfo.lastTokenRefresh,
            timeUntilNextRefresh: null,
            tokenAge: null,
            sessionInfo: null
        };

        if (connectionInfo.client && connectionInfo.authenticationInfo.method === 'oauth2') {
            tokenRefreshInfo.enabled = true;
            if (typeof connectionInfo.client.getTokenAge === 'function') {
                tokenRefreshInfo.tokenAge = connectionInfo.client.getTokenAge();
            }
            if (typeof connectionInfo.client.getTimeUntilRefresh === 'function') {
                tokenRefreshInfo.timeUntilNextRefresh = connectionInfo.client.getTimeUntilRefresh();
            }
            if (typeof connectionInfo.client.getSessionInfo === 'function') {
                tokenRefreshInfo.sessionInfo = connectionInfo.client.getSessionInfo();
            }
        }

        return {
            connected: connectionInfo.connected || false,
            status: connectionInfo.connected ? 'connected' : (connectionInfo.connecting ? 'connecting' : 'disconnected'),
            serverId: serverId,
            connectionId: connectionInfo.connectionId,
            authFailures: failures ? failures.count : 0,
            lastAuthError: failures ? failures.lastError : connectionInfo.authenticationInfo.lastAuthError,
            pendingConnections: pending ? pending.length : 0,
            deployNumber: this.deployCounter,
            isDeployActive: this.isDeployActive,
            authentication: {
                method: connectionInfo.authenticationInfo.method,
                authenticated: connectionInfo.authenticationInfo.authenticated,
                username: connectionInfo.authenticationInfo.username,
                tokenRefreshCount: connectionInfo.authenticationInfo.tokenRefreshCount || 0,
                lastTokenRefresh: connectionInfo.authenticationInfo.lastTokenRefresh
            },
            connectionInfo: {
                created: connectionInfo.createdAt,
                lastConnect: connectionInfo.lastConnectTime,
                lastDisconnect: connectionInfo.lastDisconnectTime,
                stats: connectionInfo.connectionStats
            },
            tokenRefresh: tokenRefreshInfo
        };
    }

    async cleanup() {
        this.log('Cleanup started');
        
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = null;
        }
        
        // Clear all reconnect timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Clear all token refresh timers
        for (const timer of this.tokenRefreshTimers.values()) {
            clearTimeout(timer);
        }
        this.tokenRefreshTimers.clear();
        this.activeTokenRefreshes.clear();
        
        for (const [serverId] of this.pendingConnections) {
            await this.cancelPendingConnections(serverId, 'Manager cleanup');
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
        this.pendingConnections.clear();
        this.subscriptions.clear();
        this.callbacks.clear();
        this.eventNodes.clear();
        this.nodeRegistrations.clear();
        this.authFailures.clear();
        this.lastKnownValues.clear();
        
        this.log('Cleanup completed');
    }
}

// Singleton pattern - create and export instance
const manager = new WebSocketManager();

process.on('SIGTERM', () => manager.cleanup());
process.on('SIGINT', () => manager.cleanup());

module.exports = manager;