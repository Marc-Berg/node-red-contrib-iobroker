/*!
 * ioBroker WebSocket Client with Proactive Token Refresh
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

const TOKEN_REFRESH_INTERVAL = 55 * 60 * 1000; // 55 minutes in milliseconds
const TOKEN_EXPIRY_TIME = 60 * 60 * 1000; // 60 minutes in milliseconds

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
        this.destroyed = false;
        this.lastError = null;
        this.clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

        // Token refresh management
        this.tokenCreatedAt = null;
        this.tokenRefreshTimer = null;
        this.isRefreshingToken = false;
        this.refreshPromise = null;

        this.log = {
            debug: (text) => {
                if (text.includes('destroyed') || text.includes('OAuth') || text.includes('token')) {
                    const now = new Date();
                    const day = now.getDate().toString().padStart(2, '0');
                    const month = now.toLocaleDateString('en', { month: 'short' });
                    const time = now.toTimeString().slice(0, 8);
                    console.log(`${day} ${month} ${time} - [debug] [WebSocketClient:${this.clientId}] ${text}`);
                }
            },
            warn: (text) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.warn(`${day} ${month} ${time} - [warn] [WebSocketClient:${this.clientId}] ${text}`);
            },
            error: (text) => {
                const now = new Date();
                const day = now.getDate().toString().padStart(2, '0');
                const month = now.toLocaleDateString('en', { month: 'short' });
                const time = now.toTimeString().slice(0, 8);
                console.error(`${day} ${month} ${time} - [error] [WebSocketClient:${this.clientId}] ${text}`);
            },
        };

        this.emit = this.emit.bind(this);
        this.disconnect = this.close.bind(this);
    }

    async getOAuthToken(host, port, username, password) {
        if (this.destroyed) {
            throw new Error('Client has been destroyed');
        }
        
        const isHttps = port === 443 || port === 8443;
        const httpModule = isHttps ? https : http;
        const protocol = isHttps ? 'https' : 'http';
        
        if (!username || typeof username !== 'string' || !username.trim()) {
            throw new Error('Username is required');
        }
        if (!password || typeof password !== 'string') {
            throw new Error('Password is required');
        }
        
        const cleanUsername = username.trim();
        
        const postData = new URLSearchParams({
            grant_type: 'password',
            username: cleanUsername,
            password: password,
            client_id: 'ioBroker',
            stayloggedin: 'false'
        }).toString();

        this.log.debug(`Getting OAuth token for user: ${cleanUsername}`);

        return new Promise((resolve, reject) => {
            if (this.destroyed) {
                reject(new Error('Client destroyed during OAuth request'));
                return;
            }
            
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
                if (this.destroyed) {
                    req.destroy();
                    reject(new Error('Client destroyed during OAuth response'));
                    return;
                }
                
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (this.destroyed) {
                        reject(new Error('Client destroyed during OAuth processing'));
                        return;
                    }
                    
                    try {
                        if (res.statusCode === 200) {
                            const tokenData = JSON.parse(data);
                            if (tokenData.access_token) {
                                this.log.debug('OAuth token received successfully');
                                resolve(tokenData.access_token);
                            } else {
                                reject(new Error('Invalid token response: missing access_token'));
                            }
                        } else {
                            let errorMessage = `Authentication failed (${res.statusCode})`;
                            
                            try {
                                const errorData = JSON.parse(data);
                                if (errorData.message) {
                                    errorMessage += `: ${errorData.message}`;
                                }
                            } catch (parseError) {
                                errorMessage += `: ${data}`;
                            }
                            
                            reject(new Error(errorMessage));
                        }
                    } catch (parseError) {
                        reject(new Error(`Invalid response format: ${parseError.message}`));
                    }
                });
            });

            req.on('error', (err) => {
                if (!this.destroyed) {
                    reject(new Error(`Connection failed: ${err.message}`));
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (!this.destroyed) {
                    reject(new Error('Authentication timeout'));
                }
            });

            req.write(postData);
            req.end();
        });
    }

    async refreshTokenProactively() {
        if (this.destroyed || !this.useAuthentication || !this.options) {
            return;
        }

        if (this.isRefreshingToken && this.refreshPromise) {
            return this.refreshPromise;
        }

        this.isRefreshingToken = true;
        this.refreshPromise = this.performTokenRefresh();

        try {
            await this.refreshPromise;
        } catch (error) {
            this.log.error(`Token refresh failed: ${error.message}`);
            throw error;
        } finally {
            this.isRefreshingToken = false;
            this.refreshPromise = null;
        }
    }

    async performTokenRefresh() {
        try {
            this.log.debug('Starting proactive token refresh with session renewal');
            
            const newToken = await this.getOAuthToken(
                this.options.host,
                this.options.port,
                this.options.username,
                this.options.password
            );

            const oldToken = this.accessToken;
            const oldSessionId = this.sessionID;
            
            // Update token and generate new session ID
            this.accessToken = newToken;
            this.sessionID = Date.now();
            this.tokenCreatedAt = Date.now();

            this.log.debug(`Token and session refreshed successfully (${oldSessionId} -> ${this.sessionID})`);

            // For seamless token refresh, we need to rebuild the WebSocket connection
            // with the new token and session ID
            if (this.connected && this.socket) {
                await this.rebuildConnection();
            }

            // Schedule the next refresh
            this.scheduleTokenRefresh();

            // Emit token refresh event for manager notification
            this.emitTokenRefresh(oldToken, newToken);

        } catch (error) {
            this.log.error(`Token refresh failed: ${error.message}`);
            
            // If token refresh fails, we need to handle reconnection
            if (this.connected) {
                this.emitError(`Token refresh failed: ${error.message}`);
                this.close();
            }
            
            throw error;
        }
    }

    async rebuildConnection() {
        if (this.destroyed || !this.socket || !this.connected) {
            return;
        }

        try {
            this.log.debug('Rebuilding WebSocket connection with new session and token');
            
            // Store current connection state
            const wasConnected = this.connected;
            
            // Close current socket without triggering reconnection logic
            this.connected = false;
            
            if (this.socket) {
                try {
                    this.socket.onopen = null;
                    this.socket.onclose = null;
                    this.socket.onerror = null;
                    this.socket.onmessage = null;
                    this.socket.close();
                } catch (closeError) {
                    // Ignore close errors
                }
                this.socket = null;
            }

            // Clear ping interval during rebuild
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }

            // Create new WebSocket connection with updated credentials
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
            
            this.socket = new WebSocketClass(wsUrl, wsOptions);
            this.setupWebSocketHandlers();

            // Wait for the new connection to establish
            await this.waitForConnection();
            
            this.log.debug('WebSocket connection rebuilt successfully');
            
        } catch (error) {
            this.log.error(`Failed to rebuild connection: ${error.message}`);
            // If rebuild fails, fall back to normal reconnection
            this.close();
            throw error;
        }
    }

    scheduleTokenRefresh() {
        if (this.destroyed || !this.useAuthentication) {
            return;
        }

        // Clear existing timer
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }

        // Schedule refresh for 55 minutes from now
        this.tokenRefreshTimer = setTimeout(async () => {
            if (!this.destroyed && this.useAuthentication && this.connected) {
                try {
                    await this.refreshTokenProactively();
                } catch (error) {
                    this.log.error(`Scheduled token refresh failed: ${error.message}`);
                }
            }
        }, TOKEN_REFRESH_INTERVAL);

        this.log.debug(`Token refresh scheduled in ${TOKEN_REFRESH_INTERVAL / 60000} minutes`);
    }

    emitTokenRefresh(oldToken, newToken) {
        // Emit to handlers that might need to know about token refresh
        if (this.handlers['tokenRefresh']) {
            this.handlers['tokenRefresh'].forEach(cb => {
                try {
                    cb.call(this, newToken, oldToken);
                } catch (callbackError) {
                    this.log.error('Error in token refresh callback:', callbackError);
                }
            });
        }
    }

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
        
        this.log.debug(`WebSocket URL constructed with session ${this.sessionID}`);
        return wsUrl;
    }

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

        if (this.useAuthentication && this.accessToken && this.accessToken.trim()) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
            headers['Cookie'] = `access_token=${this.accessToken}; io=${this.sessionID}`;
        } else {
            headers['Cookie'] = `io=${this.sessionID}`;
        }

        return headers;
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
            
            this.id = 0;
            this.connectTimer && clearInterval(this.connectTimer);
            this.connectTimer = null;

            this.url = this.url || url;
            this.options = this.options || JSON.parse(JSON.stringify(options || {}));
            
            if (!this.options) {
                throw new Error('No options provided');
            }

            this.useAuthentication = !!(this.options.username && this.options.username.trim());

            this.options.pongTimeout = parseInt(this.options.pongTimeout, 10) || 60000;
            this.options.pingInterval = parseInt(this.options.pingInterval, 10) || 5000;
            this.options.connectTimeout = parseInt(this.options.connectTimeout, 10) || 15000;
            this.options.connectInterval = parseInt(this.options.connectInterval, 10) || 1000;
            this.options.connectMaxAttempt = parseInt(this.options.connectMaxAttempt, 10) || 1;

            const urlObj = new URL(this.url.replace(/^ws/, 'http'));
            this.options.host = this.options.host || urlObj.hostname;
            this.options.port = this.options.port || urlObj.port;

            this.sessionID = Date.now();

            if (this.useAuthentication) {
                if (!this.options.password) {
                    throw new Error('Password required when username is provided');
                }
                
                try {
                    this.accessToken = await this.getOAuthToken(
                        this.options.host,
                        this.options.port,
                        this.options.username,
                        this.options.password
                    );
                    
                    // Mark token creation time and schedule refresh
                    this.tokenCreatedAt = Date.now();
                    this.scheduleTokenRefresh();
                    
                } catch (authError) {
                    const errorMessage = authError.message || authError.toString();
                    throw new Error(`Authentication failed (400): ${errorMessage}`);
                }
            }

            if (this.socket) {
                try {
                    this.socket.close();
                } catch (e) {
                    // Ignore close errors
                }
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
            
            this.connectingTimer = null;
            this.emitError('Connection timeout - no ready signal');
            this.close();
        }, this.options.connectTimeout);

        this.socket.onopen = () => {
            if (this.destroyed) {
                try {
                    this.socket.close();
                } catch (e) {}
                return;
            }
            
            this.lastPong = Date.now();
            this.connectionCount = 0;
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
            this.close();
        };

        this.socket.onerror = (error) => {
            if (this.destroyed) {
                return;
            }
            
            const errorMessage = error.message || error.toString() || 'WebSocket error';
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

        // Handle ping/pong messages
        if (data.length === 1) {
            const type = data[0];
            
            if (type === MESSAGE_TYPES.PING) {
                try {
                    this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                } catch (e) {
                    // Ignore send errors
                }
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
                    if (this.useAuthentication && !this.destroyed) {
                        this.authenticated = false;
                        this.log.debug('Reauthenticate request received - triggering session renewal');
                        this.refreshTokenProactively().catch(error => {
                            this.log.error(`Reauthenticate session renewal failed: ${error.message}`);
                            this._reconnect();
                        });
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
                            } catch (err) {
                                // Ignore handler errors
                            }
                        });
                    }
                }
            } else if (type === MESSAGE_TYPES.PING) {
                try {
                    this.socket?.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                } catch (e) {
                    // Ignore send errors
                }
            } else if (type === MESSAGE_TYPES.PONG) {
                // Pong received - lastPong already updated
            }
        } catch (error) {
            // Ignore message processing errors
        }
    }

    _handleConnection() {
        if (this.destroyed) {
            return;
        }
        
        this.connected = true;
        this.connectionCount = 0;
        
        this.log.debug(`WebSocket connection established with session ${this.sessionID}`);
        
        try {
            if (this.wasConnected) {
                this.reconnectHandlers.forEach(cb => {
                    try {
                        cb.call(this, true);
                    } catch (err) {
                        // Ignore handler errors
                    }
                });
            } else {
                this.connectHandlers.forEach(cb => {
                    try {
                        cb.call(this, true);
                    } catch (err) {
                        // Ignore handler errors
                    }
                });
                this.wasConnected = true;
            }
        } catch (error) {
            // Ignore handler errors
        }
        
        this.connectingTimer && clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
        
        if (this.pending.length) {
            const pendingCopy = [...this.pending];
            this.pending = [];
            pendingCopy.forEach(({ name, args }) => {
                try {
                    this.emit(name, ...args);
                } catch (error) {
                    // Ignore pending message errors
                }
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
        } catch (e) {
            // Ignore send errors
        }
    }

    findAnswer(id, args) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                try {
                    callback.cb.call(null, ...args);
                } catch (err) {
                    // Ignore callback errors
                }
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
        } else if (this.handlers[name]) {
            removeFromArray(this.handlers[name]);
            if (this.handlers[name].length === 0) {
                delete this.handlers[name];
            }
        }
    }

    close() {
        this.pingInterval && clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.connectingTimer && clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
        
        // Clear token refresh timer
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        
        if (this.socket) {
            try {
                this.socket.close();
            } catch (error) {
                // Ignore close errors
            }
            this.socket = null;
        }
        
        if (this.connected && !this.destroyed) {
            this.disconnectHandlers.forEach(cb => {
                try {
                    cb.call(this);
                } catch (err) {
                    // Ignore handler errors
                }
            });
        }
        
        this.connected = false;
        this.authenticated = false;
        this.callbacks = [];
        
        if (!this.destroyed) {
            this._reconnect();
        }
        
        return this;
    }

    destroy() {
        this.log.debug(`Destroying client ${this.clientId}`);
        
        this.destroyed = true;
        
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
        if (this.connectingTimer) {
            clearTimeout(this.connectingTimer);
            this.connectingTimer = null;
        }
        
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        
        if (this.socket) {
            try {
                this.socket.onopen = null;
                this.socket.onclose = null;
                this.socket.onerror = null;
                this.socket.onmessage = null;
                this.socket.close();
            } catch (error) {
                // Ignore destroy errors
            }
            this.socket = null;
        }
        
        this.connected = false;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.authenticated = false;
        this.accessToken = null;
        this.tokenCreatedAt = null;
        this.isRefreshingToken = false;
        this.refreshPromise = null;
        
        this.connectHandlers = [];
        this.reconnectHandlers = [];
        this.disconnectHandlers = [];
        this.errorHandlers = [];
        this.handlers = {};
        this.pending = [];
        this.callbacks = [];
        
        this.options = null;
        this.url = '';
        
        this.log.debug(`Client ${this.clientId} destroyed completely`);
    }

    _reconnect() {
        if (this.destroyed) {
            return;
        }
        
        if (!this.options || !this.url) {
            return;
        }
        
        // Generate new session ID for reconnection to avoid session conflicts
        this.sessionID = Date.now();
        this.authenticated = false;
        this.accessToken = null;
        this.tokenCreatedAt = null;
        
        // Clear token refresh timer during reconnection
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        
        if (!this.destroyed && this.options) {
            this.connectTimer = setTimeout(() => {
                if (this.destroyed || !this.options) {
                    this.connectTimer = null;
                    return;
                }
                
                this.connectTimer = null;
                if (this.connectionCount < (this.options?.connectMaxAttempt || 1)) {
                    this.connectionCount++;
                    this.connect(this.url, this.options).catch((error) => {
                        if (!this.destroyed) {
                            // Ignore reconnection errors
                        }
                    });
                }
            }, this.connectionCount * (this.options?.connectInterval || 1000));
        }
    }

    // Token and session management helper methods
    getTokenAge() {
        if (!this.tokenCreatedAt) {
            return null;
        }
        return Date.now() - this.tokenCreatedAt;
    }

    isTokenExpiringSoon() {
        const age = this.getTokenAge();
        if (!age) {
            return false;
        }
        return age > TOKEN_REFRESH_INTERVAL;
    }

    getTimeUntilRefresh() {
        if (!this.tokenCreatedAt) {
            return null;
        }
        const age = this.getTokenAge();
        return Math.max(0, TOKEN_REFRESH_INTERVAL - age);
    }

    getSessionInfo() {
        return {
            sessionId: this.sessionID,
            tokenAge: this.getTokenAge(),
            timeUntilRefresh: this.getTimeUntilRefresh(),
            isAuthenticated: this.authenticated,
            hasToken: !!this.accessToken,
            isRefreshing: this.isRefreshingToken
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
    TOKEN_REFRESH_INTERVAL,
    TOKEN_EXPIRY_TIME
};