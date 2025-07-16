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
        const postData = `user=${encodeURIComponent(config.user)}&pass=${encodeURIComponent(config.password)}`;
        const protocol = config.usessl ? https : http;
        const url = `${config.usessl ? 'https' : 'http'}://${config.iobhost}:${config.iobport}/login?cli=1`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            rejectUnauthorized: false
        };

        this.logger.info(`[${config.id}] POSTing to ${url}`);
        const req = protocol.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data);
                        const token = response.token;
                        if (!token) {
                           throw new Error('Token not found in response');
                        }
                        this.logger.info(`[${config.id}] Token received successfully.`);
                        eventBus.emit('auth:token_received', { config, token });
                    } catch (error) {
                        this.logger.error(`[${config.id}] Failed to parse auth response or token missing: ${error.message}`);
                        eventBus.emit('auth:failure', { serverId: config.id, error });
                    }
                } else {
                    const error = new Error(`Authentication failed with status code: ${res.statusCode}`);
                    this.logger.error(`[${config.id}] ${error.message}`);
                    eventBus.emit('auth:failure', { serverId: config.id, error });
                }
            });
        });

        req.on('error', (error) => {
            this.logger.error(`[${config.id}] HTTP request for token failed: ${error.message}`);
            eventBus.emit('auth:failure', { serverId: config.id, error });
        });

        req.write(postData);
        req.end();
    }
}

module.exports = AuthService;