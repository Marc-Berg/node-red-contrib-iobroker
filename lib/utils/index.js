/*!
 * Utilities Index for ioBroker Node-RED Integration
 * Central export point for all utility classes
 */

// Core utilities
const { Logger } = require('./logger');
const { PatternMatcher } = require('./pattern-matcher');
const { ErrorClassifier } = require('./error-classifier');

// Helper classes
const { NodeHelpers, NodePatterns } = require('./node-helpers');
const { ManagerHelpers } = require('./manager-helpers');

// Re-export all utilities for easy access
module.exports = {
    // Core utilities (backward compatibility)
    Logger,
    PatternMatcher,
    ErrorClassifier,
    
    // Helper classes (new)
    NodeHelpers,
    NodePatterns,
    ManagerHelpers
};