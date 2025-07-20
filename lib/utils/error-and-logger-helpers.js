/*!
 * Error Classification and Logging Helper Functions for ioBroker Node-RED Integration
 * Unified utilities for error handling, logging, and debugging
 */

class ErrorAndLoggerHelpers {
    /**
     * Error severity levels
     */
    static SEVERITY_LEVELS = {
        LOW: 'low',
        MEDIUM: 'medium', 
        HIGH: 'high',
        CRITICAL: 'critical'
    };

    /**
     * Error categories
     */
    static ERROR_CATEGORIES = {
        CONNECTION: 'connection',
        VALIDATION: 'validation',
        STATE: 'state',
        OBJECT: 'object',
        HISTORY: 'history',
        SENDTO: 'sendto',
        SUBSCRIPTION: 'subscription',
        TIMEOUT: 'timeout',
        UNKNOWN: 'unknown'
    };

    /**
     * Classify error based on message and context
     */
    static classifyError(error, context = {}) {
        const message = error.message || error.toString();
        const lowerMessage = message.toLowerCase();

        // Connection related errors
        if (lowerMessage.includes('connect') || lowerMessage.includes('socket') || 
            lowerMessage.includes('econnrefused') || lowerMessage.includes('timeout')) {
            return {
                category: this.ERROR_CATEGORIES.CONNECTION,
                severity: this.SEVERITY_LEVELS.HIGH,
                retriable: true,
                shouldRetry: true
            };
        }

        // State related errors
        if (lowerMessage.includes('state') || lowerMessage.includes('getstate') || 
            lowerMessage.includes('setstate')) {
            return {
                category: this.ERROR_CATEGORIES.STATE,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: false
            };
        }

        // Object related errors
        if (lowerMessage.includes('object') || lowerMessage.includes('getobject') || 
            lowerMessage.includes('setobject')) {
            return {
                category: this.ERROR_CATEGORIES.OBJECT,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: false
            };
        }

        // Validation errors
        if (lowerMessage.includes('invalid') || lowerMessage.includes('validation') || 
            lowerMessage.includes('required') || lowerMessage.includes('missing')) {
            return {
                category: this.ERROR_CATEGORIES.VALIDATION,
                severity: this.SEVERITY_LEVELS.LOW,
                retriable: false,
                shouldRetry: false
            };
        }

        // History errors
        if (lowerMessage.includes('history') || lowerMessage.includes('gethistory')) {
            return {
                category: this.ERROR_CATEGORIES.HISTORY,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: true
            };
        }

        // SendTo errors
        if (lowerMessage.includes('sendto') || lowerMessage.includes('adapter')) {
            return {
                category: this.ERROR_CATEGORIES.SENDTO,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: true
            };
        }

        // Subscription errors
        if (lowerMessage.includes('subscription') || lowerMessage.includes('subscribe')) {
            return {
                category: this.ERROR_CATEGORIES.SUBSCRIPTION,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: true
            };
        }

        // Timeout errors
        if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
            return {
                category: this.ERROR_CATEGORIES.TIMEOUT,
                severity: this.SEVERITY_LEVELS.MEDIUM,
                retriable: true,
                shouldRetry: true
            };
        }

        // Default classification
        return {
            category: this.ERROR_CATEGORIES.UNKNOWN,
            severity: this.SEVERITY_LEVELS.MEDIUM,
            retriable: false,
            shouldRetry: false
        };
    }

    /**
     * Create structured log entry
     */
    static createLogEntry(level, message, context = {}) {
        return {
            timestamp: new Date().toISOString(),
            level: level,
            message: message,
            context: context,
            nodeId: context.nodeId || 'unknown',
            server: context.server || 'unknown'
        };
    }

    /**
     * Log with context information
     */
    static logWithContext(node, level, message, context = {}) {
        const logEntry = this.createLogEntry(level, message, {
            nodeId: node.id,
            server: node.server?.connectionName || 'unknown',
            ...context
        });

        // Use appropriate node logging method
        switch (level) {
            case 'error':
                node.error(logEntry.message, logEntry);
                break;
            case 'warn':
                node.warn(logEntry.message, logEntry);
                break;
            case 'debug':
                node.debug(logEntry.message, logEntry);
                break;
            case 'trace':
                node.trace(logEntry.message, logEntry);
                break;
            default:
                node.log(logEntry.message, logEntry);
        }

        return logEntry;
    }

    /**
     * Handle error with classification and logging
     */
    static handleError(node, error, context = {}) {
        const classification = this.classifyError(error, context);
        
        const errorContext = {
            ...context,
            category: classification.category,
            severity: classification.severity,
            retriable: classification.retriable,
            shouldRetry: classification.shouldRetry,
            originalError: error.message || error.toString(),
            stack: error.stack
        };

        // Log based on severity
        const logLevel = classification.severity === this.SEVERITY_LEVELS.CRITICAL ? 'error' : 
                        classification.severity === this.SEVERITY_LEVELS.HIGH ? 'error' :
                        classification.severity === this.SEVERITY_LEVELS.MEDIUM ? 'warn' : 'debug';

        this.logWithContext(node, logLevel, `${classification.category} error: ${error.message}`, errorContext);

        return classification;
    }

    /**
     * Create debug logger for specific component
     */
    static createDebugLogger(component, enabled = false) {
        return {
            log: (message, data = {}) => {
                if (enabled) {
                    console.log(`[${component}] ${message}`, data);
                }
            },
            error: (message, error = {}) => {
                if (enabled) {
                    console.error(`[${component}] ERROR: ${message}`, error);
                }
            },
            warn: (message, data = {}) => {
                if (enabled) {
                    console.warn(`[${component}] WARNING: ${message}`, data);
                }
            }
        };
    }

    /**
     * Sanitize sensitive data for logging
     */
    static sanitizeForLog(data) {
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const sensitiveKeys = ['password', 'token', 'key', 'secret', 'auth', 'credential'];
        const sanitized = { ...data };

        for (const key in sanitized) {
            if (sensitiveKeys.some(sensitiveKey => key.toLowerCase().includes(sensitiveKey))) {
                sanitized[key] = '***';
            } else if (typeof sanitized[key] === 'object') {
                sanitized[key] = this.sanitizeForLog(sanitized[key]);
            }
        }

        return sanitized;
    }

    /**
     * Format error message for user display
     */
    static formatErrorForUser(error, context = {}) {
        const classification = this.classifyError(error, context);
        
        let userMessage = error.message || 'Unknown error occurred';
        
        // Provide user-friendly messages for common error categories
        switch (classification.category) {
            case this.ERROR_CATEGORIES.CONNECTION:
                userMessage = 'Connection to ioBroker failed. Please check your connection settings.';
                break;
            case this.ERROR_CATEGORIES.VALIDATION:
                userMessage = `Configuration error: ${error.message}`;
                break;
            case this.ERROR_CATEGORIES.TIMEOUT:
                userMessage = 'Operation timed out. Please try again.';
                break;
        }

        return {
            message: userMessage,
            category: classification.category,
            severity: classification.severity,
            retriable: classification.retriable
        };
    }
}

// Legacy exports for backward compatibility
class ErrorClassifier {
    static classifyError(error, context) {
        return ErrorAndLoggerHelpers.classifyError(error, context);
    }

    static handleError(node, error, context) {
        return ErrorAndLoggerHelpers.handleError(node, error, context);
    }
}

class Logger {
    static logWithContext(node, level, message, context) {
        return ErrorAndLoggerHelpers.logWithContext(node, level, message, context);
    }

    static createDebugLogger(component, enabled) {
        return ErrorAndLoggerHelpers.createDebugLogger(component, enabled);
    }

    static sanitizeForLog(data) {
        return ErrorAndLoggerHelpers.sanitizeForLog(data);
    }
}

module.exports = { 
    ErrorAndLoggerHelpers,
    ErrorClassifier,   // For backward compatibility
    Logger            // For backward compatibility
};
