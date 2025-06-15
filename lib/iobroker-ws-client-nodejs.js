/*!
 * ioBroker WebSockets - Node.js Only
 */

// Import WebSocket for Node.js environment
let WebSocketClass;
try {
    WebSocketClass = require('ws');
} catch (error) {
    throw new Error('WebSocket library not found. Please install "ws" package: npm install ws');
}

// Buffer implementation for Node.js
const BufferImpl = require('buffer').Buffer;

const MESSAGE_TYPES = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

const DEBUG = false;

const ERRORS = {
    1000: 'CLOSE_NORMAL',
    1001: 'CLOSE_GOING_AWAY',
    1002: 'CLOSE_PROTOCOL_ERROR',
    1003: 'CLOSE_UNSUPPORTED',
    1005: 'CLOSED_NO_STATUS',
    1006: 'CLOSE_ABNORMAL',
    1007: 'Unsupported payload',
    1008: 'Policy violation',
    1009: 'CLOSE_TOO_LARGE',
    1010: 'Mandatory extension',
    1011: 'Server error',
    1012: 'Service restart',
    1013: 'Try again later',
    1014: 'Bad gateway Server',
    1015: 'TLS handshake fail',
};

class SocketClient {
    constructor() {
        this.connectHandlers = [];
        this.reconnectHandlers = [];
        this.disconnectHandlers = [];
        this.errorHandlers = [];
        this.handlers = {};
        this.wasConnected = false;
        this.connectTimer = null;
        this.connectingTimer = null;
        this.connectionCount = 0;
        this.callbacks = [];
        this.pending = [];
        this.id = 0;
        this.lastPong = 0;
        this.socket = null;
        this.url = '';
        this.options = null;
        this.pingInterval = null;
        this.sessionID = 0;
        this.authTimeout = null;
        this.connected = false;

        this.log = {
            debug: (text) => DEBUG && console.log(`[${new Date().toISOString()}] ${text}`),
            warn: (text) => console.warn(`[${new Date().toISOString()}] ${text}`),
            error: (text) => console.error(`[${new Date().toISOString()}] ${text}`),
        };

        this.emit = this.emit.bind(this);
        this.disconnect = this.close.bind(this);
    }

    static getQuery(_url) {
        const query = _url.split('?')[1] || '';
        const parts = query.split('&');
        const result = {};
        for (let p = 0; p < parts.length; p++) {
            const parts1 = parts[p].split('=');
            result[parts1[0]] = decodeURIComponent(parts1[1] || '');
        }
        return result;
    }

    static arrayBufferToBase64(buffer) {
        const nodeBuffer = BufferImpl.from(buffer);
        return nodeBuffer.toString('base64');
    }

    getCurrentUrl(providedUrl) {
        if (!providedUrl) {
            throw new Error('URL is required in Node.js environment');
        }
        return providedUrl;
    }

    constructWebSocketUrl(url) {
        url = url.split('#')[0];
        const query = SocketClient.getQuery(url);
        if (query.sid) {
            delete query.sid;
        }
        if (Object.prototype.hasOwnProperty.call(query, '')) {
            delete query[''];
        }
        let wsUrl = url.replace(/^http/, 'ws').split('?')[0];
        wsUrl += `?sid=${this.sessionID}`;
        if (Object.keys(query).length) {
            wsUrl += `&${Object.keys(query)
                .map(attr => (query[attr] === undefined ? attr : `${attr}=${query[attr]}`))
                .join('&')}`;
        }
        if (this.options?.name && !query.name) {
            wsUrl += `&name=${encodeURIComponent(this.options.name)}`;
        }
        if (this.options?.token) {
            wsUrl += `&token=${this.options.token}`;
        }
        return wsUrl;
    }

    connect(url, options) {
        this.log.debug('Try to connect');

        this.id = 0;
        this.connectTimer && clearInterval(this.connectTimer);
        this.connectTimer = null;

        this.url = this.url || this.getCurrentUrl(url);
        this.options = this.options || JSON.parse(JSON.stringify(options || {}));
        if (!this.options) {
            throw new Error('No options provided!');
        }

        this.options.pongTimeout = parseInt(this.options.pongTimeout, 10) || 60000;
        this.options.pingInterval = parseInt(this.options.pingInterval, 10) || 5000;
        this.options.connectTimeout = parseInt(this.options.connectTimeout, 10) || 3000;
        this.options.authTimeout = parseInt(this.options.authTimeout, 10) || 3000;
        this.options.connectInterval = parseInt(this.options.connectInterval, 10) || 1000;
        this.options.connectMaxAttempt = parseInt(this.options.connectMaxAttempt, 10) || 5;

        this.sessionID = Date.now();

        try {
            const wsUrl = this.constructWebSocketUrl(this.url);
            this.socket = new WebSocketClass(wsUrl);
        } catch (error) {
            this.handlers.error?.forEach(cb => cb.call(this, error));
            this.close();
            return this;
        }

        this.connectingTimer = setTimeout(() => {
            this.connectingTimer = null;
            this.log.warn('No READY flag received in timeout period. Re-init');
            this.close();
        }, this.options.connectTimeout);

        this.socket.onopen = () => {
            this.lastPong = Date.now();
            this.connectionCount = 0;

            this.pingInterval = setInterval(() => {
                if (!this.options) {
                    throw new Error('No options provided!');
                }

                if (Date.now() - this.lastPong > (this.options?.pingInterval || 5000) - 10) {
                    try {
                        this.socket?.send(JSON.stringify([MESSAGE_TYPES.PING]));
                    } catch (e) {
                        this.log.warn(`Cannot send ping. Close connection: ${e}`);
                        this.close();
                        this._garbageCollect();
                        return;
                    }
                }
                if (Date.now() - this.lastPong > (this.options?.pongTimeout || 60000)) {
                    this.close();
                }
                this._garbageCollect();
            }, this.options?.pingInterval || 5000);
        };

        this.socket.onclose = (event) => {
            if (event.code === 3001) {
                this.log.warn('ws closed');
            } else {
                this.log.error(`ws connection error: ${ERRORS[event.code] || 'UNKNOWN'}`);
            }
            this.close();
        };

        this.socket.onerror = (error) => {
            if (this.connected && this.socket) {
                if (this.socket.readyState === 1) {
                    this.log.error(`ws normal error: ${error.type || error.message || 'UNKNOWN'}`);
                }
                this.errorHandlers.forEach(cb => cb.call(this, error.message || 'UNKNOWN'));
            }
            this.close();
        };

        this.socket.onmessage = (message) => {
            this.lastPong = Date.now();
            const messageData = message.data || message;
            if (!messageData || typeof messageData !== 'string') {
                console.error(`Received invalid message: ${JSON.stringify(message)}`);
                return;
            }
            let data;
            try {
                data = JSON.parse(messageData);
            } catch {
                console.error(`Received invalid message: ${JSON.stringify(messageData)}`);
                return;
            }
            const type = data[0];
            const id = data[1];
            const name = data[2];
            const args = data[3];

            if (type === MESSAGE_TYPES.MESSAGE && name === 'getStatesResponse') {
                this.handlers.getStatesResponse?.forEach(cb => cb(args[0]));
            }

            if (this.authTimeout) {
                clearTimeout(this.authTimeout);
                this.authTimeout = null;
            }

            if (type === MESSAGE_TYPES.CALLBACK) {
                this.findAnswer(id, args);
            } else if (type === MESSAGE_TYPES.MESSAGE) {
                if (name === '___ready___') {
                    this.log.debug('___ready___ received');
                    this.connected = true;
                    this.connectionCount = 0;
                    if (this.wasConnected) {
                        this.reconnectHandlers.forEach(cb => cb.call(this, true));
                    } else {
                        this.connectHandlers.forEach(cb => cb.call(this, true));
                        this.wasConnected = true;
                    }
                    this.connectingTimer && clearTimeout(this.connectingTimer);
                    this.connectingTimer = null;
                    if (this.pending.length) {
                        this.pending.forEach(({ name, args }) => this.emit(name, ...args));
                        this.pending = [];
                    }
                } else if (args) {
                    this.log.debug(`Received message: ${name}`);
                    this.handlers[name]?.forEach(cb => cb.apply(this, args));
                } else {
                    this.log.debug(`Received message: ${name}`);
                    this.handlers[name]?.forEach(cb => cb.call(this));
                }
            } else if (type === MESSAGE_TYPES.PING) {
                if (this.socket) {
                    this.socket.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                } else {
                    this.log.warn('Cannot do pong: connection closed');
                }
            } else if (type === MESSAGE_TYPES.PONG) {
                // lastPong saved
            } else {
                this.log.warn(`Received unknown message type: ${type}`);
            }
        };

        return this;
    }

    _garbageCollect() {
        const now = Date.now();
        let empty = 0;
        if (!DEBUG) {
            for (let i = 0; i < this.callbacks.length; i++) {
                const callback = this.callbacks[i];
                if (callback) {
                    if (callback.ts < now) {
                        const cb = callback.cb;
                        setTimeout(cb, 0, 'timeout');
                        this.callbacks[i] = null;
                        empty++;
                    }
                } else {
                    empty++;
                }
            }
        }
        if (empty > this.callbacks.length / 2) {
            const newCallback = [];
            for (let i = 0; i < this.callbacks.length; i++) {
                if (this.callbacks[i]) {
                    newCallback.push(this.callbacks[i]);
                }
            }
            this.callbacks = newCallback;
        }
    }

    withCallback(name, id, args, cb) {
        if (name === 'authenticate') {
            this.authTimeout = setTimeout(() => {
                this.authTimeout = null;
                if (this.connected) {
                    this.log.debug('Authenticate timeout');
                    this.handlers.error?.forEach(cb => cb.call(this, 'Authenticate timeout'));
                }
                this.close();
            }, this.options?.authTimeout || 3000);
        }
        this.callbacks.push({ id, cb, ts: DEBUG ? 0 : Date.now() + 30000 });
        this.socket?.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
    }

    findAnswer(id, args) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                const cb = callback.cb;
                cb.call(null, ...args);
                this.callbacks[i] = null;
            }
        }
    }

    emit(name, ...args) {
        if (!this.socket || !this.connected) {
            if (!this.wasConnected) {
                this.pending.push({ name, args });
            } else {
                this.log.warn('Not connected');
            }
            return;
        }
        this.id++;
        if (name === 'writeFile' && args && typeof args[2] !== 'string' && args[2]) {
            args[2] = SocketClient.arrayBufferToBase64(args[2]);
        }
        try {
            if (args && typeof args[args.length - 1] === 'function') {
                const _args = [...args];
                const eventHandler = _args.pop();
                this.withCallback(name, this.id, _args, eventHandler);
            } else if (!args?.length) {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name]));
            } else {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name, args]));
            }
        } catch (e) {
            console.error(`Cannot send: ${e}`);
            this.close();
        }
    }

    on(name, cb) {
        if (cb) {
            if (name === 'connect') {
                this.connectHandlers.push(cb);
            } else if (name === 'disconnect') {
                this.disconnectHandlers.push(cb);
            } else if (name === 'reconnect') {
                this.reconnectHandlers.push(cb);
            } else if (name === 'error') {
                this.errorHandlers.push(cb);
            } else {
                this.handlers[name] = this.handlers[name] || [];
                this.handlers[name].push(cb);
            }
        }
    }

    off(name, cb) {
        if (name === 'connect') {
            const pos = this.connectHandlers.indexOf(cb);
            if (pos !== -1) {
                this.connectHandlers.splice(pos, 1);
            }
        } else if (name === 'disconnect') {
            const pos = this.disconnectHandlers.indexOf(cb);
            if (pos !== -1) {
                this.disconnectHandlers.splice(pos, 1);
            }
        } else if (name === 'reconnect') {
            const pos = this.reconnectHandlers.indexOf(cb);
            if (pos !== -1) {
                this.reconnectHandlers.splice(pos, 1);
            }
        } else if (name === 'error') {
            const pos = this.errorHandlers.indexOf(cb);
            if (pos !== -1) {
                this.errorHandlers.splice(pos, 1);
            }
        } else if (this.handlers[name]) {
            const pos = this.handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.handlers[name].splice(pos, 1);
                if (!this.handlers[name].length) {
                    delete this.handlers[name];
                }
            }
        }
    }

    close() {
        this.pingInterval && clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.authTimeout && clearTimeout(this.authTimeout);
        this.authTimeout = null;
        this.connectingTimer && clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                // ignore
            }
            this.socket = null;
        }
        if (this.connected) {
            this.disconnectHandlers.forEach(cb => cb.call(this));
            this.connected = false;
        }
        this.callbacks = [];
        this._reconnect();
        return this;
    }

    destroy() {
        this.close();
        this.connectTimer && clearTimeout(this.connectTimer);
        this.connectTimer = null;
    }

    _reconnect() {
        this.sessionID = Date.now();
        if (!this.connectTimer) {
            this.log.debug(`Start reconnect ${this.connectionCount}`);
            this.connectTimer = setTimeout(
                () => {
                    if (!this.options) {
                        throw new Error('No options provided!');
                    }
                    this.connectTimer = null;
                    if (this.connectionCount < (this.options?.connectMaxAttempt || 5)) {
                        this.connectionCount++;
                    }
                    this.connect(this.url, this.options);
                },
                this.connectionCount * (this.options?.connectInterval || 1000),
            );
        } else {
            this.log.debug(`Reconnect is already running ${this.connectionCount}`);
        }
    }
}

function connect(url, options) {
    const socketClient = new SocketClient();
    socketClient.connect(url, options);
    return socketClient;
}

module.exports = {
    connect,
    SocketClient
};
