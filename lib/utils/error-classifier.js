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

    static isCertificateError(errorMsg) {
        const lowerErrorMsg = String(errorMsg).toLowerCase();
        return ['self-signed certificate', 'self signed certificate', 'unable to verify the first certificate',
            'unable to get local issuer certificate', 'certificate has expired', 'cert_has_expired',
            'depth_zero_self_signed_cert', 'err_tls_cert_altname_invalid', 'hostname/ip does not match certificate']
            .some(m => lowerErrorMsg.includes(m));
    }

    static isRetryableError(errorMsg) {
        // Certificate problems are configuration errors and never fix themselves
        if (ErrorClassifier.isCertificateError(errorMsg)) {
            return false;
        }
        // With exponential backoff, it's safe to retry all other errors
        return true;
    }
}

module.exports = { ErrorClassifier };