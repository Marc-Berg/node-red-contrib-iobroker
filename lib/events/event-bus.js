// lib/events/event-bus.js
const EventEmitter = require('events');

/**
 * A simple, singleton event bus for decoupled communication.
 */
class EventBus extends EventEmitter {
    constructor() {
        super();
        // Increase listener limit for complex systems
        this.setMaxListeners(50);
    }

    emit(event, ...args) {
        // For debugging: log all emitted events
        // console.log(`[EventBus] Emitting: ${event}`, args.length > 0 ? args : '');
        super.emit(event, ...args);
    }
}

// Export a single instance to be used throughout the application
module.exports = new EventBus();