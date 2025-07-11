/*!
 * WebSocket Client for ioBroker
 */

const AuthManager = require('./auth-manager');
const StateHandler = require('./state-handler');
const { Logger } = require('../utils/logger');

let WebSocketClass;
try {
    WebSocketClass = require('ws');
} catch (error) {
    throw new Error('WebSocket library not found. Please install "ws" package: npm install ws');
}

const MESSAGE_TYPES = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

class SocketClient {
    constructor() {
        this.connectHandlers = [];
        this.reconnectHandlers = [];
        this.disconnectHandlers = [];
        this.errorHandlers = [];
        this.readyHandlers = [];
        this.handlers = {};
        this.wasConnected = false;
        this.callbacks = [];
        this.pending = [];
        this.id = 0;
        this.lastPong = 0;
        this.socket = null;
        this.url = '';
        this.options = null;
        this.pingInterval = null;
        this.connectingTimer = null;
        this.sessionID = 0;
        this.connected = false;
        this.authenticated = false;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.destroyed = false;
        this.lastError = null;
        this.clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        this.useSSL = false;
        this.useAuthentication = false;
        this.connectionRecoveryEnabled = true;

        this.authManager = new AuthManager(this);
        this.stateHandler = new StateHandler(this);

        this.log = new Logger(`WebSocketClient:${this.clientId}`);
        this.emit = this.emit.bind(this);
        this.disconnect = this.close.bind(this);
    }

    isClientReady() {
        return this.connected && !this.destroyed && (!this.useAuthentication || this.authenticated);
    }

    async getState(stateId) {
        if (!this.isClientReady()) {
            throw new Error('Client not ready for operations');
        }
        return await this.stateHandler.getState(stateId);
    }

    async subscribe(stateIdOrPattern, callback) {
        if (!this.isClientReady()) {
            throw new Error('Client not ready for subscribe');
        }
        return await this.stateHandler.subscribe(stateIdOrPattern, callback);
    }

    getConnectionStats() {
        const stats = {
            connected: this.connected,
            authenticated: this.authenticated,
            ready: this.isClientReady(),
            destroyed: this.destroyed,
            sessionID: this.sessionID,
            useSSL: this.useSSL,
            useAuthentication: this.useAuthentication,
            subscriptionCount: this.stateHandler.subscriptions.size,
            pendingRequests: this.stateHandler.pendingStateRequests.size,
            lastError: this.lastError,
            connectionRecoveryEnabled: this.connectionRecoveryEnabled,
            isConnecting: this.isConnecting,
            hasConnectingTimer: !!this.connectingTimer
        };

        Object.assign(stats, this.authManager.getStats());
        return stats;
    }

    setConnectionRecovery(enabled) {
        this.connectionRecoveryEnabled = enabled;
    }

    determineSSLUsage(host, port, explicitSSL) {
        if (explicitSSL !== undefined) {
            return explicitSSL;
        }
        return port === 443 || port === 8443 || port === 8084;
    }

    constructWebSocketUrl(url) {
        url = url.split('#')[0];
        const protocol = this.useSSL ? 'wss' : 'ws';
        let wsUrl = url.replace(/^(ws|wss|http|https):\/\//, `${protocol}://`).split('?')[0];

        wsUrl += `?sid=${this.sessionID}`;

        if (this.options?.name) {
            wsUrl += `&name=${encodeURIComponent(this.options.name)}`;
        }

        if (this.useAuthentication && this.authManager.getAccessToken()) {
            wsUrl += `&token=${this.authManager.getAccessToken()}`;
        }

        this.log.debug(`WebSocket URL constructed: ${protocol}:// with session ${this.sessionID}`);
        return wsUrl;
    }

    clearAllTimers() {
        if (this.connectingTimer) {
            clearTimeout(this.connectingTimer);
            this.connectingTimer = null;
            this.log.debug('Cleared connecting timer');
        }

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
            this.log.debug('Cleared ping interval');
        }
    }

    async connect(url, options) {
        if (this.destroyed) {
            throw new Error('Client has been destroyed');
        }

        if (this.isConnecting && this.connectionPromise) {
            return this.connectionPromise;
        }

        if (this.connected && this.socket) {
            return this;
        }

        this.isConnecting = true;
        this.connectionPromise = this._performConnection(url, options);

        try {
            const result = await this.connectionPromise;
            return result;
        } catch (error) {
            this.isConnecting = false;
            this.connectionPromise = null;
            this.lastError = error.message || error.toString();
            this.clearAllTimers();
            throw error;
        } finally {
            this.isConnecting = false;
            this.connectionPromise = null;
        }
    }

    async _performConnection(url, options) {
        try {
            if (this.destroyed) {
                throw new Error('Client has been destroyed');
            }

            this.clearAllTimers();

            this.id = 0;
            this.url = this.url || url;
            this.options = this.options || JSON.parse(JSON.stringify(options || {}));

            if (!this.options) {
                throw new Error('No options provided');
            }

            this.useSSL = this.determineSSLUsage(
                this.options.host,
                this.options.port,
                this.options.useSSL
            );

            this.log.debug(`SSL mode: ${this.useSSL ? 'enabled' : 'disabled'} for ${this.options.host}:${this.options.port}`);

            this.useAuthentication = !!(this.options.username && this.options.username.trim());

            this.options.pongTimeout = parseInt(this.options.pongTimeout, 10) || 60000;
            this.options.pingInterval = parseInt(this.options.pingInterval, 10) || 5000;
            this.options.connectTimeout = parseInt(this.options.connectTimeout, 10) || 15000;

            const protocol = this.useSSL ? 'https' : 'http';
            const urlObj = new URL(this.url.replace(/^(ws|wss)/, protocol));
            this.options.host = this.options.host || urlObj.hostname;
            this.options.port = this.options.port || urlObj.port;

            this.sessionID = Date.now();

            if (this.useAuthentication) {
                this.log.debug('Starting authentication process');
                await this.authManager.authenticate(this.options);
                this.log.debug('Authentication completed');
            }

            if (this.socket) {
                try {
                    this.socket.close();
                } catch (e) { }
                this.socket = null;
            }

            const wsUrl = this.constructWebSocketUrl(this.url);
            const headers = this.createHeaders();

            const wsOptions = {
                headers: headers,
                handshakeTimeout: this.options.connectTimeout,
                perMessageDeflate: false,
                followRedirects: true,
                protocolVersion: 13,
                mask: true
            };

            if (this.useSSL) {
                wsOptions.rejectUnauthorized = false;
                wsOptions.ca = undefined;
            }

            this.log.info(`Establishing WebSocket connection to ${this.options.host}:${this.options.port} (${this.useSSL ? 'SSL' : 'non-SSL'})`);
            this.socket = new WebSocketClass(wsUrl, wsOptions);
            this.setupWebSocketHandlers();

            await this.waitForConnection();

        } catch (error) {
            this.emitError(error);
            this.close();
            throw error;
        }

        return this;
    }

    createHeaders() {
        const urlObj = new URL(this.url.replace(/^(ws|wss)/, this.useSSL ? 'https' : 'http'));

        const headers = {
            'Host': `${urlObj.hostname}:${urlObj.port}`,
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13',
            'Origin': `${this.useSSL ? 'https' : 'http'}://${urlObj.hostname}:${urlObj.port}`,
            'User-Agent': 'Node-RED-ioBroker/1.0.0'
        };

        const accessToken = this.authManager.getAccessToken();
        if (this.useAuthentication && accessToken && accessToken.trim()) {
            headers['Authorization'] = `Bearer ${accessToken}`;
            headers['Cookie'] = `access_token=${accessToken}; io=${this.sessionID}`;
        } else {
            headers['Cookie'] = `io=${this.sessionID}`;
        }

        return headers;
    }

    waitForConnection() {
        return new Promise((resolve, reject) => {
            if (this.destroyed) {
                reject(new Error('Client has been destroyed'));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, this.options.connectTimeout);

            const cleanup = () => {
                clearTimeout(timeout);
                this.socket?.removeListener('open', onOpen);
                this.socket?.removeListener('error', onError);
                this.socket?.removeListener('close', onClose);
            };

            const onOpen = () => {
                if (this.destroyed) {
                    cleanup();
                    reject(new Error('Client destroyed during connection'));
                    return;
                }
                cleanup();
                resolve();
            };

            const onError = (error) => {
                cleanup();
                reject(error);
            };

            const onClose = (event) => {
                cleanup();
                reject(new Error(`Connection closed during handshake: ${event.code} - ${event.reason}`));
            };

            if (this.socket) {
                this.socket.once('open', onOpen);
                this.socket.once('error', onError);
                this.socket.once('close', onClose);
            } else {
                cleanup();
                reject(new Error('No socket available'));
            }
        });
    }

    setupWebSocketHandlers() {
        if (!this.socket) {
            return;
        }

        this.connectingTimer = setTimeout(() => {
            if (this.destroyed) return;

            this.log.debug('Connecting timer fired - no ready signal received');
            this.connectingTimer = null;
            this.emitError('Connection timeout - no ready signal');
            this.close();
        }, this.options.connectTimeout);

        this.log.debug(`Set connecting timer for ${this.options.connectTimeout}ms`);

        this.socket.onopen = () => {
            if (this.destroyed) {
                try {
                    this.socket.close();
                } catch (e) { }
                return;
            }

            this.log.debug('WebSocket opened, waiting for ready signal');
            this.lastPong = Date.now();
            this.authenticated = this.useAuthentication;

            this.pingInterval = setInterval(() => {
                if (this.destroyed || !this.socket) {
                    clearInterval(this.pingInterval);
                    this.pingInterval = null;
                    return;
                }

                if (Date.now() - this.lastPong > (this.options?.pingInterval || 5000) - 10) {
                    try {
                        this.socket?.send(JSON.stringify([MESSAGE_TYPES.PING]));
                    } catch (e) {
                        this.close();
                        return;
                    }
                }
                if (Date.now() - this.lastPong > (this.options?.pongTimeout || 60000)) {
                    this.close();
                }
            }, this.options?.pingInterval || 5000);
        };

        this.socket.onclose = (event) => {
            if (this.destroyed) {
                return;
            }
            this.log.debug(`WebSocket closed: ${event.code} - ${event.reason}`);
            this.close();
        };

        this.socket.onerror = (error) => {
            if (this.destroyed) {
                return;
            }

            const errorMessage = error.message || error.toString() || 'WebSocket error';
            this.log.debug(`WebSocket error: ${errorMessage}`);
            this.emitError(errorMessage);
            this.close();
        };

        this.socket.onmessage = (message) => {
            if (this.destroyed) {
                return;
            }

            try {
                this.handleMessage(message);
            } catch (error) {
                this.emitError(`Message handling error: ${error.message}`);
            }
        };
    }

    handleMessage(message) {
        this.lastPong = Date.now();
        const messageData = message.data || message;

        if (!messageData || typeof messageData !== 'string') {
            return;
        }

        let data;
        try {
            data = JSON.parse(messageData);
        } catch (error) {
            return;
        }

        if (!Array.isArray(data)) {
            return;
        }

        if (data.length === 1) {
            const type = data[0];

            if (type === MESSAGE_TYPES.PING) {
                try {
                    this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                } catch (e) { }
                return;
            } else if (type === MESSAGE_TYPES.PONG) {
                return;
            }

            if (data.length < 2) {
                return;
            }
        }

        if (data.length < 2) {
            return;
        }

        const type = data[0];
        const id = data[1];
        const name = data[2];
        const args = data[3];

        try {
            if (type === MESSAGE_TYPES.CALLBACK) {
                this.findAnswer(id, args);
            } else if (type === MESSAGE_TYPES.MESSAGE) {
                if (name === '___ready___') {
                    this._handleConnection();
                } else if (name === 'reauthenticate') {
                    this.authManager.handleReauthenticate();
                } else if (name === 'stateChange') {
                    if (args && args.length >= 2) {
                        const [stateId, state] = args;
                        this.log.debug(`State change received: ${stateId}`);

                        if (this.handlers['stateChange']) {
                            this.handlers['stateChange'].forEach(cb => {
                                try {
                                    cb.call(this, stateId, state);
                                } catch (err) {
                                    this.log.debug(`State change callback error: ${err.message}`);
                                }
                            });
                        }
                    }
                } else if (name === 'objectChange') {
                    if (args && args.length >= 2) {
                        const [objectId, objectData] = args;
                        const operation = args[2] || (objectData ? 'update' : 'delete');

                        this.log.debug(`Object change received: ${objectId} (${operation})`);

                        if (this.handlers['objectChange']) {
                            this.handlers['objectChange'].forEach(cb => {
                                try {
                                    cb.call(this, objectId, objectData, operation);
                                } catch (err) {
                                    this.log.debug(`Object change callback error: ${err.message}`);
                                }
                            });
                        }
                    }
                } else if (name === 'log') {
                    if (args && args.length >= 1) {
                        const logData = args[0];

                        if (this.handlers['log']) {
                            this.handlers['log'].forEach(cb => {
                                try {
                                    cb.call(this, logData);
                                } catch (err) {
                                    this.log.debug(`Log callback error: ${err.message}`);
                                }
                            });
                        }
                    }
                } else {
                    if (this.handlers[name]) {
                        this.handlers[name].forEach(cb => {
                            try {
                                if (args) {
                                    cb.apply(this, args);
                                } else {
                                    cb.call(this);
                                }
                            } catch (err) { }
                        });
                    }
                }
            } else if (type === MESSAGE_TYPES.PING) {
                try {
                    this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                } catch (e) { }
            }
        } catch (error) { }
    }

    _handleConnection() {
        if (this.destroyed) {
            return;
        }

        if (this.connectingTimer) {
            clearTimeout(this.connectingTimer);
            this.connectingTimer = null;
            this.log.debug('Cleared connecting timer - ready signal received');
        }

        this.connected = true;

        this.log.info(`WebSocket connection established with session ${this.sessionID} (${this.useSSL ? 'SSL' : 'non-SSL'})`);

        this.emitReady();

        try {
            if (this.wasConnected) {
                this.log.debug('Notifying reconnect handlers');
                this.reconnectHandlers.forEach(cb => {
                    try {
                        cb.call(this, true);
                    } catch (err) { }
                });
            } else {
                this.log.debug('Notifying connect handlers');
                this.connectHandlers.forEach(cb => {
                    try {
                        cb.call(this, true);
                    } catch (err) { }
                });
                this.wasConnected = true;
            }
        } catch (error) { }

        if (this.pending.length) {
            const pendingCopy = [...this.pending];
            this.pending = [];
            this.log.debug(`Processing ${pendingCopy.length} pending messages`);
            pendingCopy.forEach(({ name, args }) => {
                try {
                    this.emit(name, ...args);
                } catch (error) { }
            });
        }
    }

    emit(name, ...args) {
        if (this.destroyed) {
            return;
        }

        if (!this.socket || !this.connected) {
            if (!this.wasConnected && !this.destroyed) {
                this.pending.push({ name, args });
            }
            return;
        }

        this.id++;
        try {
            if (args && typeof args[args.length - 1] === 'function') {
                const _args = [...args];
                const callback = _args.pop();
                this.withCallback(name, this.id, _args, callback);
            } else if (!args?.length) {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name]));
            } else {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name, args]));
            }
        } catch (e) {
            this.close();
        }
    }

    withCallback(name, id, args, cb) {
        this.callbacks.push({ id, cb, ts: Date.now() + 30000 });
        try {
            this.socket?.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
        } catch (e) { }
    }

    findAnswer(id, args) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                try {
                    callback.cb.call(null, ...args);
                } catch (err) { }
                this.callbacks[i] = null;
                break;
            }
        }

        this.callbacks = this.callbacks.filter(cb => cb && cb.ts > Date.now());
    }

    on(name, cb) {
        if (!cb || typeof cb !== 'function') {
            return;
        }

        if (name === 'connect') {
            this.connectHandlers.push(cb);
        } else if (name === 'disconnect') {
            this.disconnectHandlers.push(cb);
        } else if (name === 'reconnect') {
            this.reconnectHandlers.push(cb);
        } else if (name === 'error') {
            this.errorHandlers.push(cb);
        } else if (name === 'ready') {
            this.readyHandlers.push(cb);
        } else {
            this.handlers[name] = this.handlers[name] || [];
            this.handlers[name].push(cb);
        }
    }

    off(name, cb) {
        const removeFromArray = (array) => {
            const pos = array.indexOf(cb);
            if (pos !== -1) array.splice(pos, 1);
        };

        if (name === 'connect') {
            removeFromArray(this.connectHandlers);
        } else if (name === 'disconnect') {
            removeFromArray(this.disconnectHandlers);
        } else if (name === 'reconnect') {
            removeFromArray(this.reconnectHandlers);
        } else if (name === 'error') {
            removeFromArray(this.errorHandlers);
        } else if (name === 'ready') {
            removeFromArray(this.readyHandlers);
        } else if (this.handlers[name]) {
            removeFromArray(this.handlers[name]);
            if (this.handlers[name].length === 0) {
                delete this.handlers[name];
            }
        }
    }

    emitReady() {
        this.readyHandlers.forEach(cb => {
            try {
                cb.call(this);
            } catch (callbackError) {
                console.error('Error in ready callback:', callbackError);
            }
        });
    }

    emitError(error) {
        if (this.destroyed) {
            return;
        }

        const errorMessage = typeof error === 'string' ? error : (error.message || 'Unknown error');
        this.lastError = errorMessage;
        this.log.error(errorMessage);

        this.errorHandlers.forEach(cb => {
            try {
                cb.call(this, errorMessage);
            } catch (callbackError) {
                console.error('Error in error callback:', callbackError);
            }
        });
    }

    close() {
        this.clearAllTimers();
        this.authManager.cleanup();

        if (this.socket) {
            try {
                this.socket.close();
            } catch (error) { }
            this.socket = null;
        }

        if (this.connected && !this.destroyed) {
            this.log.debug('Notifying disconnect handlers');
            this.disconnectHandlers.forEach(cb => {
                try {
                    cb.call(this);
                } catch (err) { }
            });
        }

        this.connected = false;
        this.authenticated = false;
        this.callbacks = [];

        this.stateHandler.clear();

        return this;
    }

    destroy() {
        this.log.debug(`Destroying client ${this.clientId}`);

        this.destroyed = true;

        this.close();
        this.clearAllTimers();
        this.authManager.destroy();
        this.stateHandler.destroy();
        this.removeAllEventListeners();
        this.clearAllCollections();
        this.nullifyReferences();

        this.log.debug(`Client ${this.clientId} destroyed completely`);
    }

    removeAllEventListeners() {
        if (this.socket) {
            try {
                this.socket.onopen = null;
                this.socket.onclose = null;
                this.socket.onerror = null;
                this.socket.onmessage = null;

                if (this.socket.readyState === WebSocket.OPEN ||
                    this.socket.readyState === WebSocket.CONNECTING) {
                    this.socket.close(1000, 'Client destroyed');
                }
            } catch (error) {
                this.log.debug(`WebSocket cleanup warning: ${error.message}`);
            }
            this.socket = null;
        }
    }

    clearAllCollections() {
        if (Array.isArray(this.connectHandlers)) {
            this.connectHandlers.length = 0;
        }
        if (Array.isArray(this.reconnectHandlers)) {
            this.reconnectHandlers.length = 0;
        }
        if (Array.isArray(this.disconnectHandlers)) {
            this.disconnectHandlers.length = 0;
        }
        if (Array.isArray(this.errorHandlers)) {
            this.errorHandlers.length = 0;
        }
        if (Array.isArray(this.readyHandlers)) {
            this.readyHandlers.length = 0;
        }
        if (Array.isArray(this.pending)) {
            this.pending.length = 0;
        }
        if (Array.isArray(this.callbacks)) {
            this.callbacks.length = 0;
        }

        if (this.handlers && typeof this.handlers === 'object') {
            Object.keys(this.handlers).forEach(key => {
                if (Array.isArray(this.handlers[key])) {
                    this.handlers[key].length = 0;
                }
            });
        }
    }

    nullifyReferences() {
        this.authManager = null;
        this.stateHandler = null;
        this.options = null;
        this.url = '';
        this.connectionPromise = null;
        this.lastError = null;

        this.connectHandlers = null;
        this.reconnectHandlers = null;
        this.disconnectHandlers = null;
        this.errorHandlers = null;
        this.readyHandlers = null;
        this.handlers = null;
        this.pending = null;
        this.callbacks = null;
    }

    getSessionInfo() {
        return {
            sessionId: this.sessionID,
            isAuthenticated: this.authenticated,
            hasToken: !!this.authManager.getAccessToken(),
            useSSL: this.useSSL,
            ...this.getConnectionStats()
        };
    }
}

function connect(url, options) {
    const socketClient = new SocketClient();
    socketClient.connect(url, options);
    return socketClient;
}

module.exports = {
    connect,
    SocketClient,
    MESSAGE_TYPES
};