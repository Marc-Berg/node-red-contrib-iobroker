/*!
 * DEPRECATED: lib/utils.js
 * 
 * This file is deprecated and will be removed in a future version.
 * Please update your imports to use the new modular structure:
 * 
 * OLD (deprecated):
 * const { Logger, PatternMatcher, ErrorClassifier } = require('./utils');
 * 
 * NEW (recommended):
 * const { Logger } = require('./utils/logger');
 * const { PatternMatcher } = require('./utils/pattern-matcher');
 * const { ErrorClassifier } = require('./utils/error-classifier');
 * 
 * OR use the central index:
 * const { Logger, PatternMatcher, ErrorClassifier } = require('./utils');
 * 
 */

// Temporary backward compatibility - delegates to new modular structure
const { Logger, PatternMatcher, ErrorClassifier } = require('./utils');

console.warn('[DEPRECATED] lib/utils.js is deprecated. Please update imports to use lib/utils/ directory structure.');

module.exports = {
    Logger,
    PatternMatcher,
    ErrorClassifier
};