// lib/services/auth-service.js
const https = require('https');
const eventBus = require('../events/event-bus');

/**
 * Manages the authentication process against ioBroker.
 * Fetches an OAuth2 token and emits success/failure events.
 */
class AuthService {
    constructor() {
        this.config = null;
        this.token = null;

        // Start the process when a connection is requested
        eventBus.on('connection:request', (config) => this.handleConnectionRequest(config));
    }

    handleConnectionRequest(config) {
        this.config = config;

        // If no username is provided, authentication is not required.
        if (!config.user || !config.user.trim()) {
            eventBus.emit('auth:not_required', { config });
            return;
        }
        
        // If password is missing, fail immediately.
        if (!config.password) {
            const error = new Error('Authentication failed: Password is required.');
            eventBus.emit('auth:failure', { serverId: config.serverId, error });
            return;
        }

        this.getAuthToken();
    }

    getAuthToken() {
        const postData = `user=${encodeURIComponent(this.config.user)}&pass=${encodeURIComponent(this.config.password)}`;
        const protocol = this.config.usessl ? 'https' : 'http';
        const url = `${protocol}://${this.config.iobhost}:${this.config.iobport}/login?cli=1`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            rejectUnauthorized: false // Necessary for self-signed certificates
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data);
                        this.token = response.token;
                        if (!this.token) {
                           throw new Error('Token not found in response');
                        }
                        // Success: Pass the token and config along for the next step
                        eventBus.emit('auth:token_received', { config: this.config, token: this.token });
                    } catch (error) {
                        eventBus.emit('auth:failure', { serverId: this.config.serverId, error });
                    }
                } else {
                    const error = new Error(`Authentication failed with status code: ${res.statusCode}`);
                    eventBus.emit('auth:failure', { serverId: this.config.serverId, error });
                }
            });
        });

        req.on('error', (error) => {
            eventBus.emit('auth:failure', { serverId: this.config.serverId, error });
        });

        req.write(postData);
        req.end();
    }
}

module.exports = AuthService;