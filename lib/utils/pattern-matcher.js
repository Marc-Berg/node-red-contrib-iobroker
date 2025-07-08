/*!
 * Pattern Matcher Utility for ioBroker Node-RED Integration
 * Handles wildcard pattern matching for state and object IDs
 */

class PatternMatcher {
    static matches(id, pattern) {
        if (id === pattern) return true;

        if (pattern.includes('*')) {
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(id);
        }

        return false;
    }
}

module.exports = { PatternMatcher };