/*!
 * Shared Utilities for ioBroker Node-RED Integration
 */

class Logger {
    constructor(component) {
        this.component = component;
    }

    debug(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [debug] [${this.component}] ${msg}`);
    }

    info(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.log(`${day} ${month} ${time} - [info] [${this.component}] ${msg}`);
    }

    warn(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.warn(`${day} ${month} ${time} - [warn] [${this.component}] ${msg}`);
    }

    error(msg) {
        const now = new Date();
        const day = now.getDate().toString().padStart(2, '0');
        const month = now.toLocaleDateString('en', { month: 'short' });
        const time = now.toTimeString().slice(0, 8);
        console.error(`${day} ${month} ${time} - [error] [${this.component}] ${msg}`);
    }
}

class PatternMatcher {
    static matches(id, pattern) {
        if (id === pattern) return true;

        if (pattern.includes('*')) {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(id);
        }

        return false;
    }
}

class ErrorClassifier {
    static isAuthenticationError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        const authErrors = [
            'invalid grant',
            'invalid_grant',
            'unauthorized',
            'invalid credentials',
            'wrong username or password',
            'access denied',
            'authentication required',
            'invalid user',
            'bad credentials'
        ];

        return authErrors.some(authError => lowerErrorMsg.includes(authError));
    }

    static isNetworkError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        const networkErrors = [
            'timeout',
            'refused',
            'network',
            'econnreset',
            'enotfound',
            'ehostunreach',
            'socket hang up',
            'connection closed',
            'connect etimedout',
            'connect econnrefused'
        ];

        return networkErrors.some(netError => lowerErrorMsg.includes(netError));
    }

    static isRetryableError(errorMsg) {
        const lowerErrorMsg = errorMsg.toLowerCase();
        
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
            'connection terminated',
            'socket is closed',
            'connect etimedout',
            'connect econnrefused',
            'connection lost'
        ];
        
        if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
            return true;
        }
        
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
        
        if (genuineAuthErrors.some(authError => lowerErrorMsg.includes(authError))) {
            return false;
        }
        
        if (lowerErrorMsg.includes('authentication failed')) {
            if (networkErrors.some(netError => lowerErrorMsg.includes(netError))) {
                return true;
            }
            return false;
        }
        
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
}

module.exports = {
    Logger,
    PatternMatcher,
    ErrorClassifier
};