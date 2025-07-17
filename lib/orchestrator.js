const EventEmitter = require('events');
const LoggingService = require('./logging'); // KORRIGIERTER PFAD
const eventBus = require('./events/event-bus');

const AuthService = require('./services/auth-service');
const ConnectionService = require('./services/connection-service');
const StateService = require('./services/state-service');

class Orchestrator extends EventEmitter {
    constructor() {
        super();
        this.isInitialized = false;
        // LoggingService ist hier noch nicht initialisiert, Fallback auf Konsole
        this.logger = LoggingService.getLogger('Orchestrator');
        
        this.nodes = new Map();
        this.servers = new Map();

        this.authService = null;
        this.connectionService = null;
        this.stateService = null;
    }

    init(RED) {
        if (this.isInitialized) return;
        
        LoggingService.init(RED);
        this.logger = LoggingService.getLogger('Orchestrator');

        // Initialize EventBus logger
        eventBus.initLogger();

        this.authService = new AuthService();
        this.connectionService = new ConnectionService();
        this.stateService = new StateService();
        
        this.isInitialized = true;
        this.logger.info('Orchestrator and all services initialized successfully.');

        // Events von internen Services an die Nodes weiterleiten
        eventBus.on('auth:success', (data) => {
            this.logger.info(`Server ${data.serverId} is now fully connected and authenticated.`);
            // Mark server as ready
            const server = this.servers.get(data.serverId);
            if (server) {
                server.ready = true;
            }
            this.emit('server:ready', data); 
        });
        eventBus.on('state:changed', (data) => this.emit('state:changed', data));
        eventBus.on('state:subscription_confirmed', (data) => this.emit('state:subscription_confirmed', data));
        eventBus.on('state:initial_value', (data) => {
            // Emit to specific node using node-specific event
            this.logger.info(`Forwarding initial_value event for node ${data.nodeId}, state ${data.stateId}`);
            this.emit(`state:initial_value:${data.nodeId}`, data);
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
        if (!this.servers.has(serverId)) {
            this.servers.set(serverId, { config: serverConfig, nodes: new Set(), ready: false });
            this.logger.info(`First node registered for server ${serverId}. Initiating connection process.`);
            eventBus.emit('connection:request', serverConfig);
        } else {
            this.logger.debug(`Node ${nodeId} registered for existing server ${serverId}. Checking connection status.`);
            // Check if server is already ready and emit server:ready for this specific node
            const server = this.servers.get(serverId);
            if (server.ready) {
                this.logger.debug(`Server ${serverId} is already ready. Signaling ready for node ${nodeId}.`);
                this.emit('server:ready', { serverId });
            }
        }
        
        this.servers.get(serverId).nodes.add(nodeId);
        this.nodes.set(nodeId, serverConfig.id);
        this.logger.info(`Node ${nodeId} registered for server ${serverId}.`);
    }

    unregisterNode(nodeId, serverId) {
        if (!this.isInitialized || !this.servers.has(serverId)) return;
        
        const server = this.servers.get(serverId);
        server.nodes.delete(nodeId);
        this.nodes.delete(nodeId);
        this.logger.info(`Node ${nodeId} unregistered from server ${serverId}.`);
        
        if (server.nodes.size === 0) {
            this.logger.info(`Last node for server ${serverId} unregistered. Cleaning up.`);
            // Hier könnte man eine Disconnect-Logik hinzufügen, wenn gewünscht
            // eventBus.emit('connection:close_request', { serverId });
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
}

const instance = new Orchestrator();
module.exports = instance;