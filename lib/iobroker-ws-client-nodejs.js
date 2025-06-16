/*!
 * ioBroker WebSocket Client for Node-RED
 */

const https = require('https');
const http = require('http');
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

const DEBUG = false;

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
        this.connected = false;
        this.authenticated = false;
        this.accessToken = null;
        this.useAuthentication = false;
        this.isConnecting = false;
        this.connectionPromise = null;

        this.log = {
            debug: (text) => DEBUG && console.log(`[${new Date().toISOString()}] [WebSocketClient] ${text}`),
            warn: (text) => console.warn(`[${new Date().toISOString()}] [WebSocketClient] ${text}`),
            error: (text) => console.error(`[${new Date().toISOString()}] [WebSocketClient] ${text}`),
        };

        this.emit = this.emit.bind(this);
        this.disconnect = this.close.bind(this);
    }

    /**
     * OAuth2 Token Request
     */
    async getOAuthToken(host, port, username, password) {
        const isHttps = port === 443 || port === 8443;
        const httpModule = isHttps ? https : http;
        const protocol = isHttps ? 'https' : 'http';
        
        const postData = new URLSearchParams({
            grant_type: 'password',
            username: username,
            password: password,
            client_id: 'ioBroker',
            stayloggedin: 'false'
        }).toString();

        this.log.debug(`Requesting OAuth token from ${protocol}://${host}:${port}/oauth/token`);

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
                options.rejectUnauthorized = false;
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
                    } else if (res.statusCode === 401) {
                        reject(new Error('Invalid username or password'));
                    } else if (res.statusCode === 403) {
                        reject(new Error('Access forbidden - check user permissions'));
                    } else if (res.statusCode === 404) {
                        reject(new Error('OAuth endpoint not found - check ioBroker configuration'));
                    } else {
                        reject(new Error(`Authentication failed (${res.statusCode}): ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`Connection failed: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Authentication timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Construct WebSocket URL
     */
    constructWebSocketUrl(url) {
        url = url.split('#')[0];
        let wsUrl = url.replace(/^http/, 'ws').split('?')[0];
        wsUrl += `?sid=${this.sessionID}`;
        
        if (this.options?.name) {
            wsUrl += `&name=${encodeURIComponent(this.options.name)}`;
        }
        
        if (this.useAuthentication && this.accessToken) {
            wsUrl += `&token=${this.accessToken}`;
        }
        
        return wsUrl;
    }

    /**
     * Create headers
     */
    createHeaders() {
        const urlObj = new URL(this.url.replace(/^ws/, 'http'));
        
        const headers = {
            'Host': `${urlObj.hostname}:${urlObj.port}`,
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13',
            'Origin': `http://${urlObj.hostname}:${urlObj.port}`,
            'User-Agent': 'Node-RED-ioBroker/1.0.0'
        };

        if (this.useAuthentication && this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
            headers['Cookie'] = `access_token=${this.accessToken}; io=${this.sessionID}`;
        }

        return headers;
    }

    /**
     * Error emission
     */
    emitError(error) {
        const errorMessage = typeof error === 'string' ? error : error.message;
        this.log.error(`Error: ${errorMessage}`);
        
        this.errorHandlers.forEach(cb => {
            try {
                cb.call(this, errorMessage);
            } catch (callbackError) {
                console.error('Error in error callback:', callbackError);
            }
        });
    }

    /**
     * Connect
     */
    async connect(url, options) {
        if (this.isConnecting && this.connectionPromise) {
            this.log.debug('Already connecting - returning existing promise');
            return this.connectionPromise;
        }
        
        if (this.connected && this.socket) {
            this.log.debug('Already connected - returning existing connection');
            return this;
        }

        this.log.debug('Starting connection attempt');

        this.isConnecting = true;
        this.connectionPromise = this._performConnection(url, options);
        
        try {
            const result = await this.connectionPromise;
            return result;
        } finally {
            this.isConnecting = false;
            this.connectionPromise = null;
        }
    }

    /**
     * Perform the actual connection
     */
    async _performConnection(url, options) {
        try {
            this.id = 0;
            this.connectTimer && clearInterval(this.connectTimer);
            this.connectTimer = null;

            this.url = this.url || url;
            this.options = this.options || JSON.parse(JSON.stringify(options || {}));
            
            if (!this.options) {
                throw new Error('No options provided');
            }

            this.useAuthentication = !!(this.options.username && this.options.username.trim());

            if (this.useAuthentication) {
                this.log.debug(`Using OAuth2 authentication for user: ${this.options.username}`);
                
                if (!this.options.password) {
                    throw new Error('Password required when username is provided');
                }
            } else {
                this.log.debug('Connecting without authentication (no-auth mode)');
            }

            this.options.pongTimeout = parseInt(this.options.pongTimeout, 10) || 60000;
            this.options.pingInterval = parseInt(this.options.pingInterval, 10) || 5000;
            this.options.connectTimeout = parseInt(this.options.connectTimeout, 10) || 15000;
            this.options.connectInterval = parseInt(this.options.connectInterval, 10) || 1000;
            this.options.connectMaxAttempt = parseInt(this.options.connectMaxAttempt, 10) || 5;

            const urlObj = new URL(this.url.replace(/^ws/, 'http'));
            this.options.host = this.options.host || urlObj.hostname;
            this.options.port = this.options.port || urlObj.port;

            this.sessionID = Date.now();

            if (this.useAuthentication) {
                this.log.debug('Getting OAuth2 token...');
                this.accessToken = await this.getOAuthToken(
                    this.options.host,
                    this.options.port,
                    this.options.username,
                    this.options.password
                );
                this.log.debug('OAuth2 token obtained successfully');
            }

            if (this.socket) {
                this.log.debug('Closing existing socket before creating new one');
                try {
                    this.socket.close();
                } catch (e) {
                    this.log.warn(`Error closing existing socket: ${e.message}`);
                }
                this.socket = null;
            }
            
            const wsUrl = this.constructWebSocketUrl(this.url);
            const headers = this.createHeaders();
            
            this.log.debug(`Creating WebSocket to: ${wsUrl}`);
            
            const wsOptions = {
                headers: headers,
                handshakeTimeout: this.options.connectTimeout,
                perMessageDeflate: false,
                followRedirects: true,
                protocolVersion: 13,
                mask: true
            };
            
            this.socket = new WebSocketClass(wsUrl, wsOptions);
            this.log.debug('WebSocket instance created');
            this.setupWebSocketHandlers();

        } catch (error) {
            this.emitError(error);
            this.close();
            throw error;
        }

        return this;
    }

    /**
     * Setup WebSocket handlers
     */
    setupWebSocketHandlers() {
        if (!this.socket) {
            this.log.error('No socket to setup handlers for');
            return;
        }

        this.connectingTimer = setTimeout(() => {
            this.connectingTimer = null;
            this.log.warn('No READY flag received in timeout');
            this.emitError('Connection timeout');
            this.close();
        }, this.options.connectTimeout);

        this.socket.onopen = () => {
            const authMode = this.useAuthentication ? 'with OAuth2' : 'without authentication';
            this.log.debug(`WebSocket opened ${authMode}`);
            this.lastPong = Date.now();
            this.connectionCount = 0;
            this.authenticated = this.useAuthentication;

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
                    this.log.warn('Pong timeout');
                    this.close();
                }
            }, this.options?.pingInterval || 5000);
        };

        this.socket.onclose = (event) => {
            this.log.debug(`WebSocket closed: ${event.code} - ${event.reason}`);
            this.close();
        };

        this.socket.onerror = (error) => {
            this.emitError(error.message || 'WebSocket error');
            this.close();
        };

        this.socket.onmessage = (message) => {
            this.handleMessage(message);
        };
    }

    /**
     * Handle messages
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
                if (this.useAuthentication) {
                    this.log.warn('Server requests reauthentication');
                    this.authenticated = false;
                    this._reconnect();
                } else {
                    this.log.debug('Reauthenticate request ignored (no-auth mode)');
                }
            } else {
                this.log.debug(`Received: ${name}`);
                if (args) {
                    this.handlers[name]?.forEach(cb => {
                        try {
                            cb.apply(this, args);
                        } catch (err) {
                            console.error(`Handler error for ${name}:`, err);
                        }
                    });
                } else {
                    this.handlers[name]?.forEach(cb => {
                        try {
                            cb.call(this);
                        } catch (err) {
                            console.error(`Handler error for ${name}:`, err);
                        }
                    });
                }
            }
        } else if (type === MESSAGE_TYPES.PING) {
            try {
                this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
            } catch (e) {
                this.log.warn(`Cannot send pong: ${e}`);
            }
        }
    }

    /**
     * Handle connection ready
     */
    _handleConnection() {
        this.connected = true;
        this.connectionCount = 0;
        
        if (this.wasConnected) {
            this.reconnectHandlers.forEach(cb => {
                try {
                    cb.call(this, true);
                } catch (err) {
                    console.error('Reconnect handler error:', err);
                }
            });
        } else {
            this.connectHandlers.forEach(cb => {
                try {
                    cb.call(this, true);
                } catch (err) {
                    console.error('Connect handler error:', err);
                }
            });
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
     * Send message
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
     * Send with callback
     */
    withCallback(name, id, args, cb) {
        this.callbacks.push({ id, cb, ts: Date.now() + 30000 });
        try {
            this.socket?.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
        } catch (e) {
            console.error(`Cannot send callback: ${e}`);
        }
    }

    /**
     * Find callback answer
     */
    findAnswer(id, args) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                try {
                    callback.cb.call(null, ...args);
                } catch (err) {
                    console.error('Callback execution error:', err);
                }
                this.callbacks[i] = null;
                break;
            }
        }
    }

    /**
     * Event listener
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
     * Remove event listener
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
     * Close connection
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
            this.disconnectHandlers.forEach(cb => {
                try {
                    cb.call(this);
                } catch (err) {
                    console.error('Disconnect handler error:', err);
                }
            });
            this.connected = false;
        }
        
        this.authenticated = false;
        this.accessToken = null;
        this.callbacks = [];
        this._reconnect();
        return this;
    }

    /**
     * Destroy
     */
    destroy() {
        this.close();
        this.connectTimer && clearTimeout(this.connectTimer);
        this.connectTimer = null;
        
        this.isConnecting = false;
        this.connectionPromise = null;
    }

    /**
     * Reconnect
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
    const socketClient = new SocketClient();
    socketClient.connect(url, options);
    return socketClient;
}

module.exports = {
    connect,
    SocketClient
};