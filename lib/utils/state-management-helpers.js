/*!
 * State Management Helper Functions for ioBroker Node-RED Integration
 * Utilities for managing state lists and grouped state handling
 */

class StateManagementHelpers {
    /**
     * Parse multiple states configuration
     */
    static parseMultipleStates(multipleStatesConfig) {
        if (!multipleStatesConfig) {
            return [];
        }

        return multipleStatesConfig.split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    /**
     * Validate state configuration
     */
    static validateStateConfiguration(inputMode, stateId, statesList) {
        const errors = [];

        if (inputMode === 'single') {
            if (!stateId) {
                errors.push('State ID not configured for single mode');
            }
        } else if (inputMode === 'multiple') {
            if (!statesList || statesList.length === 0) {
                errors.push('No states configured for multiple mode');
            }
        } else {
            errors.push(`Invalid input mode: ${inputMode}`);
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Initialize state tracking collections
     */
    static initializeStateTracking() {
        return {
            groupedStateValues: {},
            subscribedStates: new Set(),
            initialValuesRequested: new Set(),
            previousValues: new Map(),
            pendingBaselineRequests: new Set()
        };
    }

    /**
     * Check if all states are subscribed
     */
    static areAllStatesSubscribed(subscribedStates, statesList) {
        return subscribedStates.size === statesList.length;
    }

    /**
     * Check if all initial values are received for grouped mode
     */
    static areAllInitialValuesReceived(groupedStateValues, statesList) {
        return statesList.every(stateId => 
            groupedStateValues.hasOwnProperty(stateId)
        );
    }

    /**
     * Get missing states for grouped mode
     */
    static getMissingStates(groupedStateValues, statesList) {
        return statesList.filter(stateId => 
            !groupedStateValues.hasOwnProperty(stateId)
        );
    }

    /**
     * Store state value in grouped collection
     */
    static storeGroupedStateValue(groupedStateValues, stateId, state) {
        groupedStateValues[stateId] = {
            value: state.val,
            ts: state.ts,
            ack: state.ack,
            state: state
        };
    }

    /**
     * Clean up timeout if it exists
     */
    static cleanupTimeout(node, timeoutProperty) {
        if (node[timeoutProperty]) {
            clearTimeout(node[timeoutProperty]);
            node[timeoutProperty] = null;
        }
    }

    /**
     * Setup timeout for grouped operations
     */
    static setupGroupedTimeout(node, timeoutMs, callback) {
        return setTimeout(() => {
            callback();
        }, timeoutMs);
    }

    /**
     * Create baseline request tracking
     */
    static trackBaselineRequest(pendingBaselineRequests, stateId) {
        pendingBaselineRequests.add(stateId);
    }

    /**
     * Complete baseline request tracking
     */
    static completeBaselineRequest(pendingBaselineRequests, stateId) {
        return pendingBaselineRequests.delete(stateId);
    }

    /**
     * Check if request is for baseline
     */
    static isBaselineRequest(pendingBaselineRequests, stateId) {
        return pendingBaselineRequests.has(stateId);
    }

    /**
     * Get subscription progress info
     */
    static getSubscriptionProgress(subscribedStates, statesList) {
        return {
            current: subscribedStates.size,
            total: statesList.length,
            percentage: Math.round((subscribedStates.size / statesList.length) * 100),
            isComplete: subscribedStates.size === statesList.length
        };
    }

    /**
     * Get initial values progress info
     */
    static getInitialValuesProgress(groupedStateValues, statesList) {
        const received = Object.keys(groupedStateValues).length;
        return {
            current: received,
            total: statesList.length,
            percentage: Math.round((received / statesList.length) * 100),
            isComplete: received === statesList.length
        };
    }
}

module.exports = { StateManagementHelpers };
