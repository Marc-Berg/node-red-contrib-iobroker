# WS ioB sendTo - Send Commands to Adapter Instances

Send commands and messages to ioBroker adapter instances using the sendTo functionality for service integration, notifications, and automation tasks.

## Purpose

The WS ioB sendTo node allows you to send commands directly to ioBroker adapter instances that support the sendTo interface. This enables integration with notification services, database operations, script execution, media control, and many other instance-specific functions from within Node-RED flows.

## Configuration

### Basic Settings

**Target Instance**
- Dropdown selection of available adapter instances with their current status:
  - 🟢 **Running**: Instance is currently active and ready to receive commands
  - 🔴 **Stopped**: Instance is installed but not currently running
- Leave empty to use `msg.instance` for dynamic targeting
- Examples: `telegram.0`, `email`, `sql.0`, `javascript.0`

**Command**
- Optional command parameter required by some instances
- Common commands: `send`, `query`, `toScript`, `play`, `stop`
- Leave empty if instance doesn't require a command
- Can be overridden by `msg.command`

**Static Message**
- Optional JSON message content to send to the instance
- If empty, `msg.payload` will be used as the message content
- Must be valid JSON when specified
- Can be overridden by `msg.message`

**Wait for Response**
- **Disabled (Fire-and-forget)**: Send command without waiting for response
- **Enabled (Response mode)**: Wait for instance response and send as output

**Response Timeout** (Response mode only)
- Maximum time to wait for instance response (1000-60000 milliseconds)
- Default: 10000ms (10 seconds)
- Can be overridden by `msg.timeout`

## Dynamic Configuration

Override static settings using message properties:

### Dynamic Instance Targeting
```javascript
msg.instance = "telegram.0";
msg.payload = { text: "Hello!", user: "admin" };
```

### Dynamic Command Selection
```javascript
msg.instance = "sql.0";
msg.command = "query";
msg.payload = "SELECT * FROM sensors WHERE timestamp > NOW() - INTERVAL 1 HOUR";
```

### Dynamic Message Content
```javascript
msg.instance = "javascript.0";
msg.command = "toScript";
msg.message = {
    script: "myAutomationScript",
    data: { temperature: 25, humidity: 60 }
};
```

### Dynamic Response Timeout
```javascript
msg.instance = "influxdb.0";
msg.command = "query";
msg.timeout = 30000; // 30 seconds for complex database queries
```

## Error Handling

### Common Error Scenarios
- **Instance not found**: Specified instance doesn't exist or isn't running
- **Invalid command**: Command not supported by the target instance
- **Timeout**: Instance didn't respond within the specified timeout period
- **Invalid message format**: Message content not compatible with instance expectations
- **Permission denied**: Insufficient rights to execute command on instance

### Error Response Format
When an error occurs, the output includes:
```javascript
{
    error: "Timeout waiting for response from telegram.0",
    instance: "telegram.0",
    command: "send",
    originalMessage: { text: "Test message" },
    timestamp: 1640995200000
}
```

## Performance Considerations

### Response Mode vs Fire-and-Forget
- **Fire-and-forget**: Faster execution, no feedback, suitable for notifications
- **Response mode**: Provides feedback but adds latency and resource usage

## Troubleshooting

### Instance Not Responding
1. **Check instance status** in ioBroker admin interface
2. **Verify instance supports sendTo** functionality
3. **Test command manually** in ioBroker scripts or admin
4. **Check instance logs** for error messages
5. **Restart instance** if necessary

### Command Format Issues
1. **Review adapter documentation** for correct command format
2. **Test with minimal message** first
3. **Validate JSON syntax** in static messages
4. **Check parameter types** (string vs object vs array)
5. **Use adapter examples** from ioBroker community

## Related Nodes

- **WS ioB in**: Monitor instance states and responses
- **WS ioB out**: Control instance settings and configurations
- **WS ioB get**: Read instance status and information
- **WS ioB log**: Monitor instance log messages for debugging

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples and complete flow configurations.