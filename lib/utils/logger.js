/*!
 * Logger Utility for ioBroker Node-RED Integration
 * Automatically uses Node-RED's logging system when available
 */
class Logger {
    static RED = null;
    
    constructor(component) {
        // Handle Node-RED node objects or string components
        if (typeof component === 'string') {
            this.component = component;
        } else if (component && component.type) {
            // This is likely a Node-RED node object
            this.component = component.type || 'Unknown';
        } else {
            this.component = 'Unknown';
        }
    }

    static setRED(RED) {
        Logger.RED = RED;
    }

    getRED() {
        if (Logger.RED) {
            return Logger.RED;
        }
        if (typeof RED !== 'undefined') {
            Logger.RED = RED;
            return RED;
        }
        if (global.RED) {
            Logger.RED = global.RED;
            return global.RED;
        }
        try {
            const nodeRed = require('node-red');
            Logger.RED = nodeRed;
            return nodeRed;
        } catch (e) {
            return null;
        }
    }

    log(level, msg, additionalInfo = null) {
        let fullMessage = `[${this.component}] ${msg}`;
        
        // Handle additional info like error objects
        if (additionalInfo) {
            if (additionalInfo instanceof Error) {
                fullMessage += `: ${additionalInfo.message}`;
                if (additionalInfo.stack && level === 'error') {
                    fullMessage += `\n${additionalInfo.stack}`;
                }
            } else if (typeof additionalInfo === 'object') {
                fullMessage += `: ${JSON.stringify(additionalInfo)}`;
            } else {
                fullMessage += `: ${additionalInfo}`;
            }
        }
        
        const RED = this.getRED();
        
        if (RED && RED.log && RED.log[level]) {
            RED.log[level](fullMessage);
        } else {
            const now = new Date();
            const day = now.getDate().toString().padStart(2, '0');
            const month = now.toLocaleDateString('en', { month: 'short' });
            const time = now.toTimeString().slice(0, 8);
            
            const consoleMethod = console[level] || console.log;
            consoleMethod(`${day} ${month} ${time} - [${level}] ${fullMessage}`);
        }
    }

    debug(msg, additionalInfo = null) { this.log('debug', msg, additionalInfo); }
    info(msg, additionalInfo = null)  { this.log('info', msg, additionalInfo); }
    warn(msg, additionalInfo = null)  { this.log('warn', msg, additionalInfo); }
    error(msg, additionalInfo = null) { this.log('error', msg, additionalInfo); }
}

module.exports = { Logger };