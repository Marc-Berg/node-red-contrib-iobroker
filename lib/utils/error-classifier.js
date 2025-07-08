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

module.exports = { ErrorClassifier };