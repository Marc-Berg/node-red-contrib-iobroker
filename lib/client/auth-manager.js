/*!
 * Authentication Manager for ioBroker WebSocket Client
 * Handles OAuth2 tokens, SSL, and authentication lifecycle
 */

const https = require('https');
const http = require('http');
const { Logger } = require('../utils/logger');

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
        this.log.info(`authenticate called - useAuthentication: ${this.client.useAuthentication}`);

        if (!this.client.useAuthentication) {
            this.log.debug(`Authentication disabled, skipping`);
            return;
        }

        if (!options.password) {
            throw new Error('Password required when username is provided');
        }

        try {
            this.log.info(`Starting OAuth authentication for user: ${options.username}`);

            this.accessToken = await this.getOAuthToken(
                options.host,
                options.port,
                options.username,
                options.password
            );

            this.tokenCreatedAt = Date.now();
            this.log.info(`Authentication successful, token created at: ${new Date(this.tokenCreatedAt).toISOString()}`);

            this.scheduleTokenRefresh();

        } catch (authError) {
            this.log.error(`Authentication failed: ${authError.message}`);
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
                                this.log.info(`OAuth authentication successful for user: ${cleanUsername}`);
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
        this.log.debug(`scheduleTokenRefresh called - destroyed: ${this.client.destroyed}, useAuth: ${this.client.useAuthentication}`);

        if (this.client.destroyed || !this.client.useAuthentication) {
            this.log.debug(`Skipping token refresh scheduling - destroyed: ${this.client.destroyed}, useAuth: ${this.client.useAuthentication}`);
            return;
        }

        if (this.tokenRefreshTimer) {
            this.log.debug(`Clearing existing token refresh timer`);
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }

        this.log.info(`Setting token refresh timer for ${TOKEN_REFRESH_INTERVAL / 60000} minutes`);

        this.tokenRefreshTimer = setTimeout(async () => {
            this.log.info(`Token refresh timer fired - checking conditions...`);
            this.log.debug(`Conditions: destroyed=${this.client.destroyed}, useAuth=${this.client.useAuthentication}, connected=${this.client.connected}`);

            if (!this.client.destroyed && this.client.useAuthentication && this.client.connected) {
                this.log.info(`Starting scheduled token refresh`);
                try {
                    await this.refreshTokenProactively();
                } catch (error) {
                    this.log.error(`Scheduled token refresh failed: ${error.message}`);
                    this.client.emitError(`Token refresh failed: ${error.message}`);
                }
            } else {
                this.log.warn(`Token refresh skipped due to conditions - destroyed: ${this.client.destroyed}, useAuth: ${this.client.useAuthentication}, connected: ${this.client.connected}`);
            }
        }, TOKEN_REFRESH_INTERVAL);

        this.log.info(`Token refresh scheduled in ${TOKEN_REFRESH_INTERVAL / 60000} minutes (timer ID: ${this.tokenRefreshTimer})`);
    }

    async refreshTokenProactively() {
        this.log.info(`refreshTokenProactively called`);

        if (this.client.destroyed || !this.client.useAuthentication || !this.client.options) {
            this.log.warn(`Refresh conditions not met - destroyed: ${this.client.destroyed}, useAuth: ${this.client.useAuthentication}, hasOptions: ${!!this.client.options}`);
            return;
        }

        if (this.isRefreshingToken && this.refreshPromise) {
            this.log.debug(`Token refresh already in progress, waiting for existing promise`);
            return this.refreshPromise;
        }

        this.log.info(`Starting token refresh process`);
        this.isRefreshingToken = true;
        this.refreshPromise = this.performGracefulRenewal();

        try {
            await this.refreshPromise;
            this.log.info(`Token refresh completed successfully`);
        } catch (error) {
            this.log.error(`Token refresh failed: ${error.message}`);
            throw error;
        } finally {
            this.isRefreshingToken = false;
            this.refreshPromise = null;
            this.log.debug(`Token refresh process cleanup completed`);
        }
    }

    async performGracefulRenewal() {
        try {
            this.log.info('Starting graceful connection renewal with event-based overlap (subscribe-first, wait-for-completion)');

            const oldToken = this.accessToken;
            const oldSocket = this.client.socket;
            const oldSessionId = this.client.sessionID;

            const newToken = await this.getOAuthToken(
                this.client.options.host,
                this.client.options.port,
                this.client.options.username,
                this.client.options.password
            );

            this.accessToken = newToken;
            this.client.sessionID = Date.now();
            this.tokenCreatedAt = Date.now();

            this.log.info(`New token acquired, building parallel connection (${oldSessionId} -> ${this.client.sessionID})`);

            const newSocket = await this.buildNewConnection();

            this.log.info('New connection established, setting up subscriptions BEFORE closing old connection');

            const originalSocket = this.client.socket;
            this.client.socket = newSocket;
            this.client.setupWebSocketHandlers();
            this.client.connected = true;

            const subscriptionCount = await this.triggerResubscriptionAndWait();

            this.log.info(`All ${subscriptionCount} subscriptions completed on new connection, now safe to close old connection`);

            if (oldSocket) {
                try {
                    oldSocket.onopen = null;
                    oldSocket.onclose = null;
                    oldSocket.onerror = null;
                    oldSocket.onmessage = null;
                    oldSocket.close();
                    this.log.debug(`Old connection closed immediately after subscription completion`);
                } catch (closeError) {
                    this.log.debug(`Old connection cleanup: ${closeError.message}`);
                }
            }

            this.log.info(`Graceful renewal with event-based overlap completed successfully (${oldSessionId} -> ${this.client.sessionID})`);

            this.scheduleTokenRefresh();
            this.emitTokenRefresh(oldToken, newToken);

        } catch (error) {
            this.log.error(`Graceful renewal with event-based overlap failed: ${error.message}`);

            if (this.client.connected) {
                this.client.emitError(`Token refresh failed: ${error.message}`);
                this.client.close();
            }

            throw error;
        }
    }

    async triggerResubscriptionAndWait() {
        try {
            this.log.debug('Triggering resubscription and waiting for all subscriptions to complete');

            let subscriptionCount = 0;

            if (this.client.socket && this.client.connected) {
                if (this.client.stateHandler && this.client.stateHandler.subscriptions) {
                    subscriptionCount = this.client.stateHandler.subscriptions.size;
                    this.log.debug(`StateHandler reports ${subscriptionCount} subscriptions`);
                }

                if (this.client.handlers && this.client.handlers['stateChange']) {
                    const handlerCount = this.client.handlers['stateChange'].length;
                    this.log.debug(`Found ${handlerCount} stateChange handlers`);
                    subscriptionCount = Math.max(subscriptionCount, handlerCount);
                }

                this.log.debug(`Using subscription count: ${subscriptionCount}`);
                const waitForReady = new Promise((resolve) => {
                    let checkCount = 0;
                    const maxChecks = 40;

                    const checkReady = () => {
                        checkCount++;

                        if (this.client.isClientReady && this.client.isClientReady()) {
                            this.log.debug(`Client confirmed ready after ${checkCount * 25}ms`);
                            resolve(subscriptionCount);
                        } else if (checkCount >= maxChecks) {
                            this.log.debug(`Client readiness check completed after ${checkCount * 25}ms (max reached)`);
                            resolve(subscriptionCount);
                        } else {
                            setTimeout(checkReady, 25);
                        }
                    };
                    checkReady();
                });

                if (!this.client._authManagerResubscribing) {
                    this.client._authManagerResubscribing = true;
                    this.log.debug('Triggering _handleConnection for resubscription');
                    this.client._handleConnection();
                    setTimeout(() => {
                        delete this.client._authManagerResubscribing;
                    }, 1000);
                } else {
                    this.log.debug('Skipping _handleConnection - resubscription already in progress');
                }

                await waitForReady;

                this.log.debug(`Resubscription wait completed for ${subscriptionCount} subscriptions`);
            }

            return subscriptionCount;

        } catch (error) {
            this.log.error(`Resubscription and wait failed: ${error.message}`);
            throw error;
        }
    }

    async buildNewConnection() {
        if (this.client.destroyed || !this.client.socket) {
            throw new Error('Client destroyed or no socket available');
        }

        try {
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

            this.log.debug(`Building new WebSocket connection with fresh token`);

            const WebSocketClass = require('ws');
            const newSocket = new WebSocketClass(wsUrl, wsOptions);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('New connection timeout'));
                }, this.client.options.connectTimeout);

                const cleanup = () => {
                    clearTimeout(timeout);
                    newSocket.removeListener('open', onOpen);
                    newSocket.removeListener('error', onError);
                    newSocket.removeListener('close', onClose);
                };

                const onOpen = () => {
                    if (this.client.destroyed) {
                        cleanup();
                        newSocket.close();
                        reject(new Error('Client destroyed during new connection'));
                        return;
                    }
                    cleanup();
                    this.log.debug('New WebSocket connection opened successfully');
                    resolve(newSocket);
                };

                const onError = (error) => {
                    cleanup();
                    reject(error);
                };

                const onClose = (event) => {
                    cleanup();
                    reject(new Error(`New connection closed during handshake: ${event.code} - ${event.reason}`));
                };

                newSocket.once('open', onOpen);
                newSocket.once('error', onError);
                newSocket.once('close', onClose);
            });

        } catch (error) {
            this.log.error(`Failed to build new connection: ${error.message}`);
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
            this.log.info('Reauthenticate request received - triggering graceful renewal');
            this.refreshTokenProactively().catch(error => {
                this.log.error(`Reauthenticate graceful renewal failed: ${error.message}`);
                this.client.close();
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
            isRefreshingToken: this.isRefreshingToken,
            renewalType: 'graceful_parallel_event_based',
            overlapStrategy: 'wait_for_subscription_completion',
            hasTimer: !!this.tokenRefreshTimer,
            timerInterval: TOKEN_REFRESH_INTERVAL,
            useAuthentication: this.client?.useAuthentication,
            clientDestroyed: this.client?.destroyed,
            clientConnected: this.client?.connected
        };

        if (this.tokenCreatedAt) {
            stats.tokenAge = this.getTokenAge();
            stats.tokenExpiry = this.tokenCreatedAt + TOKEN_EXPIRY_TIME;
            stats.timeUntilRefresh = this.getTimeUntilRefresh();
            stats.tokenCreatedAt = new Date(this.tokenCreatedAt).toISOString();
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
        this.log.debug(`Destroying AuthManager for client ${this.client?.clientId} (graceful renewal version)`);

        this.destroyed = true;

        this.cleanup();
        this.clearAllTimers();
        this.clearAllCollections();
        this.nullifyReferences();

        this.log.debug(`AuthManager destroyed completely`);
    }

    clearAllTimers() {
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
    }

    clearAllCollections() {
        this.isRefreshingToken = false;
    }

    nullifyReferences() {
        this.client = null;
        this.accessToken = null;
        this.tokenCreatedAt = null;
        this.refreshPromise = null;
    }
}

module.exports = AuthManager;