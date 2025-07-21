/*!
 * OAuth2 Authentication Service for ioBroker Integration
 * Manages token lifecycle, refresh cycles, and parallel connection strategies
 */

const http = require('http');
const https = require('https');
const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

const TOKEN_REFRESH_INTERVAL = 55 * 60 * 1000;
const TOKEN_OVERLAP_TIME = 5 * 1000;

class AuthService {
    constructor() {
        this.logger = LoggingService.getLogger('AuthService');
        this.tokenTimers = new Map();
        this.activeTokens = new Map();
        this.serverConfigs = new Map();
        
        eventBus.on('connection:request', (config) => this.handleConnectionRequest(config));
        eventBus.on('auth:token_refresh_request', ({ serverId }) => this.refreshToken(serverId));
        eventBus.on('connection:disconnected', ({ serverId }) => this.clearTokenTimer(serverId));
        
        this.logger.info('AuthService initialized');
    }

    handleConnectionRequest(config) {
        this.logger.debug(`[${config.id}] Processing connection request`);
        
        this.serverConfigs.set(config.id, config);

        if (!config.user || !config.user.trim()) {
            this.logger.debug(`[${config.id}] No user credentials provided`);
            eventBus.emit('auth:not_required', { config });
            return;
        }
        
        if (!config.password) {
            const error = new Error('Authentication failed: Password is required.');
            this.logger.error(`[${config.id}] ${error.message}`);
            eventBus.emit('auth:failure', { serverId: config.id, error });
            return;
        }

        this.logger.debug(`[${config.id}] Starting OAuth token request`);
        this.getAuthToken(config);
    }

    getAuthToken(config) {
        const postData = new URLSearchParams({
            grant_type: 'password',
            username: config.user.trim(),
            password: config.password,
            client_id: 'ioBroker',
            stayloggedin: 'false'
        }).toString();
        
        const protocol = config.usessl ? https : http;
        const url = `${config.usessl ? 'https' : 'http'}://${config.iobhost}:${config.iobport}/oauth/token`;

        const options = {
            hostname: config.iobhost,
            port: config.iobport,
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Node-RED-ioBroker/1.0.0',
                'Accept': 'application/json'
            },
            rejectUnauthorized: false,
            timeout: 10000
        };

        this.logger.debug(`[${config.id}] Sending POST request to ${url}`);
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                this.logger.debug(`[${config.id}] Auth response received - Status: ${res.statusCode}`);
                
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data);
                        const token = response.access_token;
                        if (!token) {
                           throw new Error('Access token not found in response');
                        }
                        this.logger.info(`[${config.id}] OAuth token received successfully`);
                        
                        this.activeTokens.set(config.id, token);
                        this.scheduleTokenRefresh(config.id);
                        
                        eventBus.emit('auth:token_received', { config, token });
                    } catch (error) {
                        this.logger.error(`[${config.id}] Failed to parse auth response: ${error.message}`);
                        eventBus.emit('auth:failure', { serverId: config.id, error });
                    }
                } else {
                    const error = new Error(`Authentication failed with status code: ${res.statusCode} - ${data}`);
                    this.logger.error(`[${config.id}] ${error.message}`);
                    eventBus.emit('auth:failure', { serverId: config.id, error });
                }
            });
        });

        req.on('error', (error) => {
            this.logger.error(`[${config.id}] HTTP request failed: ${error.message}`);
            
            const isNetworkError = error.code === 'ECONNREFUSED' || 
                                   error.code === 'ENOTFOUND' || 
                                   error.code === 'ECONNRESET' ||
                                   error.message.includes('network socket disconnected') ||
                                   error.message.includes('TLS connection');
            
            if (isNetworkError) {
                this.logger.warn(`[${config.id}] Network error detected, triggering reconnection retry`);
                eventBus.emit('connection:network_error', { serverId: config.id, error });
            } else {
                eventBus.emit('auth:failure', { serverId: config.id, error });
            }
        });

        req.write(postData);
        req.end();
    }

    scheduleTokenRefresh(serverId) {
        this.clearTokenTimer(serverId);
        
        this.logger.info(`[${serverId}] Token refresh scheduled for ${TOKEN_REFRESH_INTERVAL / 60000} minutes`);
        
        const timer = setTimeout(() => {
            this.logger.debug(`[${serverId}] Token refresh timer triggered`);
            this.refreshToken(serverId);
        }, TOKEN_REFRESH_INTERVAL);
        
        this.tokenTimers.set(serverId, timer);
    }

    async refreshToken(serverId) {
        const config = this.serverConfigs.get(serverId);
        if (!config) {
            this.logger.error(`[${serverId}] Cannot refresh token: Configuration not found`);
            return;
        }

        this.logger.info(`[${serverId}] Starting token refresh process`);
        
        try {
            await this.getNewTokenAndCreateParallelConnection(config);
        } catch (error) {
            this.logger.error(`[${serverId}] Token refresh failed: ${error.message}`);
            eventBus.emit('connection:network_error', { serverId, error });
        }
    }

    getNewTokenAndCreateParallelConnection(config) {
        return new Promise((resolve, reject) => {
            const postData = new URLSearchParams({
                grant_type: 'password',
                username: config.user.trim(),
                password: config.password,
                client_id: 'ioBroker',
                stayloggedin: 'false'
            }).toString();
            
            const protocol = config.usessl ? https : http;
            const url = `${config.usessl ? 'https' : 'http'}://${config.iobhost}:${config.iobport}/oauth/token`;

            const options = {
                hostname: config.iobhost,
                port: config.iobport,
                path: '/oauth/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'Node-RED-ioBroker/1.0.0',
                    'Accept': 'application/json'
                },
                rejectUnauthorized: false,
                timeout: 10000
            };

            this.logger.debug(`[${config.id}] Requesting new token for refresh from ${url}`);
            const req = protocol.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    this.logger.debug(`[${config.id}] Token refresh response received - Status: ${res.statusCode}`);
                    
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(data);
                            const newToken = response.access_token;
                            if (!newToken) {
                                throw new Error('Access token not found in refresh response');
                            }
                            
                            this.logger.info(`[${config.id}] New token received, initiating parallel connection`);
                            
                            const oldToken = this.activeTokens.get(config.id);
                            this.activeTokens.set(config.id, newToken);
                            
                            this.initiateParallelConnection(config, newToken, oldToken);
                            this.scheduleTokenRefresh(config.id);
                            
                            resolve();
                        } catch (error) {
                            this.logger.error(`[${config.id}] Failed to parse token refresh response: ${error.message}`);
                            reject(error);
                        }
                    } else {
                        const error = new Error(`Token refresh failed with status code: ${res.statusCode} - ${data}`);
                        this.logger.error(`[${config.id}] ${error.message}`);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                this.logger.error(`[${config.id}] Token refresh HTTP request failed: ${error.message}`);
                reject(error);
            });

            req.write(postData);
            req.end();
        });
    }

    initiateParallelConnection(config, newToken, oldToken) {
        this.logger.debug(`[${config.id}] Starting parallel connection with new token`);
        
        eventBus.emit('connection:parallel_refresh', { 
            config, 
            newToken, 
            oldToken,
            overlapTime: TOKEN_OVERLAP_TIME 
        });
    }

    clearTokenTimer(serverId) {
        const timer = this.tokenTimers.get(serverId);
        if (timer) {
            clearTimeout(timer);
            this.tokenTimers.delete(serverId);
            this.logger.debug(`[${serverId}] Token refresh timer cleared`);
        }
    }

    cleanup() {
        this.logger.info('AuthService cleanup started');
        
        this.tokenTimers.clear();
        this.activeTokens.clear();
        this.serverConfigs.clear();
        
        this.logger.info('AuthService cleanup completed');
    }
}

module.exports = AuthService;