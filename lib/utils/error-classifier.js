/*!
 * Error Classifier Utility for ioBroker Node-RED Integration
 * Classifies errors for appropriate retry and recovery strategies
 */

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
        // Accept either an Error object or a string. Normalize to a lower-cased inspection string
        let inspectStr = '';

        try {
            if (!errorMsg) {
                inspectStr = '';
            } else if (typeof errorMsg === 'string') {
                inspectStr = errorMsg;
            } else if (typeof errorMsg === 'object') {
                // Prefer explicit fields if present
                const parts = [];
                if (errorMsg.code) parts.push(String(errorMsg.code));
                if (errorMsg.name) parts.push(String(errorMsg.name));
                if (errorMsg.message) parts.push(String(errorMsg.message));
                if (errorMsg.stack) parts.push(String(errorMsg.stack));

                // Handle AggregateError-like containers (errors array)
                if (Array.isArray(errorMsg.errors)) {
                    for (const sub of errorMsg.errors) {
                        if (sub && typeof sub === 'object') {
                            if (sub.code) parts.push(String(sub.code));
                            if (sub.name) parts.push(String(sub.name));
                            if (sub.message) parts.push(String(sub.message));
                            if (sub.stack) parts.push(String(sub.stack));
                        } else if (sub) {
                            parts.push(String(sub));
                        }
                    }
                }

                inspectStr = parts.join(' ');
            } else {
                inspectStr = String(errorMsg);
            }
        } catch (e) {
            inspectStr = String(errorMsg);
        }

        const lowerErrorMsg = (inspectStr || '').toLowerCase();

        const networkErrors = [
            'timeout',
            'refused',
            'econnrefused',
            'refuse',
            'connection refused',
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
            'service unavailable',
            'aggregateerror',
            'unknown error'
        ];

        return generalRetryableErrors.some(retryError => 
            lowerErrorMsg.includes(retryError)
        );
    }
}

module.exports = { ErrorClassifier };