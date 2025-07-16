const WebSocket = require('ws');
const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

const INITIAL_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 60000;
const MAX_AUTH_FAILURES = 5;

class ConnectionService {
    constructor() {
        this.logger = LoggingService.getLogger('ConnectionService');
        this.connections = new Map();

        eventBus.on('auth:token_received', ({ config, token }) => this.connect(config, token));
        eventBus.on('auth:not_required', ({ config }) => this.connect(config, null));
        eventBus.on('auth:failure', ({ serverId, error }) => this.handleAuthFailure(serverId, error));
        eventBus.on('connection:network_error', ({ serverId, error }) => this.handleNetworkError(serverId, error));
        eventBus.on('connection:request', (config) => this.initializeConnectionState(config));
        eventBus.on('websocket:send', ({ serverId, payload }) => this.send(serverId, payload));

        this.logger.info('ConnectionService constructed and listeners attached.');
    }

    initializeConnectionState(config) {
        const serverId = config.id;
        if (!this.connections.has(serverId)) {
            const state = { config, retryCount: 0, authFailureCount: 0, timerId: null, isPermanentFailure: false };
            this.connections.set(serverId, state);
            this.logger.debug(`[${serverId}] Connection state initialized`);
        }
    }

    connect(config, token = null) {
        const serverId = config.id;
        let state = this.connections.get(serverId);

        // Initialize state if it doesn't exist (shouldn't happen with proper flow)
        if (!state) {
            this.logger.warn(`[${serverId}] Connection state not found during connect, creating new one`);
            this.initializeConnectionState(config);
            state = this.connections.get(serverId);
        }

        if (state.isPermanentFailure) {
            this.logger.error(`[${serverId}] Not attempting to connect, server is marked as permanently failed.`);
            return;
        }

        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }

        // Close existing socket if it exists
        if (state.socket) {
            this.logger.debug(`[${serverId}] Closing existing WebSocket connection before creating new one.`);
            try {
                state.socket.removeAllListeners();
                state.socket.close();
            } catch (error) {
                this.logger.warn(`[${serverId}] Error closing existing socket: ${error.message}`);
            }
            state.socket = null;
        }
        
        const url = this.buildUrl(config, token);
        this.logger.info(`[${serverId}] Attempting to connect (Attempt #${state.retryCount + 1}). URL: ${url}`);

        try {
            const socket = new WebSocket(url, { rejectUnauthorized: false });
            state.socket = socket;

            socket.on('open', () => {
                this.logger.info(`[${serverId}] WebSocket connection opened successfully. Waiting for '___ready___' signal.`);
                state.retryCount = 0;
                state.authFailureCount = 0;
            });

            socket.on('message', (data) => {
                const messageStr = data.toString();
                if (messageStr === '[1]') {
                    this.logger.trace(`[${serverId}] Ping received. Sending Pong.`);
                    socket.send('[2]');
                    return;
                }
                eventBus.emit('websocket:message', { serverId, data });
            });

            socket.on('error', (error) => {
                this.logger.error(`[${serverId}] Connection error: ${error.message}`);
            });

            socket.on('close', (code) => {
                this.logger.warn(`[${serverId}] Connection closed with code: ${code}. Scheduling reconnect.`);
                eventBus.emit('connection:disconnected', { serverId });
                this.scheduleReconnect(serverId);
            });

        } catch (error) {
            this.logger.error(`[${serverId}] Failed to create WebSocket: ${error.message}`);
            this.scheduleReconnect(serverId);
        }
    }

    handleAuthFailure(serverId, error) {
        this.logger.error(`[${serverId}] Authentication failure reported: ${error.message}`);
        const state = this.connections.get(serverId);
        if (state) {
            state.authFailureCount++;
            if (state.authFailureCount >= MAX_AUTH_FAILURES) {
                this.logger.error(`[${serverId}] Max authentication failures (${MAX_AUTH_FAILURES}) reached. Marking as permanently failed.`);
                state.isPermanentFailure = true;
                eventBus.emit('connection:failed_permanently', { serverId, error: new Error('Maximum authentication attempts exceeded.') });
            } else {
                this.logger.warn(`[${serverId}] Auth failure count is ${state.authFailureCount}. Scheduling reconnect.`);
                this.scheduleReconnect(serverId);
            }
        }
    }

    handleNetworkError(serverId, error) {
        this.logger.warn(`[${serverId}] Network error reported: ${error.message}. Scheduling reconnect without counting as auth failure.`);
        const state = this.connections.get(serverId);
        if (state && !state.isPermanentFailure) {
            this.logger.debug(`[${serverId}] Current connection state - retryCount: ${state.retryCount}, authFailureCount: ${state.authFailureCount}`);
            // Don't increment authFailureCount for network errors
            this.scheduleReconnect(serverId);
        } else if (!state) {
            this.logger.error(`[${serverId}] No connection state found for network error handling`);
        } else if (state.isPermanentFailure) {
            this.logger.warn(`[${serverId}] Server marked as permanently failed, not scheduling reconnect`);
        }
    }

    scheduleReconnect(serverId) {
        const state = this.connections.get(serverId);
        if (!state) {
            this.logger.error(`[${serverId}] Cannot schedule reconnect: no connection state found`);
            return;
        }
        if (state.isPermanentFailure) {
            this.logger.warn(`[${serverId}] Cannot schedule reconnect: server marked as permanently failed`);
            return;
        }

        // Cancel any existing timer
        if (state.timerId) {
            this.logger.debug(`[${serverId}] Cancelling existing reconnect timer`);
            clearTimeout(state.timerId);
            state.timerId = null;
        }

        const delay = Math.min(MAX_RETRY_DELAY, INITIAL_RETRY_DELAY * Math.pow(2, state.retryCount));
        state.retryCount++;
        
        this.logger.info(`[${serverId}] Scheduling reconnect attempt #${state.retryCount} in ${delay / 1000} seconds.`);
        eventBus.emit('connection:retrying', { serverId, attempt: state.retryCount, delay });

        state.timerId = setTimeout(() => {
            this.logger.info(`[${serverId}] Reconnect timer triggered, emitting connection:request`);
            eventBus.emit('connection:request', state.config);
        }, delay);
    }
    
    send(serverId, payload) {
        const state = this.connections.get(serverId);
        if (state && state.socket && state.socket.readyState === WebSocket.OPEN) {
            const message = JSON.stringify(payload);
            this.logger.trace(`[${serverId}] Sending message: ${message}`);
            state.socket.send(message);
        } else {
            this.logger.warn(`[${serverId}] Could not send message: No open connection found.`);
        }
    }
    
    buildUrl({ iobhost, iobport, usessl }, token) {
        const protocol = usessl ? 'wss' : 'ws';
        let url = `${protocol}://${iobhost}:${iobport}/?sid=${Date.now()}`;
        if (token) {
            url += `&token=${token}`;
        }
        return url;
    }
}

module.exports = ConnectionService;