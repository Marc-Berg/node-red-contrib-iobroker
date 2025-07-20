/*!
 * State and Message Helper Functions for ioBroker Node-RED Integration
 * Unified utilities for state management, filtering, and message creation
 */

class StateMessageHelpers {
    /**
     * Create a standard message with the correct output property
     */
    static createMessage(state, stateId, outputProperty = 'payload') {
        const message = {};
        message[outputProperty] = state.val;
        message.topic = stateId;
        message.ack = state.ack;
        message.ts = state.ts;
        message.q = state.q;
        message.from = state.from;
        message.user = state.user;
        message.lc = state.lc;
        message.c = state.c;
        return message;
    }

    /**
     * Create message for multiple states grouped mode
     */
    static createGroupedMessage(states, outputProperty = 'payload') {
        const message = {};
        message[outputProperty] = {};
        
        for (const [stateId, state] of Object.entries(states)) {
            message[outputProperty][stateId] = state.val;
        }
        
        message.topic = "grouped_states";
        message.count = Object.keys(states).length;
        message.timestamp = Date.now();
        return message;
    }

    /**
     * Create message for individual output mode
     */
    static createIndividualMessage(stateId, state, outputProperty = 'payload') {
        return this.createMessage(state, stateId, outputProperty);
    }

    /**
     * Apply filter to a state value
     */
    static applyFilter(state, filterConfig, previousValue) {
        if (!filterConfig || filterConfig.type === 'none') {
            return { shouldSend: true, newValue: state.val };
        }

        switch (filterConfig.type) {
            case 'onchange':
                return {
                    shouldSend: previousValue === undefined || state.val !== previousValue,
                    newValue: state.val
                };
            
            case 'threshold':
                const threshold = parseFloat(filterConfig.threshold || 0);
                const diff = Math.abs(parseFloat(state.val) - parseFloat(previousValue || 0));
                return {
                    shouldSend: previousValue === undefined || diff >= threshold,
                    newValue: state.val
                };
            
            case 'debounce':
                // Note: Debounce timing logic should be handled by caller
                return { shouldSend: true, newValue: state.val };
            
            case 'range':
                const min = parseFloat(filterConfig.min || Number.MIN_SAFE_INTEGER);
                const max = parseFloat(filterConfig.max || Number.MAX_SAFE_INTEGER);
                const numValue = parseFloat(state.val);
                const inRange = numValue >= min && numValue <= max;
                return {
                    shouldSend: inRange,
                    newValue: state.val
                };

            default:
                return { shouldSend: true, newValue: state.val };
        }
    }

    /**
     * Parse multiple states input
     */
    static parseMultipleStates(input) {
        if (!input || typeof input !== 'string') {
            return [];
        }

        return input
            .split(/[,;\n]/)
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    /**
     * Validate state configuration
     */
    static validateStateConfiguration(stateId, inputMode, multipleStates) {
        const errors = [];

        if (inputMode === 'single') {
            if (!stateId || !stateId.trim()) {
                errors.push('State ID is required for single input mode');
            }
        } else if (inputMode === 'multiple') {
            if (!multipleStates || !multipleStates.trim()) {
                errors.push('Multiple states list is required for multiple input mode');
            } else {
                const statesList = this.parseMultipleStates(multipleStates);
                if (statesList.length === 0) {
                    errors.push('At least one state ID must be specified in multiple states list');
                }
                
                // Check for wildcards in multiple states mode
                const hasWildcards = statesList.some(id => id.includes('*'));
                if (hasWildcards) {
                    errors.push('Wildcard patterns are not supported in multiple states mode');
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Get states to subscribe to based on configuration
     */
    static getSubscriptionStates(stateId, inputMode, multipleStates) {
        if (inputMode === 'single') {
            return stateId ? [stateId.trim()] : [];
        } else if (inputMode === 'multiple') {
            return this.parseMultipleStates(multipleStates);
        }
        return [];
    }

    /**
     * Format state value for display
     */
    static formatValueForDisplay(value) {
        if (value === null) return "null";
        if (value === undefined) return "undefined";
        if (typeof value === 'boolean') return value.toString();
        if (typeof value === 'number') return value.toString();
        if (typeof value === 'string') {
            return value.length > 20 ? `"${value.substring(0, 17)}..."` : `"${value}"`;
        }
        if (typeof value === 'object') {
            try {
                const jsonStr = JSON.stringify(value);
                return jsonStr.length > 20 ? `${jsonStr.substring(0, 17)}...` : jsonStr;
            } catch {
                return "[object]";
            }
        }
        return String(value);
    }

    /**
     * Check if state value is numeric
     */
    static isNumericValue(value) {
        return typeof value === 'number' && !isNaN(value);
    }

    /**
     * Convert state value to number if possible
     */
    static toNumber(value) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const num = parseFloat(value);
            return isNaN(num) ? null : num;
        }
        return null;
    }

    /**
     * Deep clone a state object
     */
    static cloneState(state) {
        if (!state || typeof state !== 'object') return state;
        
        return {
            val: state.val,
            ack: state.ack,
            ts: state.ts,
            q: state.q,
            from: state.from,
            user: state.user,
            lc: state.lc,
            c: state.c
        };
    }
}

// Legacy exports for backward compatibility
class MessageHelpers extends StateMessageHelpers {}
class FilterHelpers extends StateMessageHelpers {}
class StateManagementHelpers extends StateMessageHelpers {}

module.exports = { 
    StateMessageHelpers,
    MessageHelpers,      // For backward compatibility
    FilterHelpers,       // For backward compatibility
    StateManagementHelpers // For backward compatibility
};
