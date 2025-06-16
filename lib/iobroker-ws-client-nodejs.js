/*!
 * ioBroker WebSocket with authentication support
 */

const https = require('https');
const http = require('http');
let WebSocketClass;
try {
    WebSocketClass = require('ws');
} catch (error) {
    throw new Error('WebSocket library not found. Please install "ws" package: npm install ws');
}

const BufferImpl = require('buffer').Buffer;

const MESSAGE_TYPES = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

const DEBUG = false;

class AuthenticatedSocketClient {
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
        this.authenticated = false;
        this.accessToken = null;

        this.log = {
            debug: (text) => DEBUG && console.log(`[${new Date().toISOString()}] ${text}`),
            warn: (text) => console.warn(`[${new Date().toISOString()}] ${text}`),
            error: (text) => console.error(`[${new Date().toISOString()}] ${text}`),
        };

        this.emit = this.emit.bind(this);
        this.disconnect = this.close.bind(this);
    }

    /**
     * OAuth2 Token von ioBroker abrufen
     */
    async getOAuthToken(host, port, username, password) {
        const isHttps = port === 443 || port === 8443;
        const httpModule = isHttps ? https : http;
        const protocol = isHttps ? 'https' : 'http';
        
        const tokenUrl = `${protocol}://${host}:${port}/oauth/token`;
        const postData = new URLSearchParams({
            grant_type: 'password',
            username: username,
            password: password,
            client_id: 'ioBroker',
            stayloggedin: 'false'
        }).toString();

        this.log.debug(`Requesting OAuth token from ${tokenUrl}`);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: host,
                port: port,
                path: '/oauth/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'Node-RED-ioBroker/1.0.0',
                    'Accept': 'application/json'
                },
                timeout: 10000
            };

            if (isHttps) {
                options.rejectUnauthorized = false; // Self-signed certificates
            }

            const req = httpModule.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const tokenData = JSON.parse(data);
                            this.log.debug('OAuth token received successfully');
                            resolve(tokenData.access_token);
                        } catch (err) {
                            reject(new Error(`Invalid token response: ${err.message}`));
                        }
                    } else {
                        reject(new Error(`OAuth failed: ${res.statusCode} - ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`OAuth request failed: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('OAuth request timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * WebSocket URL konstruieren
     */
    constructWebSocketUrl(url) {
        url = url.split('#')[0];
        let wsUrl = url.replace(/^http/, 'ws').split('?')[0];
        wsUrl += `?sid=${this.sessionID}`;
        
        if (this.options?.name) {
            wsUrl += `&name=${encodeURIComponent(this.options.name)}`;
        }
        
        // OAuth Token als Parameter hinzufügen
        if (this.accessToken) {
            wsUrl += `&token=${this.accessToken}`;
        }
        
        return wsUrl;
    }

    /**
     * Authentifizierte Headers erstellen
     */
    createAuthHeaders() {
        const urlObj = new URL(this.url.replace(/^ws/, 'http'));
        
        const headers = {
            'Host': `${urlObj.hostname}:${urlObj.port}`,
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13',
            'Origin': `http://${urlObj.hostname}:${urlObj.port}`,
            'User-Agent': 'Node-RED-ioBroker/1.0.0'
        };

        // Authorization Header mit Bearer Token
        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        // Cookie mit Token für Session
        if (this.accessToken) {
            headers['Cookie'] = `access_token=${this.accessToken}; io=${this.sessionID}`;
        }

        return headers;
    }

    /**
     * Verbindung mit OAuth2-Authentifizierung
     */
    async connect(url, options) {
        this.log.debug('Starting OAuth2 authentication process');

        this.id = 0;
        this.connectTimer && clearInterval(this.connectTimer);
        this.connectTimer = null;

        this.url = this.url || url;
        this.options = this.options || JSON.parse(JSON.stringify(options || {}));
        
        if (!this.options) {
            throw new Error('No options provided!');
        }

        // Set default options
        this.options.pongTimeout = parseInt(this.options.pongTimeout, 10) || 60000;
        this.options.pingInterval = parseInt(this.options.pingInterval, 10) || 5000;
        this.options.connectTimeout = parseInt(this.options.connectTimeout, 10) || 15000;
        this.options.connectInterval = parseInt(this.options.connectInterval, 10) || 1000;
        this.options.connectMaxAttempt = parseInt(this.options.connectMaxAttempt, 10) || 5;

        const urlObj = new URL(this.url.replace(/^ws/, 'http'));
        this.options.host = this.options.host || urlObj.hostname;
        this.options.port = this.options.port || urlObj.port;

        this.sessionID = Date.now();

        try {
            // 1. OAuth2 Token abrufen wenn Credentials vorhanden
            if (this.options.username && this.options.password) {
                this.log.debug('Getting OAuth2 token...');
                this.accessToken = await this.getOAuthToken(
                    this.options.host,
                    this.options.port,
                    this.options.username,
                    this.options.password
                );
                this.log.debug('OAuth2 token obtained successfully');
            }

            // 2. WebSocket-Verbindung mit Token
            const wsUrl = this.constructWebSocketUrl(this.url);
            const headers = this.createAuthHeaders();
            
            this.log.debug(`Connecting to: ${wsUrl}`);
            
            const wsOptions = {
                headers: headers,
                handshakeTimeout: this.options.connectTimeout,
                perMessageDeflate: false,
                followRedirects: true,
                protocolVersion: 13,
                mask: true
            };
            
            this.socket = new WebSocketClass(wsUrl, wsOptions);
            this.setupWebSocketHandlers();

        } catch (error) {
            this.log.error(`OAuth2 authentication failed: ${error.message}`);
            this.handlers.error?.forEach(cb => cb.call(this, error));
            this.close();
            throw error;
        }

        return this;
    }

    /**
     * WebSocket Event-Handler einrichten
     */
    setupWebSocketHandlers() {
        this.connectingTimer = setTimeout(() => {
            this.connectingTimer = null;
            this.log.warn('No READY flag received in timeout period');
            this.close();
        }, this.options.connectTimeout);

        this.socket.onopen = () => {
            this.log.debug('WebSocket connection opened with OAuth2');
            this.lastPong = Date.now();
            this.connectionCount = 0;
            this.authenticated = true; // Mit OAuth2 Token sind wir bereits authentifiziert

            this.pingInterval = setInterval(() => {
                if (Date.now() - this.lastPong > (this.options?.pingInterval || 5000) - 10) {
                    try {
                        this.socket?.send(JSON.stringify([MESSAGE_TYPES.PING]));
                    } catch (e) {
                        this.log.warn(`Cannot send ping: ${e}`);
                        this.close();
                        return;
                    }
                }
                if (Date.now() - this.lastPong > (this.options?.pongTimeout || 60000)) {
                    this.log.warn('Pong timeout - closing connection');
                    this.close();
                }
            }, this.options?.pingInterval || 5000);
        };

        this.socket.onclose = (event) => {
            this.log.debug(`WebSocket closed: ${event.code} - ${event.reason}`);
            this.close();
        };

        this.socket.onerror = (error) => {
            this.log.error(`WebSocket error: ${error.message || 'Unknown'}`);
            this.errorHandlers.forEach(cb => cb.call(this, error.message || 'Unknown'));
            this.close();
        };

        this.socket.onmessage = (message) => {
            this.handleMessage(message);
        };
    }

    /**
     * WebSocket-Nachrichten verarbeiten
     */
    handleMessage(message) {
        this.lastPong = Date.now();
        const messageData = message.data || message;
        
        if (!messageData || typeof messageData !== 'string') {
            console.error(`Invalid message: ${JSON.stringify(message)}`);
            return;
        }

        let data;
        try {
            data = JSON.parse(messageData);
        } catch {
            console.error(`Invalid JSON: ${messageData}`);
            return;
        }

        const type = data[0];
        const id = data[1];
        const name = data[2];
        const args = data[3];

        if (type === MESSAGE_TYPES.CALLBACK) {
            this.findAnswer(id, args);
        } else if (type === MESSAGE_TYPES.MESSAGE) {
            if (name === '___ready___') {
                this.log.debug('Ready signal received');
                this._handleConnection();
            } else if (name === 'reauthenticate') {
                this.log.warn('Server requests reauthentication');
                this.authenticated = false;
                this._reconnect();
            } else {
                this.log.debug(`Received: ${name}`);
                if (args) {
                    this.handlers[name]?.forEach(cb => cb.apply(this, args));
                } else {
                    this.handlers[name]?.forEach(cb => cb.call(this));
                }
            }
        } else if (type === MESSAGE_TYPES.PING) {
            this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
        }
    }

    /**
     * Verbindung erfolgreich hergestellt
     */
    _handleConnection() {
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
    }

    /**
     * Nachricht senden
     */
    emit(name, ...args) {
        if (!this.socket || !this.connected) {
            if (!this.wasConnected) {
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
            console.error(`Cannot send: ${e}`);
            this.close();
        }
    }

    /**
     * Callback-basierte Nachricht
     */
    withCallback(name, id, args, cb) {
        this.callbacks.push({ id, cb, ts: Date.now() + 30000 });
        this.socket?.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
    }

    /**
     * Callback-Antwort finden
     */
    findAnswer(id, args) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                callback.cb.call(null, ...args);
                this.callbacks[i] = null;
                break;
            }
        }
    }

    /**
     * Event-Listener
     */
    on(name, cb) {
        if (!cb) return;
        
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

    /**
     * Event-Listener entfernen
     */
    off(name, cb) {
        if (name === 'connect') {
            const pos = this.connectHandlers.indexOf(cb);
            if (pos !== -1) this.connectHandlers.splice(pos, 1);
        } else if (name === 'disconnect') {
            const pos = this.disconnectHandlers.indexOf(cb);
            if (pos !== -1) this.disconnectHandlers.splice(pos, 1);
        } else if (name === 'reconnect') {
            const pos = this.reconnectHandlers.indexOf(cb);
            if (pos !== -1) this.reconnectHandlers.splice(pos, 1);
        } else if (name === 'error') {
            const pos = this.errorHandlers.indexOf(cb);
            if (pos !== -1) this.errorHandlers.splice(pos, 1);
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

    /**
     * Verbindung schließen
     */
    close() {
        this.pingInterval && clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.connectingTimer && clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
        
        if (this.socket) {
            try {
                this.socket.close();
            } catch {}
            this.socket = null;
        }
        
        if (this.connected) {
            this.disconnectHandlers.forEach(cb => cb.call(this));
            this.connected = false;
        }
        
        this.authenticated = false;
        this.accessToken = null;
        this.callbacks = [];
        this._reconnect();
        return this;
    }

    /**
     * Komplett zerstören
     */
    destroy() {
        this.close();
        this.connectTimer && clearTimeout(this.connectTimer);
        this.connectTimer = null;
    }

    /**
     * Wiederverbindung
     */
    _reconnect() {
        this.sessionID = Date.now();
        this.authenticated = false;
        this.accessToken = null;
        
        if (!this.connectTimer) {
            this.log.debug(`Reconnecting (attempt ${this.connectionCount})`);
            this.connectTimer = setTimeout(() => {
                if (!this.options) return;
                
                this.connectTimer = null;
                if (this.connectionCount < (this.options?.connectMaxAttempt || 5)) {
                    this.connectionCount++;
                }
                this.connect(this.url, this.options).catch(() => {});
            }, this.connectionCount * (this.options?.connectInterval || 1000));
        }
    }
}

function connect(url, options) {
    const socketClient = new AuthenticatedSocketClient();
    socketClient.connect(url, options);
    return socketClient;
}

module.exports = {
    connect,
    SocketClient: AuthenticatedSocketClient
};