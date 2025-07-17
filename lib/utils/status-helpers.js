/*!
 * Status Helper Functions for ioBroker Node-RED Integration
 * Utilities for managing node status displays in input nodes
 */

class StatusHelpers {
    /**
     * Update node status for single state mode
     */
    static updateSingleStateStatus(node, stateId, value, filterMode, isInitial = false) {
        const filterLabel = (filterMode === 'changes-only' || filterMode === 'changes-smart') ? ' [Changes]' : '';
        const initialLabel = isInitial ? ' (initial)' : '';
        
        let displayValue = value;
        if (typeof value === 'object') {
            displayValue = JSON.stringify(value);
        } else if (value === null) {
            displayValue = 'null';
        } else if (value === undefined) {
            displayValue = 'undefined';
        }
        
        // Truncate long values
        if (String(displayValue).length > 30) {
            displayValue = String(displayValue).substring(0, 27) + '...';
        }
        
        const statusText = `${displayValue}${filterLabel}${initialLabel}`;
        node.status({ fill: "green", shape: "dot", text: statusText });
    }

    /**
     * Update node status for multiple states mode
     */
    static updateMultipleStatesStatus(node, statesList, outputMode, filterMode) {
        const filterLabel = (filterMode === 'changes-only' || filterMode === 'changes-smart') ? ' [Changes]' : '';
        const statusText = `${statesList.length} states (${outputMode})${filterLabel}`;
        node.status({ fill: "green", shape: "dot", text: statusText });
    }

    /**
     * Update status for initial values collection progress
     */
    static updateInitialValuesProgress(node, receivedCount, totalCount) {
        const statusText = `Initial values: ${receivedCount}/${totalCount}`;
        const fill = receivedCount === totalCount ? "green" : "yellow";
        node.status({ fill, shape: "dot", text: statusText });
    }

    /**
     * Update status for subscription progress
     */
    static updateSubscriptionProgress(node, subscribedCount, totalCount) {
        const statusText = `Subscribed: ${subscribedCount}/${totalCount} states`;
        node.status({ fill: "green", shape: "ring", text: statusText });
    }

    /**
     * Update status for wildcard pattern
     */
    static updateWildcardStatus(node, stateId, isActive = false) {
        const statusText = isActive ? `Pattern active: ${stateId}` : `Waiting for pattern: ${stateId}`;
        const fill = isActive ? "green" : "grey";
        const shape = isActive ? "ring" : "dot";
        node.status({ fill, shape, text: statusText });
    }

    /**
     * Update status for connection states
     */
    static updateConnectionStatus(node, state, customText = null) {
        let fill, shape, text;
        
        switch (state) {
            case 'subscribing':
                fill = "blue";
                shape = "dot";
                text = customText || "Subscribing...";
                break;
            case 'disconnected':
                fill = "red";
                shape = "ring";
                text = customText || "Disconnected";
                break;
            case 'retrying':
                fill = "yellow";
                shape = "ring";
                text = customText || "Retrying...";
                break;
            case 'error':
                fill = "red";
                shape = "dot";
                text = customText || "Error";
                break;
            case 'waiting':
                fill = "grey";
                shape = "dot";
                text = customText || "Waiting for server...";
                break;
            case 'ready':
                fill = "green";
                shape = "dot";
                text = customText || "Ready";
                break;
            case 'checking':
                fill = "blue";
                shape = "dot";
                text = customText || "Checking...";
                break;
            case 'setting':
                fill = "blue";
                shape = "dot";
                text = customText || "Setting...";
                break;
            case 'requesting':
                fill = "blue";
                shape = "dot";
                text = customText || "Requesting...";
                break;
            default:
                fill = "grey";
                shape = "dot";
                text = customText || "Unknown";
        }
        
        node.status({ fill, shape, text });
    }

    /**
     * Update status with partial data indication
     */
    static updatePartialDataStatus(node, message) {
        node.status({ fill: "orange", shape: "dot", text: message });
    }
}

module.exports = { StatusHelpers };
