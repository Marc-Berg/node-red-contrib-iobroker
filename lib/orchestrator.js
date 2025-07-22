/*!
 * Central Orchestrator for ioBroker Node-RED Integration
 * Coordinates all services and manages node/server lifecycle
 */

const EventEmitter = require('events');
const LoggingService = require('./logging');
const eventBus = require('./events/event-bus');

const AuthService = require('./services/auth-service');
const ConnectionService = require('./services/connection-service');
const StateService = require('./services/state-service');
const HistoryService = require('./services/history-service');
const SendToService = require('./services/sendto-service');

class Orchestrator extends EventEmitter {
    constructor() {
        super();
        this.isInitialized = false;
        this.logger = LoggingService.getLogger('Orchestrator');

        this.nodes = new Map();
        this.servers = new Map();

        this.authService = null;
        this.connectionService = null;
        this.stateService = null;
        this.historyService = null;
        this.sendToService = null;
    }

    init(RED) {
        if (this.isInitialized) return;

        LoggingService.init(RED);
        this.logger = LoggingService.getLogger('Orchestrator');

        eventBus.initLogger();

        this.authService = new AuthService();
        this.connectionService = new ConnectionService();
        this.stateService = new StateService();
        this.historyService = new HistoryService();
        this.sendToService = new SendToService();

        this.isInitialized = true;
        this.logger.info('Orchestrator initialized');

        eventBus.on('auth:success', (data) => {
            this.logger.info(`Server ${data.serverId} is now fully connected and authenticated${data.isReconnect ? ' (reconnect)' : ''}.`);
            const server = this.servers.get(data.serverId);
            if (server) {
                server.ready = true;
            }
            this.emit('server:ready', data);
        });
        eventBus.on('state:changed', (data) => this.emit('state:changed', data));
        eventBus.on('state:subscription_confirmed', (data) => this.emit('state:subscription_confirmed', data));
        eventBus.on('state:initial_value', (data) => {
            this.logger.info(`Forwarding initial_value event for node ${data.nodeId}, state ${data.stateId}`);
            this.emit(`state:initial_value:${data.nodeId}`, data);
        });
        eventBus.on('state:set_result', (data) => {
            this.logger.info(`Forwarding set_result event for node ${data.nodeId}, state ${data.stateId}`);
            this.emit(`state:set_result:${data.nodeId}`, data);
        });
        eventBus.on('object:get_result', (data) => {
            this.logger.info(`Forwarding object get_result event for node ${data.nodeId}, object ${data.objectId}`);
            this.emit(`object:get_result:${data.nodeId}`, data);
        });
        eventBus.on('object:set_result', (data) => {
            this.logger.info(`Forwarding object set_result event for node ${data.nodeId}, object ${data.objectId}`);
            this.emit(`object:set_result:${data.nodeId}`, data);
        });
        eventBus.on('enums:get_result', (data) => {
            this.logger.info(`Forwarding enums get_result event for node ${data.nodeId}`);
            this.emit(`enums:get_result:${data.nodeId}`, data);
        });
        eventBus.on('aliases:get_result', (data) => {
            this.logger.info(`Forwarding aliases get_result event for node ${data.nodeId}`);
            this.emit(`aliases:get_result:${data.nodeId}`, data);
        });
        eventBus.on('multiple_data:get_result', (data) => {
            this.logger.info(`Forwarding multiple_data get_result event for node ${data.nodeId}, coordinator ${data.coordinatorKey}`);
            this.emit(`multiple_data:get_result:${data.nodeId}`, data);
        });
        eventBus.on('log:message', (data) => {
            this.logger.debug(`Forwarding log message event for node ${data.nodeId}`);
            this.emit(`log:message:${data.nodeId}`, data);
            this.emit('log:message', data);
        });
        eventBus.on('log:subscription_confirmed', (data) => {
            this.logger.info(`Forwarding log subscription confirmed event for node ${data.nodeId}`);
            this.emit(`log:subscription_confirmed:${data.nodeId}`, data);
            this.emit('log:subscription_confirmed', data);
        });
        eventBus.on('object:subscription_confirmed', (data) => {
            this.logger.info(`Forwarding object subscription confirmed event for node ${data.nodeId}`);
            this.emit(`object:subscription_confirmed:${data.nodeId}`, data);
            this.emit('object:subscription_confirmed', data);
        });
        eventBus.on('object:changed', (data) => {
            this.logger.debug(`Forwarding object changed event for node ${data.nodeId}`);
            this.emit(`object:changed:${data.nodeId}`, data);
            this.emit('object:changed', data);
        });
        eventBus.on('connection:disconnected', (data) => this.emit('connection:disconnected', data));
        eventBus.on('connection:retrying', (data) => this.emit('connection:retrying', data));
        eventBus.on('connection:failed_permanently', (data) => this.emit('connection:failed_permanently', data));
    }

    registerNode(nodeId, serverConfig) {
        if (!this.isInitialized) {
            this.logger.error('Cannot register node: Orchestrator not initialized.');
            return;
        }

        const serverId = serverConfig.id;

        // First, add the node to the maps BEFORE any events are emitted
        if (!this.servers.has(serverId)) {
            this.servers.set(serverId, { config: serverConfig, nodes: new Set(), ready: false });
        }

        this.servers.get(serverId).nodes.add(nodeId);
        this.nodes.set(nodeId, serverConfig.id);
        this.logger.info(`Node ${nodeId} registered for server ${serverId}.`);

        // Now handle server connection logic
        const server = this.servers.get(serverId);
        if (server.nodes.size === 1) {
            // This is the first node for this server
            this.logger.info(`First node registered for server ${serverId}. Initiating connection process.`);
            eventBus.emit('connection:request', serverConfig);
        } else {
            // This server already exists
            this.logger.debug(`Node ${nodeId} registered for existing server ${serverId}. Checking connection status.`);
            if (server.ready) {
                this.logger.debug(`Server ${serverId} is already ready. Signaling ready for node ${nodeId}.`);
                // Use setImmediate to ensure the node registration is fully complete before emitting the event
                setImmediate(() => {
                    this.emit('server:ready', { serverId, isReconnect: false });
                });
            }
        }
    }

    getServerStatus(serverId) {
        return this.servers.get(serverId) || null;
    }

    unregisterNode(nodeId, serverId) {
        if (!this.isInitialized || !this.servers.has(serverId)) return;

        const server = this.servers.get(serverId);
        server.nodes.delete(nodeId);
        this.nodes.delete(nodeId);

        this.logger.info(`Node ${nodeId} unregistered from server ${serverId}.`);

        if (server.nodes.size === 0) {
            this.logger.info(`Last node for server ${serverId} unregistered. Cleaning up.`);
            this.servers.delete(serverId);
        }
    }

    subscribe(nodeId, stateId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is subscribing to "${stateId}".`);
            eventBus.emit('state:subscribe_request', { serverId, stateId });
        } else {
            this.logger.warn(`Could not subscribe. Node ${nodeId} is not registered.`);
        }
    }

    unsubscribe(nodeId, stateId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is unsubscribing from "${stateId}".`);
            eventBus.emit('state:unsubscribe_request', { serverId, stateId, nodeId });
        } else {
            this.logger.warn(`Could not unsubscribe. Node ${nodeId} is not registered.`);
        }
    }

    getState(nodeId, stateId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is requesting initial value for "${stateId}".`);
            eventBus.emit('state:get_request', { serverId, stateId, nodeId });
        } else {
            this.logger.warn(`Could not get state. Node ${nodeId} is not registered.`);
        }
    }

    async getHistory(nodeId, historyAdapter, stateId, options) {
        if (!this.isInitialized) return null;

        const serverId = this.nodes.get(nodeId);
        if (!serverId) {
            this.logger.warn(`Could not get history. Node ${nodeId} is not registered.`);
            throw new Error(`Node ${nodeId} is not registered`);
        }

        this.logger.info(`Node ${nodeId} is requesting history for "${stateId}" from adapter "${historyAdapter}".`);

        return new Promise((resolve, reject) => {
            const requestId = `${nodeId}_${Date.now()}_${Math.random()}`;

            const timeout = setTimeout(() => {
                eventBus.removeListener(`history:get_result:${requestId}`, onResult);
                reject(new Error('History request timeout'));
            }, 30000);

            const onResult = (data) => {
                clearTimeout(timeout);
                if (data.error) {
                    reject(new Error(data.error));
                } else {
                    resolve(data.result);
                }
            };

            eventBus.once(`history:get_result:${requestId}`, onResult);
            eventBus.emit('history:get_request', {
                serverId,
                historyAdapter,
                stateId,
                options,
                nodeId,
                requestId
            });
        });
    }

    setState(nodeId, stateId, value, ack = true) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is setting state "${stateId}" to value: ${value} (ack: ${ack}).`);
            eventBus.emit('state:set_request', { serverId, stateId, value, ack, nodeId });
        } else {
            this.logger.warn(`Could not set state. Node ${nodeId} is not registered.`);
        }
    }

    getObject(nodeId, objectId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is requesting object "${objectId}".`);
            eventBus.emit('object:get_request', { serverId, objectId, nodeId });
        } else {
            this.logger.warn(`Could not get object. Node ${nodeId} is not registered.`);
        }
    }

    async getStates(serverId) {
        if (!this.isInitialized) return null;

        // Check if server is registered and ready
        const server = this.servers.get(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} is not registered`);
        }

        if (!server.ready) {
            throw new Error(`Server ${serverId} is not ready yet. Please wait for connection to be established.`);
        }

        this.logger.info(`Requesting states for server: ${serverId}`);

        return new Promise((resolve, reject) => {
            const requestId = `states_${Date.now()}_${Math.random()}`;

            const timeout = setTimeout(() => {
                eventBus.removeListener(`states:get_result:${requestId}`, onResult);
                reject(new Error('States request timeout'));
            }, 30000);

            const onResult = (data) => {
                clearTimeout(timeout);
                if (data.error) {
                    reject(new Error(data.error));
                } else {
                    resolve(data.result);
                }
            };

            eventBus.once(`states:get_result:${requestId}`, onResult);
            eventBus.emit('states:get_request', { serverId, requestId });
        });
    }

    getEnums(nodeId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is requesting enums.`);
            eventBus.emit('enums:get_request', { serverId, nodeId });
        } else {
            this.logger.warn(`Could not get enums. Node ${nodeId} is not registered.`);
        }
    }

    getAliases(nodeId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is requesting aliases.`);
            eventBus.emit('aliases:get_request', { serverId, nodeId });
        } else {
            this.logger.warn(`Could not get aliases. Node ${nodeId} is not registered.`);
        }
    }

    getConnectionStatus(serverId) {
        if (!this.isInitialized) return { connected: false, ready: false, error: 'Orchestrator not initialized' };

        const server = this.servers.get(serverId);
        if (!server) {
            return {
                connected: false,
                ready: false,
                error: 'Server not found',
                availableServers: Array.from(this.servers.keys())
            };
        }

        return {
            connected: server.connected || false,
            ready: server.ready || false,
            host: server.config?.iobhost,
            port: server.config?.iobport,
            secure: server.config?.usessl,
            nodeCount: server.nodes?.size || 0
        };
    }

    // Helper method to find server ID by host:port
    findServerByHostPort(hostPort) {
        for (const [serverId, server] of this.servers) {
            const serverHostPort = `${server.config?.iobhost}:${server.config?.iobport}`;
            if (serverHostPort === hostPort) {
                return serverId;
            }
        }
        return null;
    }

    setObject(nodeId, objectId, objectDef) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is setting object "${objectId}".`);
            eventBus.emit('object:set_request', { serverId, objectId, objectDef, nodeId });
        } else {
            this.logger.warn(`Could not set object. Node ${nodeId} is not registered.`);
        }
    }

    subscribeToLogs(nodeId, logLevel = 'info') {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is subscribing to logs (level: ${logLevel}).`);
            eventBus.emit('log:subscribe_request', { serverId, logLevel, nodeId });
        } else {
            this.logger.warn(`Could not subscribe to logs. Node ${nodeId} is not registered.`);
        }
    }

    unsubscribeFromLogs(nodeId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is unsubscribing from logs.`);
            eventBus.emit('log:unsubscribe_request', { serverId, nodeId });
        } else {
            this.logger.warn(`Could not unsubscribe from logs. Node ${nodeId} is not registered.`);
        }
    }

    subscribeToObjects(nodeId, objectId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is subscribing to objects (objectId: ${objectId}).`);
            eventBus.emit('object:subscribe_request', { serverId, objectId, nodeId });
        } else {
            this.logger.warn(`Could not subscribe to objects. Node ${nodeId} is not registered.`);
        }
    }

    getMultipleData(nodeId, requests, timeout = 10000) {
        if (!this.isInitialized) {
            return Promise.reject(new Error('Orchestrator not initialized'));
        }

        const serverId = this.nodes.get(nodeId);
        if (!serverId) {
            return Promise.reject(new Error(`Node ${nodeId} is not registered`));
        }

        const coordinatorKey = `${nodeId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.logger.info(`Node ${nodeId} is requesting multiple data with coordinator ${coordinatorKey}`);

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.logger.warn(`Multiple data request timeout for node ${nodeId}, coordinator ${coordinatorKey}`);
                reject(new Error(`Multiple data request timeout after ${timeout}ms`));
            }, timeout);

            const eventHandler = (data) => {
                if (data.coordinatorKey === coordinatorKey) {
                    clearTimeout(timeoutId);
                    this.removeListener(`multiple_data:get_result:${nodeId}`, eventHandler);

                    if (data.success) {
                        this.logger.info(`Multiple data request completed successfully for node ${nodeId}, coordinator ${coordinatorKey}`);
                        resolve(data);
                    } else {
                        this.logger.error(`Multiple data request failed for node ${nodeId}, coordinator ${coordinatorKey}: ${data.error}`);
                        reject(new Error(data.error || 'Multiple data request failed'));
                    }
                }
            };

            this.on(`multiple_data:get_result:${nodeId}`, eventHandler);
            eventBus.emit('multiple_data:get_request', { serverId, nodeId, coordinatorKey, requests });
        });
    }

    unsubscribeFromObjects(nodeId, objectId) {
        if (!this.isInitialized) return;

        const serverId = this.nodes.get(nodeId);
        if (serverId) {
            this.logger.info(`Node ${nodeId} is unsubscribing from objects (objectId: ${objectId}).`);
            eventBus.emit('object:unsubscribe_request', { serverId, objectId, nodeId });
        } else {
            this.logger.warn(`Could not unsubscribe from objects. Node ${nodeId} is not registered.`);
        }
    }

    async sendToAdapter(nodeId, adapter, command, message, timeout = null) {
        if (!this.isInitialized) {
            throw new Error('Orchestrator not initialized');
        }

        const serverId = this.nodes.get(nodeId);
        if (!serverId) {
            this.logger.warn(`Could not send to adapter. Node ${nodeId} is not registered.`);
            throw new Error(`Node ${nodeId} is not registered`);
        }

        const requestId = `${nodeId}_${Date.now()}_${Math.random()}`;
        this.logger.info(`Node ${nodeId} is sending to adapter "${adapter}" (command: ${command}, requestId: ${requestId})`);

        if (timeout === null) {
            // Fire-and-forget mode
            eventBus.emit('sendto:send_request', {
                serverId,
                nodeId,
                requestId,
                adapter,
                command,
                message,
                waitForResponse: false
            });
            return;
        }

        // Wait for response mode
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                eventBus.removeListener(`sendto:response:${requestId}`, onResponse);
                reject(new Error(`SendTo request timeout after ${timeout}ms`));
            }, timeout);

            const onResponse = (data) => {
                clearTimeout(timeoutId);

                if (data.error) {
                    this.logger.error(`SendTo failed for node ${nodeId}, adapter ${adapter}: ${data.error}`);
                    reject(new Error(data.error));
                } else {
                    this.logger.debug(`SendTo completed successfully for node ${nodeId}, adapter ${adapter}`);
                    resolve(data.response);
                }
            };

            eventBus.once(`sendto:response:${requestId}`, onResponse);
            eventBus.emit('sendto:send_request', {
                serverId,
                nodeId,
                requestId,
                adapter,
                command,
                message,
                waitForResponse: true
            });
        });
    }

    cleanup() {
        this.logger.info('Orchestrator cleanup started');

        // Cleanup all services
        if (this.authService) {
            this.authService.cleanup();
        }

        if (this.connectionService) {
            this.connectionService.cleanup();
        }

        if (this.sendToService) {
            this.sendToService.cleanup();
        }

        if (this.stateService) {
            this.stateService.cleanup();
        }

        // Clear node and server registrations
        this.nodes.clear();
        this.servers.clear();

        this.logger.info('Orchestrator cleanup completed');
    }
}

const instance = new Orchestrator();
module.exports = instance;