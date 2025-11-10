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

        // Check for authentication failed with 404 (endpoint not found)
        if (lowerErrorMsg.includes('authentication failed') && 
            (lowerErrorMsg.includes('(404)') || (lowerErrorMsg.includes('404') && lowerErrorMsg.includes('not found')))) {
            return true;
        }

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
        // With exponential backoff, it's safe to retry ALL errors
        // This simplifies logic and handles edge cases automatically
        return true;
    }
}

module.exports = { ErrorClassifier };