/*!
 * Pattern and Wildcard Helper Functions for ioBroker Node-RED Integration
 * Unified utilities for handling patterns, wildcards, and matching in input nodes
 */

class PatternHelpers {
    /**
     * Check if a state ID is a wildcard pattern
     */
    static isWildcardPattern(stateId) {
        return stateId && stateId.includes('*');
    }

    /**
     * Match a state ID against a wildcard pattern
     */
    static matchesWildcardPattern(stateId, pattern) {
        if (stateId === pattern) return true;

        if (pattern.includes('*')) {
            // Convert wildcard pattern to regex
            // Escape special regex characters except *
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
                .replace(/\*/g, '.*'); // Replace * with .*
            
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(stateId);
        }

        return false;
    }

    /**
     * Validate wildcard pattern configuration
     */
    static validateWildcardPattern(pattern, inputMode) {
        if (!pattern) {
            return { isValid: false, message: 'Pattern is required' };
        }

        if (inputMode === 'multiple' && this.isWildcardPattern(pattern)) {
            return { isValid: false, message: 'Wildcard patterns are only supported in single input mode' };
        }

        if (inputMode === 'single' && !this.isWildcardPattern(pattern)) {
            // Single mode without wildcard is still valid
            return { isValid: true };
        }

        // Basic wildcard validation
        if (this.isWildcardPattern(pattern)) {
            // Check for invalid patterns like "**" or empty segments
            if (pattern.includes('**') || pattern.includes('.*') || pattern.includes('.+')) {
                return { isValid: false, message: 'Invalid wildcard pattern' };
            }
        }

        return { isValid: true };
    }

    /**
     * Convert wildcard pattern to regex string
     */
    static wildcardToRegex(pattern) {
        return pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
    }

    /**
     * Test if an array of state IDs contains any wildcards
     */
    static hasWildcardPatterns(stateIds) {
        if (!Array.isArray(stateIds)) return false;
        return stateIds.some(id => this.isWildcardPattern(id));
    }

    /**
     * Filter array of states that match a pattern
     */
    static filterStatesByPattern(states, pattern) {
        if (!Array.isArray(states) || !pattern) return [];
        
        if (this.isWildcardPattern(pattern)) {
            return states.filter(state => this.matchesWildcardPattern(state.id || state, pattern));
        } else {
            return states.filter(state => (state.id || state) === pattern);
        }
    }

    /**
     * Check if pattern is safe (no dangerous regex constructs)
     */
    static isSafePattern(pattern) {
        if (!pattern || typeof pattern !== 'string') return false;
        
        // Block potentially dangerous patterns
        const dangerousPatterns = [
            /\(\?\=/,  // Positive lookahead
            /\(\?\!/,  // Negative lookahead
            /\(\?\<\=/,  // Positive lookbehind
            /\(\?\<\!/,  // Negative lookbehind
            /\{[\d,]*\}/,  // Quantifiers like {1,100}
            /\[\^.*\]/,  // Negated character classes
        ];

        return !dangerousPatterns.some(dangerous => dangerous.test(pattern));
    }

    /**
     * Validate wildcard configuration (legacy method name)
     */
    static validateWildcardConfig(inputMode, stateId, sendInitialValue) {
        const isWildcard = this.isWildcardPattern(stateId);
        
        if (isWildcard && inputMode === 'multiple') {
            return {
                isWildcard: true,
                valid: false,
                message: 'Wildcard patterns are not supported in multiple input mode'
            };
        }

        if (isWildcard && sendInitialValue) {
            return {
                isWildcard: true,
                valid: false,
                message: 'Initial values are not supported with wildcard patterns'
            };
        }

        return {
            isWildcard: isWildcard,
            valid: true,
            message: isWildcard ? 'Valid wildcard pattern' : 'Single state ID'
        };
    }

    /**
     * Register node for external trigger (placeholder)
     */
    static registerNodeForExternalTrigger(node) {
        // This functionality should be in ServiceIntegrationHelpers
        // Placeholder for now
    }

    /**
     * Unregister node from external trigger (placeholder)
     */
    static unregisterNodeFromExternalTrigger(node) {
        // This functionality should be in ServiceIntegrationHelpers
        // Placeholder for now
    }
}

module.exports = { 
    PatternHelpers
};
