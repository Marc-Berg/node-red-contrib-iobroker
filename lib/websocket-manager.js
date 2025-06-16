// Deploy-Aware WebSocket Manager - Handles Node-RED deploys correctly
const { SocketClient } = require('./iobroker-ws-client-nodejs');
const crypto = require('crypto');

class DeployAwareSingletonManager {
    constructor() {
        // Connection storage
        this.serverConnections = new Map(); // serverId -> connection info
        this.lastConfigHashes = new Map(); // serverId -> hash
        
        // TRUE MUTEX: Only one connection attempt per server at any time
        this.activeMutexes = new Map(); // serverId -> { promise, resolve, reject }
        
        // Node management
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.eventNodes = new Map();
        this.objectCache = new Map();
        this.nodeRegistrations = new Map();
        
        // Connection delays
        this.connectionDelays = new Map();
        
        // Debug
        this.debugCounters = new Map(); // serverId -> attempts
        this.deployCounter = 0;
        
        // Deploy detection
        this.isDeployInProgress = false;
        this.deployTimeout = null;
    }

    log(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [info] [Deploy-Aware Manager] ${msg}`);
    }

    error(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.error(`${day} ${month} ${time} - [error] [Deploy-Aware Manager] ${msg}`);
    }

    /**
     * CRITICAL: Handle deploy events
     */
    handleDeployStart() {
        this.deployCounter++;
        this.isDeployInProgress = true;
        this.log(`DEPLOY #${this.deployCounter} STARTED - Preparing for node restart`);
        
        // Clear deploy timeout if exists
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
        }
        
        // Set timeout to detect deploy completion
        this.deployTimeout = setTimeout(() => {
            this.handleDeployComplete();
        }, 2000); // 2 seconds after last node registration
    }

    /**
     * Handle deploy completion
     */
    handleDeployComplete() {
        this.isDeployInProgress = false;
        this.deployTimeout = null;
        this.log(`DEPLOY #${this.deployCounter} COMPLETED - Resetting connection state`);
        
        // Reset debug counters for clean restart
        this.debugCounters.clear();
        
        // Don't close connections here - let the mutex handle it naturally
    }

    /**
     * Generate configuration hash
     */
    generateConfigHash(config) {
        return crypto.createHash('md5').update(JSON.stringify({
            iobhost: config.iobhost,
            iobport: config.iobport,
            user: config.user || '',
            password: config.password || ''
        })).digest('hex');
    }

    /**
     * Check if in delay period
     */
    isInDelayPeriod(serverId) {
        const delayUntil = this.connectionDelays.get(serverId);
        if (!delayUntil) return false;
        
        if (Date.now() < delayUntil) {
            return true;
        }
        
        this.connectionDelays.delete(serverId);
        return false;
    }

    /**
     * Set connection delay
     */
    setConnectionDelay(serverId, delayMs = 5000) {
        const delayUntil = Date.now() + delayMs;
        this.connectionDelays.set(serverId, delayUntil);
        this.log(`DELAY set for ${serverId} until ${new Date(delayUntil).toLocaleTimeString()}`);
    }

    /**
     * ENHANCED MUTEX: Deploy-aware connection management
     */
    async getSingleConnectionWithMutex(serverId, config) {
        // Detect deploy start on first connection request
        if (this.debugCounters.get(serverId) === undefined) {
            this.handleDeployStart();
        }
        
        // Increment counter
        const counter = (this.debugCounters.get(serverId) || 0) + 1;
        this.debugCounters.set(serverId, counter);
        
        const deployInfo = this.isDeployInProgress ? ` (Deploy #${this.deployCounter})` : '';
        this.log(`CONNECTION REQUEST #${counter} for ${serverId}${deployInfo}`);
        
        // Reset deploy timeout on each new request
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = setTimeout(() => {
                this.handleDeployComplete();
            }, 2000);
        }
        
        // Check if there's already an active mutex
        let mutexInfo = this.activeMutexes.get(serverId);
        
        if (mutexInfo) {
            this.log(`MUTEX WAIT: Request #${counter} waiting for ${serverId}...`);
            try {
                // Wait for the existing connection attempt
                const result = await mutexInfo.promise;
                this.log(`MUTEX WAIT COMPLETE: Request #${counter} got result for ${serverId}`);
                return result;
            } catch (error) {
                this.log(`MUTEX WAIT ERROR: Previous attempt failed for ${serverId}: ${error.message}`);
                // Fall through to try again
            }
        }
        
        // We are the first or retry after failure - create mutex
        let resolveMutex, rejectMutex;
        const mutexPromise = new Promise((resolve, reject) => {
            resolveMutex = resolve;
            rejectMutex = reject;
        });
        
        mutexInfo = {
            promise: mutexPromise,
            resolve: resolveMutex,
            reject: rejectMutex,
            requestNumber: counter,
            deployNumber: this.deployCounter
        };
        
        this.activeMutexes.set(serverId, mutexInfo);
        this.log(`MUTEX CREATED: Request #${counter} owns mutex for ${serverId}${deployInfo}`);
        
        try {
            // We own the mutex - create the connection
            const client = await this.createSingleConnection(serverId, config);
            
            // Success - resolve mutex with client
            resolveMutex(client);
            this.log(`MUTEX SUCCESS: Request #${counter} completed for ${serverId}${deployInfo}`);
            return client;
            
        } catch (error) {
            // Error - reject mutex
            this.error(`MUTEX ERROR: Request #${counter} failed for ${serverId}: ${error.message}`);
            rejectMutex(error);
            throw error;
            
        } finally {
            // Always clean up mutex
            this.activeMutexes.delete(serverId);
            this.log(`MUTEX CLEANED: Request #${counter} released mutex for ${serverId}${deployInfo}`);
        }
    }

    /**
     * Create the actual connection with deploy awareness
     */
    async createSingleConnection(serverId, config) {
        // Check configuration changes
        const newHash = this.generateConfigHash(config);
        const oldHash = this.lastConfigHashes.get(serverId);
        const configChanged = oldHash && oldHash !== newHash;
        
        if (configChanged) {
            this.log(`CONFIG CHANGE detected for ${serverId}`);
            await this.forceCloseConnection(serverId);
            this.setConnectionDelay(serverId, 3000);
        }
        
        this.lastConfigHashes.set(serverId, newHash);
        
        // Wait for delay period
        if (this.isInDelayPeriod(serverId)) {
            this.log(`WAITING for delay period to end for ${serverId}...`);
            while (this.isInDelayPeriod(serverId)) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        // Check if connection already exists and is valid
        const existingConnection = this.serverConnections.get(serverId);
        if (existingConnection && existingConnection.connected && existingConnection.client) {
            this.log(`REUSING existing connection for ${serverId}`);
            return existingConnection.client;
        }
        
        // During deploy, force close any stale connections
        if (this.isDeployInProgress && existingConnection) {
            this.log(`DEPLOY in progress - forcing close of stale connection for ${serverId}`);
            await this.forceCloseConnection(serverId);
        }
        
        // Create new connection
        const useAuth = !!(config.user && config.user.trim());
        const authMode = useAuth ? `OAuth2 (${config.user})` : 'no-auth';
        
        const deployInfo = this.isDeployInProgress ? ` (Deploy #${this.deployCounter})` : '';
        this.log(`CREATING NEW connection to ${serverId} with ${authMode}${deployInfo}`);
        
        // Initialize connection info
        const connectionInfo = {
            client: null,
            config: { ...config },
            connected: false,
            connecting: true,
            nodeCount: 0,
            createdAt: Date.now(),
            deployNumber: this.deployCounter
        };
        this.serverConnections.set(serverId, connectionInfo);
        
        try {
            // Create client with enhanced error handling
            const client = new SocketClient();
            connectionInfo.client = client;
            
            // Setup event handlers
            client.on('connect', () => {
                this.log(`SUCCESS: Connected to ${serverId} with ${authMode}${deployInfo}`);
                connectionInfo.connected = true;
                connectionInfo.connecting = false;
                this.updateAllNodesStatus(serverId, 'connected');
                this.resubscribeForServer(serverId);
            });

            client.on('disconnect', () => {
                this.log(`DISCONNECTED from ${serverId}`);
                connectionInfo.connected = false;
                this.updateAllNodesStatus(serverId, 'disconnected');
                this.scheduleReconnect(serverId);
            });

            client.on('reconnect', () => {
                this.log(`RECONNECTED to ${serverId}`);
                connectionInfo.connected = true;
                this.updateAllNodesStatus(serverId, 'connected');
                this.resubscribeForServer(serverId);
            });

            client.on('stateChange', (id, state) => {
                this.handleStateChange(id, state);
            });

            client.on('error', (err) => {
                this.error(`CONNECTION ERROR from ${serverId}: ${err}`);
                connectionInfo.connected = false;
                this.updateAllNodesStatus(serverId, 'disconnected');
                
                // Set delay for auth errors
                if (err.includes('Invalid password') || err.includes('authentication') || err.includes('Invalid grant')) {
                    this.setConnectionDelay(serverId, 10000); // Longer delay for auth errors
                }
                
                this.scheduleReconnect(serverId);
            });

            // Connection options with deploy-aware naming
            const connectOptions = {
                name: `NodeRED-Deploy-${this.deployCounter}`,
                connectMaxAttempt: 1,
                connectTimeout: 10000,
                host: config.iobhost,
                port: config.iobport
            };

            if (useAuth) {
                if (!config.password) {
                    throw new Error('Password required when username is provided');
                }
                connectOptions.username = config.user;
                connectOptions.password = config.password;
            }

            // Update status
            this.updateAllNodesStatus(serverId, 'connecting');

            // Establish connection with timeout and error handling
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, connectOptions.connectTimeout);
                
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
                        reject(new Error(err));
                    }
                };

                client.on('connect', handleConnect);
                client.on('error', handleError);

                // Connect with error handling
                try {
                    client.connect(`ws://${config.iobhost}:${config.iobport}`, connectOptions);
                } catch (syncError) {
                    handleError(syncError.message);
                }
            });

            connectionInfo.connecting = false;
            this.log(`CONNECTION ESTABLISHED successfully to ${serverId}${deployInfo}`);
            return client;

        } catch (error) {
            this.error(`CONNECTION CREATION FAILED for ${serverId}: ${error.message}`);
            connectionInfo.connecting = false;
            connectionInfo.connected = false;
            
            // Set delay for failed connections
            this.setConnectionDelay(serverId, 5000);
            this.updateAllNodesStatus(serverId, 'disconnected');
            
            throw error;
        }
    }

    /**
     * Force close connection with deploy awareness
     */
    async forceCloseConnection(serverId) {
        this.log(`FORCE CLOSE connection to ${serverId}`);
        
        const connectionInfo = this.serverConnections.get(serverId);
        if (connectionInfo && connectionInfo.client) {
            try {
                connectionInfo.client.destroy();
            } catch (err) {
                this.error(`Error destroying connection: ${err.message}`);
            }
            connectionInfo.client = null;
            connectionInfo.connected = false;
            connectionInfo.connecting = false;
        }
        
        this.updateAllNodesStatus(serverId, 'disconnected');
    }

    /**
     * Schedule reconnect (only if needed and not during deploy)
     */
    scheduleReconnect(serverId) {
        // Don't reconnect during active deploy
        if (this.isDeployInProgress) {
            this.log(`RECONNECT blocked for ${serverId} - deploy in progress`);
            return;
        }
        
        // Don't reconnect if in delay period
        if (this.isInDelayPeriod(serverId)) {
            this.log(`RECONNECT blocked for ${serverId} - in delay period`);
            return;
        }
        
        // Don't reconnect if no nodes are registered
        const nodeCount = Array.from(this.nodeRegistrations.values())
            .filter(reg => reg.serverId === serverId).length;
        
        if (nodeCount === 0) {
            this.log(`RECONNECT skipped for ${serverId} - no nodes registered`);
            return;
        }
        
        // Don't reconnect if already connecting
        const connectionInfo = this.serverConnections.get(serverId);
        if (connectionInfo && connectionInfo.connecting) {
            this.log(`RECONNECT skipped for ${serverId} - already connecting`);
            return;
        }
        
        this.log(`SCHEDULING reconnect for ${serverId} in 3 seconds`);
        this.updateAllNodesStatus(serverId, 'reconnecting');
        
        setTimeout(async () => {
            if (!this.isInDelayPeriod(serverId) && !this.isDeployInProgress) {
                const connectionInfo = this.serverConnections.get(serverId);
                if (connectionInfo && !connectionInfo.connected && !connectionInfo.connecting) {
                    try {
                        this.log(`ATTEMPTING reconnect to ${serverId}`);
                        await this.getSingleConnectionWithMutex(serverId, connectionInfo.config);
                    } catch (err) {
                        this.error(`RECONNECT failed for ${serverId}: ${err.message}`);
                    }
                }
            }
        }, 3000);
    }

    /**
     * Update status for all nodes on a server
     */
    updateAllNodesStatus(serverId, status) {
        let nodeCount = 0;
        
        // Update state subscription nodes
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

        // Update event nodes
        this.eventNodes.forEach((callback, nodeId) => {
            const registration = this.nodeRegistrations.get(nodeId);
            if (registration && registration.serverId === serverId) {
                nodeCount++;
                if (callback.updateStatus) {
                    try {
                        callback.updateStatus(status);
                    } catch (err) {
                        this.error(`Event status update error for node ${nodeId}: ${err.message}`);
                    }
                }
            }
        });
        
        // Update connection info
        const connectionInfo = this.serverConnections.get(serverId);
        if (connectionInfo) {
            connectionInfo.nodeCount = nodeCount;
        }
        
        if (nodeCount > 0) {
            this.log(`STATUS '${status}' sent to ${nodeCount} nodes on ${serverId}`);
        }
    }

    /**
     * Register node with deploy awareness
     */
    registerNode(nodeId, serverId, type, config) {
        // Extend deploy timeout when new nodes register
        if (this.deployTimeout) {
            clearTimeout(this.deployTimeout);
            this.deployTimeout = setTimeout(() => {
                this.handleDeployComplete();
            }, 2000);
        }
        
        this.nodeRegistrations.set(nodeId, {
            serverId: serverId,
            type: type,
            config: { ...config },
            registeredAt: Date.now(),
            deployNumber: this.deployCounter
        });
        this.log(`Node ${nodeId} registered for ${serverId} (type: ${type}, deploy: ${this.deployCounter})`);
    }

    /**
     * Unregister node with deploy awareness
     */
    unregisterNode(nodeId) {
        const registration = this.nodeRegistrations.get(nodeId);
        if (registration) {
            this.nodeRegistrations.delete(nodeId);
            this.log(`Node ${nodeId} unregistered from ${registration.serverId}`);
            
            // Check if this was the last node for the server
            const remainingNodes = Array.from(this.nodeRegistrations.values())
                .filter(reg => reg.serverId === registration.serverId);
            
            if (remainingNodes.length === 0) {
                this.log(`LAST NODE removed for ${registration.serverId} - closing connection`);
                this.forceCloseConnection(registration.serverId);
                this.serverConnections.delete(registration.serverId);
                this.lastConfigHashes.delete(registration.serverId);
                this.debugCounters.delete(registration.serverId);
            }
        }
    }

    // ========== PUBLIC API (unchanged) ==========

    /**
     * Subscribe to state with crash-safe handling
     */
    async subscribe(nodeId, serverId, stateId, callback, config) {
        try {
            this.registerNode(nodeId, serverId, 'subscribe', config);
            
            const client = await this.getSingleConnectionWithMutex(serverId, config);
            
            this.callbacks.set(nodeId, callback);
            
            if (!this.subscriptions.has(stateId)) {
                this.subscriptions.set(stateId, new Set());
                if (!stateId.startsWith('_dummy_')) {
                    await this.subscribeState(client, stateId);
                }
            }
            
            this.subscriptions.get(stateId).add(nodeId);
            this.log(`Node ${nodeId} subscribed to ${stateId} on ${serverId}`);
            
        } catch (error) {
            this.error(`Subscribe failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Register for events with crash-safe handling
     */
    async registerForEvents(nodeId, serverId, callback, config) {
        try {
            this.registerNode(nodeId, serverId, 'events', config);
            
            await this.getSingleConnectionWithMutex(serverId, config);
            this.eventNodes.set(nodeId, callback);
            this.log(`Node ${nodeId} registered for events on ${serverId}`);
            
        } catch (error) {
            this.error(`Event registration failed for node ${nodeId}: ${error.message}`);
            throw error;
        }
    }

    // [Other public API methods remain the same: getState, setState, getStates, getObject]
    
    async getState(serverId, stateId) {
        const connectionInfo = this.serverConnections.get(serverId);
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
        const connectionInfo = this.serverConnections.get(serverId);
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
        const connectionInfo = this.serverConnections.get(serverId);
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
        const connectionInfo = this.serverConnections.get(serverId);
        if (!connectionInfo || !connectionInfo.client || !connectionInfo.connected) {
            throw new Error(`No active connection for ${serverId}`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Get object timeout')), 10000);
            connectionInfo.client.emit('getObject', objectId, (err, obj) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else {
                    if (obj) this.objectCache.set(objectId, obj);
                    resolve(obj);
                }
            });
        });
    }

    // [Helper methods remain mostly the same]
    
    subscribeState(client, stateId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 8000);
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

    async resubscribeForServer(serverId) {
        const connectionInfo = this.serverConnections.get(serverId);
        if (!connectionInfo || !connectionInfo.connected) return;
        
        const states = Array.from(this.subscriptions.keys()).filter(id => !id.startsWith('_dummy_'));
        if (states.length === 0) return;
        
        this.log(`RESUBSCRIBING to ${states.length} states on ${serverId}`);
        for (const stateId of states) {
            try {
                await this.subscribeState(connectionInfo.client, stateId);
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                this.error(`Resubscribe failed for ${stateId}: ${err.message}`);
            }
        }
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

    async unsubscribe(nodeId, serverId, stateId) {
        try {
            const nodeIds = this.subscriptions.get(stateId);
            if (!nodeIds) return;

            nodeIds.delete(nodeId);
            if (nodeIds.size === 0) {
                this.subscriptions.delete(stateId);
                const connectionInfo = this.serverConnections.get(serverId);
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

    getConnectionStatus(serverId) {
        const connectionInfo = this.serverConnections.get(serverId);
        const attempts = this.debugCounters.get(serverId) || 0;
        
        return {
            connected: connectionInfo?.connected || false,
            status: connectionInfo?.connected ? 'connected' : 'disconnected',
            serverId: serverId,
            authenticated: connectionInfo?.client?.authenticated || false,
            subscriptions: this.subscriptions.size,
            eventNodes: this.eventNodes.size,
            nodeCount: connectionInfo?.nodeCount || 0,
            connectionAttempts: attempts,
            deployNumber: this.deployCounter,
            isDeployInProgress: this.isDeployInProgress,
            isDelayed: this.isInDelayPeriod(serverId),
            hasMutex: this.activeMutexes.has(serverId)
        };
    }

    async cleanup() {
        this.log('CLEANUP: Starting deploy-aware cleanup');
        
        try {
            // Clear deploy timeout
            if (this.deployTimeout) {
                clearTimeout(this.deployTimeout);
                this.deployTimeout = null;
            }
            
            // Clear all mutexes
            this.activeMutexes.clear();
            
            // Close all connections
            for (const [serverId, connectionInfo] of this.serverConnections) {
                if (connectionInfo.client) {
                    try {
                        connectionInfo.client.destroy();
                    } catch (err) {
                        this.error(`Error destroying ${serverId}: ${err.message}`);
                    }
                }
            }
            
            // Clear all data
            this.serverConnections.clear();
            this.lastConfigHashes.clear();
            this.connectionDelays.clear();
            this.debugCounters.clear();
            this.nodeRegistrations.clear();
            this.subscriptions.clear();
            this.callbacks.clear();
            this.eventNodes.clear();
            this.objectCache.clear();
            
            this.log('CLEANUP: Completed successfully');
        } catch (error) {
            this.error(`CLEANUP error: ${error.message}`);
        }
    }
}

// Singleton instance with deploy awareness
const deployAwareManager = new DeployAwareSingletonManager();

// Cleanup on exit
process.on('SIGTERM', () => deployAwareManager.cleanup());
process.on('SIGINT', () => deployAwareManager.cleanup());
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    deployAwareManager.cleanup();
});

module.exports = deployAwareManager;