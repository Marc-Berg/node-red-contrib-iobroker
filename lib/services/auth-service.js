const http = require('http');
const https = require('https');
const eventBus = require('../events/event-bus');
const LoggingService = require('../logging');

class AuthService {
    constructor() {
        this.logger = LoggingService.getLogger('AuthService');
        eventBus.on('connection:request', (config) => this.handleConnectionRequest(config));
        this.logger.info('AuthService constructed and listener attached.');
    }

    handleConnectionRequest(config) {
        this.logger.info(`[${config.id}] Received connection request.`);

        if (!config.user || !config.user.trim()) {
            this.logger.info(`[${config.id}] No user provided. Emitting auth:not_required.`);
            eventBus.emit('auth:not_required', { config });
            return;
        }
        
        if (!config.password) {
            const error = new Error('Authentication failed: Password is required.');
            this.logger.error(`[${config.id}] ${error.message}`);
            eventBus.emit('auth:failure', { serverId: config.id, error });
            return;
        }

        this.logger.info(`[${config.id}] User and password found. Requesting auth token.`);
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

        this.logger.info(`[${config.id}] POSTing to ${url}`);
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                this.logger.debug(`[${config.id}] Auth response - Status: ${res.statusCode}, Data: ${data}`);
                
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data);
                        const token = response.access_token; // OAuth2 verwendet access_token, nicht token
                        if (!token) {
                           throw new Error('Access token not found in response');
                        }
                        this.logger.info(`[${config.id}] OAuth token received successfully.`);
                        eventBus.emit('auth:token_received', { config, token });
                    } catch (error) {
                        this.logger.error(`[${config.id}] Failed to parse auth response or token missing: ${error.message}`);
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
            this.logger.error(`[${config.id}] HTTP request for token failed: ${error.message}`);
            
            // Classify the error type
            const isNetworkError = error.code === 'ECONNREFUSED' || 
                                   error.code === 'ENOTFOUND' || 
                                   error.code === 'ECONNRESET' ||
                                   error.message.includes('network socket disconnected') ||
                                   error.message.includes('TLS connection');
            
            if (isNetworkError) {
                // Network errors should trigger reconnection, not auth failure
                this.logger.warn(`[${config.id}] Network error detected. This will trigger reconnection retry.`);
                eventBus.emit('connection:network_error', { serverId: config.id, error });
            } else {
                // Real auth errors
                eventBus.emit('auth:failure', { serverId: config.id, error });
            }
        });

        req.write(postData);
        req.end();
    }
}

module.exports = AuthService;