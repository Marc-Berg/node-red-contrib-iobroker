/*!
 * Authentication Manager for ioBroker WebSocket Client
 * Handles OAuth2 tokens, SSL, and authentication lifecycle
 */

const https = require('https');
const http = require('http');
const { Logger } = require('../utils');

const TOKEN_REFRESH_INTERVAL = 55 * 60 * 1000;
const TOKEN_EXPIRY_TIME = 60 * 60 * 1000;

class AuthManager {
    constructor(client) {
        this.client = client;
        this.accessToken = null;
        this.tokenCreatedAt = null;
        this.tokenRefreshTimer = null;
        this.isRefreshingToken = false;
        this.refreshPromise = null;
        this.log = new Logger(`AuthManager:${client.clientId}`);
    }

    async authenticate(options) {
        if (!this.client.useAuthentication) {
            return;
        }

        if (!options.password) {
            throw new Error('Password required when username is provided');
        }
        
        try {
            this.accessToken = await this.getOAuthToken(
                options.host,
                options.port,
                options.username,
                options.password
            );
            
            this.tokenCreatedAt = Date.now();
            this.scheduleTokenRefresh();
            
        } catch (authError) {
            throw authError;
        }
    }

    async getOAuthToken(host, port, username, password) {
        if (this.client.destroyed) {
            throw new Error('Client has been destroyed');
        }
        
        const httpModule = this.client.useSSL ? https : http;
        
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

        this.log.debug(`Getting OAuth token for user: ${cleanUsername} via ${this.client.useSSL ? 'HTTPS' : 'HTTP'}`);

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

            if (this.client.useSSL) {
                options.rejectUnauthorized = false;
                options.secureProtocol = 'TLSv1_2_method';
            }

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
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
                if (!this.client.destroyed) {
                    reject(err);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (!this.client.destroyed) {
                    reject(new Error('Authentication timeout'));
                }
            });

            req.write(postData);
            req.end();
        });
    }

    scheduleTokenRefresh() {
        if (this.client.destroyed || !this.client.useAuthentication) {
            return;
        }

        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }

        this.tokenRefreshTimer = setTimeout(async () => {
            if (!this.client.destroyed && this.client.useAuthentication && this.client.connected) {
                try {
                    await this.refreshTokenProactively();
                } catch (error) {
                    this.log.error(`Scheduled token refresh failed: ${error.message}`);
                }
            }
        }, TOKEN_REFRESH_INTERVAL);

        this.log.debug(`Token refresh scheduled in ${TOKEN_REFRESH_INTERVAL / 60000} minutes`);
    }

    async refreshTokenProactively() {
        if (this.client.destroyed || !this.client.useAuthentication || !this.client.options) {
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
                this.client.options.host,
                this.client.options.port,
                this.client.options.username,
                this.client.options.password
            );

            const oldToken = this.accessToken;
            const oldSessionId = this.client.sessionID;
            
            this.accessToken = newToken;
            this.client.sessionID = Date.now();
            this.tokenCreatedAt = Date.now();

            this.log.debug(`Token and session refreshed (${oldSessionId} -> ${this.client.sessionID})`);

            if (this.client.connected && this.client.socket) {
                await this.rebuildConnection();
            }

            this.scheduleTokenRefresh();
            this.emitTokenRefresh(oldToken, newToken);

        } catch (error) {
            this.log.error(`Token refresh failed: ${error.message}`);
            
            if (this.client.connected) {
                this.client.emitError(`Token refresh failed: ${error.message}`);
                this.client.close();
            }
            
            throw error;
        }
    }

    async rebuildConnection() {
        if (this.client.destroyed || !this.client.socket || !this.client.connected) {
            return;
        }

        try {
            this.log.debug('Rebuilding WebSocket connection with new session and token');
            
            this.client.connected = false;
            
            if (this.client.socket) {
                try {
                    this.client.socket.onopen = null;
                    this.client.socket.onclose = null;
                    this.client.socket.onerror = null;
                    this.client.socket.onmessage = null;
                    this.client.socket.close();
                } catch (closeError) {}
                this.client.socket = null;
            }

            if (this.client.pingInterval) {
                clearInterval(this.client.pingInterval);
                this.client.pingInterval = null;
            }

            const wsUrl = this.client.constructWebSocketUrl(this.client.url);
            const headers = this.client.createHeaders();
            
            const wsOptions = {
                headers: headers,
                handshakeTimeout: this.client.options.connectTimeout,
                perMessageDeflate: false,
                followRedirects: true,
                protocolVersion: 13,
                mask: true
            };

            if (this.client.useSSL) {
                wsOptions.rejectUnauthorized = false;
                wsOptions.ca = undefined;
            }
            
            const WebSocketClass = require('ws');
            this.client.socket = new WebSocketClass(wsUrl, wsOptions);
            this.client.setupWebSocketHandlers();

            await this.client.waitForConnection();
            
            this.log.debug('WebSocket connection rebuilt successfully');
            
        } catch (error) {
            this.log.error(`Failed to rebuild connection: ${error.message}`);
            this.client.close();
            throw error;
        }
    }

    emitTokenRefresh(oldToken, newToken) {
        if (this.client.handlers['tokenRefresh']) {
            this.client.handlers['tokenRefresh'].forEach(cb => {
                try {
                    cb.call(this.client, newToken, oldToken);
                } catch (callbackError) {
                    this.log.error('Error in token refresh callback:', callbackError);
                }
            });
        }
    }

    handleReauthenticate() {
        if (this.client.useAuthentication && !this.client.destroyed) {
            this.client.authenticated = false;
            this.log.debug('Reauthenticate request received - triggering session renewal');
            this.refreshTokenProactively().catch(error => {
                this.log.error(`Reauthenticate session renewal failed: ${error.message}`);
                this.client._reconnect();
            });
        }
    }

    getAccessToken() {
        return this.accessToken;
    }

    getTokenAge() {
        if (!this.tokenCreatedAt) {
            return null;
        }
        return Date.now() - this.tokenCreatedAt;
    }

    getTimeUntilRefresh() {
        if (!this.tokenCreatedAt) {
            return null;
        }
        const age = this.getTokenAge();
        return Math.max(0, TOKEN_REFRESH_INTERVAL - age);
    }

    getStats() {
        const stats = {
            isRefreshingToken: this.isRefreshingToken
        };

        if (this.tokenCreatedAt) {
            stats.tokenAge = this.getTokenAge();
            stats.tokenExpiry = this.tokenCreatedAt + TOKEN_EXPIRY_TIME;
            stats.timeUntilRefresh = this.getTimeUntilRefresh();
        }

        return stats;
    }

    reset() {
        this.accessToken = null;
        this.tokenCreatedAt = null;
        this.isRefreshingToken = false;
        this.refreshPromise = null;
        this.cleanup();
    }

    cleanup() {
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
    }

    destroy() {
        this.cleanup();
        this.reset();
    }
}

module.exports = AuthManager;