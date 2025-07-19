/*!
 * External Trigger Helper Functions for ioBroker Node-RED Integration
 * Utilities for external triggering functionality
 */

const { MessageHelpers } = require('./message-helpers');

class ExternalTriggerHelpers {
    /**
     * Send cached values for external triggering
     */
    static sendCachedValues(node) {
        if (node.inputMode === 'single') {
            return ExternalTriggerHelpers._sendSingleCachedValue(node);
        } else if (node.inputMode === 'multiple') {
            return ExternalTriggerHelpers._sendMultipleCachedValues(node);
        }
    }

    /**
     * Send cached value for single mode
     */
    static _sendSingleCachedValue(node) {
        let cachedValue = node.currentStateValues && node.currentStateValues.get ? 
            node.currentStateValues.get(node.stateId) : null;
        let state = cachedValue;
        
        if (!state && node.lastValue !== undefined) {
            state = { val: node.lastValue };
        }
        
        if (state && state.val !== undefined) {
            const message = {
                topic: node.stateId,
                [node.outputProperty || 'payload']: state.val,
                state: {
                    val: state.val,
                    ts: state.ts || Date.now(),
                    ack: state.ack !== undefined ? state.ack : true,
                    from: 'cache'
                },
                timestamp: Date.now(),
                cached: true,
                initial: true
            };
            
            node.send(message);
        }
    }

    /**
     * Send cached values for multiple mode
     */
    static _sendMultipleCachedValues(node) {
        if (node.outputMode === 'grouped') {
            ExternalTriggerHelpers._sendGroupedCachedValues(node);
        } else {
            ExternalTriggerHelpers._sendIndividualCachedValues(node);
        }
    }

    /**
     * Send grouped cached values
     */
    static _sendGroupedCachedValues(node) {
        const groupedValues = {};
        const groupedStates = {};
        let hasValues = false;
        
        if (node.currentStateValues && node.statesList) {
            node.statesList.forEach(stateId => {
                const state = node.currentStateValues.get(stateId);
                if (state && state.val !== undefined) {
                    groupedValues[stateId] = state.val;
                    groupedStates[stateId] = {
                        val: state.val,
                        ts: state.ts || Date.now(),
                        ack: state.ack !== undefined ? state.ack : true,
                        from: 'cache'
                    };
                    hasValues = true;
                }
            });
        }
        
        if (hasValues) {
            const message = {
                topic: 'cached_states',
                [node.outputProperty || 'payload']: groupedValues,
                states: groupedStates,
                timestamp: Date.now(),
                cached: true,
                isInitial: true,
                multipleStatesMode: true,
                outputMode: 'grouped'
            };
            
            node.send(message);
        }
    }

    /**
     * Send individual cached values
     */
    static _sendIndividualCachedValues(node) {
        if (node.currentStateValues && node.statesList) {
            node.statesList.forEach(stateId => {
                const state = node.currentStateValues.get(stateId);
                if (state && state.val !== undefined) {
                    const message = {
                        topic: stateId,
                        [node.outputProperty || 'payload']: state.val,
                        state: {
                            val: state.val,
                            ts: state.ts || Date.now(),
                            ack: state.ack !== undefined ? state.ack : true,
                            from: 'cache'
                        },
                        timestamp: Date.now(),
                        cached: true,
                        initial: true,
                        multipleStatesMode: true
                    };
                    
                    node.send(message);
                }
            });
        }
    }

    /**
     * Register node for external triggering
     */
    static registerNodeForExternalTrigger(node) {
        const enableExternalTrigger = node.enableExternalTrigger;
        const triggerGroup = node.triggerGroup;

        if (enableExternalTrigger) {
            const flowContext = node.context().flow;
            const existingNodes = flowContext.get(triggerGroup) || {};
            existingNodes[node.id] = {
                nodeRef: node,
                triggerCached: () => ExternalTriggerHelpers.sendCachedValues(node),
                states: node.inputMode === 'single' ? [node.stateId] : (node.statesList || []),
                mode: node.inputMode,
                name: node.name || `iob-in-${node.id.substring(0, 8)}`,
                outputMode: node.outputMode,
                stateId: node.stateId,
                group: triggerGroup
            };
            flowContext.set(triggerGroup, existingNodes);
            
            node.log(`External triggering enabled - registered in group: ${triggerGroup}`);
        }
    }

    /**
     * Unregister node from external triggering
     */
    static unregisterNodeFromExternalTrigger(node) {
        const enableExternalTrigger = node.enableExternalTrigger;
        const triggerGroup = node.triggerGroup;
        
        if (enableExternalTrigger) {
            const flowContext = node.context().flow;
            const existingNodes = flowContext.get(triggerGroup) || {};
            delete existingNodes[node.id];
            flowContext.set(triggerGroup, existingNodes);
        }
    }
}

module.exports = { ExternalTriggerHelpers };
