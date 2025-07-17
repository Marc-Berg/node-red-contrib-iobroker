/*!
 * Message Helper Functions for ioBroker Node-RED Integration
 * Utilities for creating and processing messages in input nodes
 */

class MessageHelpers {
    /**
     * Create a standard message with the correct output property
     */
    static createMessage(state, stateId, outputProperty = 'payload') {
        const message = {
            topic: stateId,
            ts: state.ts,
            lc: state.lc,
            ack: state.ack,
            from: state.from,
            quality: state.q
        };
        
        // Use the configured output property (default: "payload")
        message[outputProperty] = state.val;
        
        return message;
    }

    /**
     * Create a grouped message for multiple states
     */
    static createGroupedMessage(groupedStateValues, outputProperty = 'payload', options = {}) {
        const {
            topic = 'grouped_states',
            isInitial = false,
            triggeredBy = null,
            partial = false
        } = options;

        const message = {
            topic: topic,
            states: Object.assign({}, groupedStateValues),
            timestamp: Date.now(),
            multipleStatesMode: true,
            outputMode: 'grouped'
        };
        
        // Use the configured output property (default: "payload")
        message[outputProperty] = Object.keys(groupedStateValues).reduce((acc, key) => {
            acc[key] = groupedStateValues[key].value;
            return acc;
        }, {});
        
        if (isInitial) {
            message.initial = true;
        }
        
        if (triggeredBy) {
            message.triggeredBy = triggeredBy;
        }
        
        if (partial) {
            message.partial = true;
        }
        
        return message;
    }

    /**
     * Create an enhanced message for single state with additional properties
     */
    static createEnhancedMessage(state, stateId, outputProperty = 'payload', options = {}) {
        const message = MessageHelpers.createMessage(state, stateId, outputProperty);
        
        const {
            initial = false,
            pattern = null,
            multipleStatesMode = false
        } = options;

        message.state = state;
        message.timestamp = Date.now();
        
        if (initial) {
            message.initial = true;
        }
        
        if (pattern) {
            message.pattern = pattern;
        }
        
        if (multipleStatesMode) {
            message.multipleStatesMode = true;
        }
        
        return message;
    }
}

module.exports = { MessageHelpers };
