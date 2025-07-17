/*!
 * Filter Helper Functions for ioBroker Node-RED Integration
 * Utilities for implementing filter modes in input nodes
 */

class FilterHelpers {
    /**
     * Check if a value should be filtered based on the filter mode
     */
    static shouldFilterValue(stateId, currentValue, previousValues, filterMode, isInitial = false, nodeLog = null) {
        const log = nodeLog || console.log;
        
        // Initial values ALWAYS bypass filtering - they are always sent
        if (isInitial) {
            log(`Filter: Initial value for ${stateId} - ALWAYS allowed (bypasses filtering)`);
            return false;
        }
        
        if (filterMode === 'all') {
            return false; // Don't filter anything
        }
        
        if (filterMode === 'changes-only') {
            const previousValue = previousValues.get(stateId);
            if (previousValue === undefined) {
                // First time we see this state after restart - ALLOW in changes-only mode
                log(`Filter: changes-only mode - first occurrence of ${stateId} after restart, allowing`);
                return false;
            }
            
            const shouldFilter = previousValue === currentValue;
            if (shouldFilter) {
                log(`Filter: changes-only mode - value unchanged for ${stateId}, filtering`);
            }
            return shouldFilter;
        }
        
        if (filterMode === 'changes-smart') {
            const previousValue = previousValues.get(stateId);
            if (previousValue === undefined) {
                // First time we see this state after restart - this should not happen in smart mode
                // because we pre-load baseline values, but if it does, allow it
                log(`Filter: changes-smart mode - unexpected first occurrence of ${stateId}, allowing`);
                return false;
            }
            
            const shouldFilter = previousValue === currentValue;
            if (shouldFilter) {
                log(`Filter: changes-smart mode - value unchanged for ${stateId}, filtering`);
            }
            return shouldFilter;
        }
        
        return false;
    }

    /**
     * Check ACK filter
     */
    static shouldSendMessage(ack, filter) {
        switch (filter) {
            case "ack": return ack === true;
            case "noack": return ack === false;
            default: return true; // "both"
        }
    }

    /**
     * Update previous values map with current state value
     */
    static updatePreviousValue(previousValues, stateId, value) {
        previousValues.set(stateId, value);
    }

    /**
     * Get filter mode description for status display
     */
    static getFilterLabel(filterMode) {
        return (filterMode === 'changes-only' || filterMode === 'changes-smart') ? ' [Changes]' : '';
    }
}

module.exports = { FilterHelpers };
