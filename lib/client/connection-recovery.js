/*!
 * Connection Recovery Manager for ioBroker WebSocket Client
 * Handles retry logic, backoff strategies, and failure detection
 */

class ConnectionRecovery {
    constructor(client) {
        this.client = client;
        this.retryAttempts = 0;
        this.maxRetryAttempts = 50;
        this.baseRetryDelay = 2000;
        this.maxRetryDelay = 30000;
        this.productionRetryDelay = 60000;
        this.retryTimer = null;
        this.permanentFailure = false;
        this.isInitialConnection = true;
        this.connectionRecoveryEnabled = true;
        this.productionMode = false;
        this.lastSuccessfulConnection = null;
    }

    setEnabled(enabled) {
        this.connectionRecoveryEnabled = enabled;
        if (!enabled && this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    calculateRetryDelay() {
        if (this.productionMode) {
            const jitter = Math.random() * 5000;
            return this.productionRetryDelay + jitter;
        }
        
        const exponentialDelay = Math.min(
            this.baseRetryDelay * Math.pow(2, this.retryAttempts),
            this.maxRetryDelay
        );
        
        const jitter = Math.random() * 1000;
        return exponentialDelay + jitter;
    }

    isRetryableError(error) {
        if (this.permanentFailure) return false;
        
        const errorMsg = error.message || error.toString();
        const lowerErrorMsg = errorMsg.toLowerCase();
        
        // First check for network/connection errors that should always be retryable
        const networkErrors = [
            'timeout',
            'refused',
            'network',
            'disconnected',
            'econnreset',
            'enotfound',
            'ehostunreach',
            'socket hang up',
            'connection closed',
            'client network socket disconnected',
            'secure tls connection was established',
            'connection terminated',
            'socket is closed',
            'connect etimedout',
            'connect econnrefused'
        ];
        
        // If it's a network error, it's always retryable regardless of wrapper text
        if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
            return true;
        }
        
        // Check for genuine authentication errors (not network errors wrapped as auth errors)
        const genuineAuthErrors = [
            'invalid grant',
            'invalid_grant',
            'unauthorized',
            'invalid credentials',
            'user credentials are invalid',
            'wrong username or password',
            'access denied',
            'authentication required',
            'invalid user',
            'bad credentials'
        ];
        
        // Only treat as permanent auth failure if it's a genuine auth error
        if (genuineAuthErrors.some(authError => lowerErrorMsg.includes(authError))) {
            this.client.log.debug(`Genuine authentication error detected: ${errorMsg}`);
            this.permanentFailure = true;
            return false;
        }
        
        // Special case: "Authentication failed" that contains network errors should be retryable
        if (lowerErrorMsg.includes('authentication failed')) {
            // Check if the authentication failed due to a network issue
            if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
                this.client.log.debug(`Authentication failed due to network error, will retry: ${errorMsg}`);
                return true;
            }
            
            // If authentication failed without clear network cause, treat as permanent
            this.client.log.debug(`Genuine authentication failure detected: ${errorMsg}`);
            this.permanentFailure = true;
            return false;
        }
        
        // Default retryable errors (broader list for other connection issues)
        const generalRetryableErrors = [
            'handshake',
            'websocket',
            'connection',
            'server error',
            'service unavailable'
        ];
        
        return generalRetryableErrors.some(retryError => 
            lowerErrorMsg.includes(retryError)
        );
    }

    scheduleRetry() {
        if (!this.connectionRecoveryEnabled || 
            this.permanentFailure || 
            this.client.destroyed || 
            this.retryTimer) {
            return;
        }

        if (this.retryAttempts >= this.maxRetryAttempts && !this.productionMode) {
            this.productionMode = true;
            this.client.log.debug(`Switching to production retry mode - will continue retrying every ${this.productionRetryDelay/1000}s indefinitely`);
        }

        const delay = this.calculateRetryDelay();
        const modeText = this.productionMode ? 'production mode' : `${this.retryAttempts + 1}/${this.maxRetryAttempts}`;
        this.client.log.debug(`Scheduling connection retry (${modeText}) in ${Math.round(delay/1000)}s`);
        
        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            this.retryAttempts++;
            
            if (!this.client.destroyed && !this.client.connected) {
                const attemptText = this.productionMode ? `production attempt ${this.retryAttempts - this.maxRetryAttempts}` : `attempt ${this.retryAttempts}/${this.maxRetryAttempts}`;
                this.client.log.debug(`Attempting connection retry (${attemptText})`);
                try {
                    await this.client.connect(this.client.url, this.client.options);
                } catch (error) {
                    this.client.log.debug(`Retry ${attemptText} failed: ${error.message}`);
                }
            }
        }, delay);
    }

    resetRetryState() {
        this.retryAttempts = 0;
        this.permanentFailure = false;
        this.productionMode = false;
        this.isInitialConnection = false;
        this.lastSuccessfulConnection = Date.now();
        
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    getStats() {
        return {
            retryAttempts: this.retryAttempts,
            maxRetryAttempts: this.maxRetryAttempts,
            productionMode: this.productionMode,
            permanentFailure: this.permanentFailure,
            connectionRecoveryEnabled: this.connectionRecoveryEnabled,
            lastSuccessfulConnection: this.lastSuccessfulConnection,
            isInitialConnection: this.isInitialConnection
        };
    }

    destroy() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        
        this.connectionRecoveryEnabled = false;
        this.permanentFailure = false;
        this.retryAttempts = 0;
        this.productionMode = false;
    }
}

module.exports = ConnectionRecovery;