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
    static createGroupedMessage(states, outputProperty = 'payload', options = {}) {
        const message = {};
        message[outputProperty] = {};
        
        for (const [stateId, state] of Object.entries(states)) {
            message[outputProperty][stateId] = state.val;
        }
        
        message.topic = options.topic || "grouped_states";
        message.count = Object.keys(states).length;
        message.timestamp = Date.now();
        
        if (options.triggeredBy) {
            message.triggeredBy = options.triggeredBy;
        }
        
        if (options.partial) {
            message.partial = true;
        }
        
        if (options.isInitial) {
            message.initial = true;
        }
        
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

    /**
     * Initialize state tracking properties
     */
    static initializeStateTracking() {
        return {
            groupedStateValues: {},
            pendingBaselineRequests: new Set()
        };
    }

    /**
     * Store grouped state value
     */
    static storeGroupedStateValue(groupedStateValues, stateId, state) {
        groupedStateValues[stateId] = state;
    }

    /**
     * Get missing states from grouped states
     */
    static getMissingStates(groupedStateValues, expectedStates) {
        return expectedStates.filter(stateId => !(stateId in groupedStateValues));
    }

    /**
     * Setup grouped timeout
     */
    static setupGroupedTimeout(node, delay, callback) {
        return setTimeout(() => {
            callback();
        }, delay);
    }

    /**
     * Track baseline request
     */
    static trackBaselineRequest(pendingRequests, stateId) {
        pendingRequests.add(stateId);
    }

    /**
     * Check if request is baseline request
     */
    static isBaselineRequest(pendingRequests, stateId) {
        return pendingRequests.has(stateId);
    }

    /**
     * Complete baseline request
     */
    static completeBaselineRequest(pendingRequests, stateId) {
        pendingRequests.delete(stateId);
    }

    /**
     * Check if all initial values are received
     */
    static areAllInitialValuesReceived(groupedStateValues, expectedStates) {
        return expectedStates.every(stateId => stateId in groupedStateValues);
    }

    /**
     * Cleanup timeout
     */
    static cleanupTimeout(node, timeoutProperty) {
        if (node[timeoutProperty]) {
            clearTimeout(node[timeoutProperty]);
            node[timeoutProperty] = null;
        }
    }

    /**
     * Update previous value for change detection
     */
    static updatePreviousValue(node, stateId, value) {
        if (!node.previousValues) {
            node.previousValues = new Map();
        }
        node.previousValues.set(stateId, value);
    }

    /**
     * Check if value should be sent based on filter mode
     */
    static shouldSendByValue(node, stateId, value, filterMode, isInitialValue) {
        if (filterMode === 'all') return true;
        if (filterMode === 'changes-only' || filterMode === 'changes-smart') {
            if (!node.previousValues) {
                node.previousValues = new Map();
            }
            const previousValue = node.previousValues.get(stateId);
            if (previousValue === undefined) {
                // First value - always send unless it's changes-smart mode and initial value
                return !(filterMode === 'changes-smart' && isInitialValue);
            }
            return previousValue !== value;
        }
        return true;
    }

    /**
     * Check if message should be sent based on ACK filter
     */
    static shouldSendMessage(ack, ackFilter) {
        if (ackFilter === 'both') return true;
        if (ackFilter === 'acked') return ack === true;
        if (ackFilter === 'unacked') return ack === false;
        return true;
    }

    /**
     * Check if value should be filtered
     */
    static shouldFilterValue(stateId, value, previousValues, filterMode, isInitialValue, logFunction) {
        if (filterMode === 'all') return false;
        
        if (filterMode === 'changes-only' || filterMode === 'changes-smart') {
            if (!previousValues) return false;
            
            const previousValue = previousValues.get(stateId);
            if (previousValue === undefined) {
                // First value - filter only if it's changes-smart mode and initial value
                if (filterMode === 'changes-smart' && isInitialValue) {
                    if (logFunction) logFunction(`Filtering initial value for changes-smart mode: ${stateId}`);
                    return true;
                }
                return false;
            }
            
            if (previousValue === value) {
                if (logFunction) logFunction(`Filtering unchanged value for ${stateId}: ${value}`);
                return true;
            }
        }
        
        return false;
    }

    /**
     * Create enhanced message with additional metadata
     */
    static createEnhancedMessage(state, stateId, outputProperty = 'payload', options = {}) {
        const message = this.createMessage(state, stateId, outputProperty);
        
        if (options.initial) {
            message.initial = true;
        }
        
        if (options.pattern) {
            message.pattern = options.pattern;
        }
        
        if (options.multipleStatesMode) {
            message.multipleStatesMode = true;
        }
        
        return message;
    }
}

module.exports = { 
    StateMessageHelpers
};
