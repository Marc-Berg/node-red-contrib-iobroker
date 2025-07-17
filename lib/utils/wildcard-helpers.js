/*!
 * Wildcard Helper Functions for ioBroker Node-RED Integration
 * Utilities for handling wildcard patterns in input nodes
 */

class WildcardHelpers {
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
        // Convert wildcard pattern to regex
        // Escape special regex characters except *
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
            .replace(/\*/g, '.*'); // Replace * with .*
        
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(stateId);
    }

    /**
     * Validate wildcard pattern configuration
     */
    static validateWildcardConfig(inputMode, stateId, sendInitialValue) {
        const isWildcard = WildcardHelpers.isWildcardPattern(stateId);
        
        if (!isWildcard) {
            return { isWildcard: false, valid: true };
        }

        // Wildcard patterns are only supported in single mode
        if (inputMode !== 'single') {
            return {
                isWildcard: true,
                valid: false,
                error: 'Wildcard patterns are only supported in single input mode'
            };
        }

        // Return configuration adjustments
        return {
            isWildcard: true,
            valid: true,
            adjustments: {
                sendInitialValue: false // Wildcard patterns don't support initial values
            }
        };
    }

    /**
     * Extract base pattern from wildcard for optimization
     */
    static extractBasePattern(pattern) {
        if (!WildcardHelpers.isWildcardPattern(pattern)) {
            return pattern;
        }

        // Find the longest prefix before the first wildcard
        const firstWildcard = pattern.indexOf('*');
        if (firstWildcard === 0) {
            return ''; // Pattern starts with wildcard
        }

        return pattern.substring(0, firstWildcard);
    }

    /**
     * Count potential matches for pattern complexity analysis
     */
    static estimatePatternComplexity(pattern) {
        const wildcardCount = (pattern.match(/\*/g) || []).length;
        const depth = pattern.split('.').length;
        
        let complexity = 'low';
        if (wildcardCount > 2 || depth > 5) {
            complexity = 'high';
        } else if (wildcardCount > 1 || depth > 3) {
            complexity = 'medium';
        }

        return {
            wildcardCount,
            depth,
            complexity,
            recommendation: WildcardHelpers.getPatternRecommendation(complexity)
        };
    }

    /**
     * Get optimization recommendations for patterns
     */
    static getPatternRecommendation(complexity) {
        switch (complexity) {
            case 'high':
                return 'Consider using more specific patterns or multiple subscriptions for better performance';
            case 'medium':
                return 'Pattern complexity is acceptable but monitor subscription count';
            default:
                return 'Pattern is well optimized';
        }
    }
}

module.exports = { WildcardHelpers };
