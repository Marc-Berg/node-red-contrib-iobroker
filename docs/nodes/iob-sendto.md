# WS ioB sendTo - Send Commands to Adapters

Send commands and messages to ioBroker adapters using the sendTo functionality for service integration, notifications, and automation tasks.

## Purpose

The WS ioB sendTo node allows you to send commands directly to ioBroker adapters that support the sendTo interface. This enables integration with notification services, database operations, script execution, media control, and many other adapter-specific functions from within Node-RED flows.

## Configuration

### Basic Settings

**Target Adapter**
- Dropdown selection of available adapters grouped by status:
  - 🟢 **Running Adapters**: Currently active and ready to receive commands
  - 🟡 **Enabled Adapters**: Enabled but not currently running
  - 🔴 **Disabled Adapters**: Available but disabled
  - ✏️ **Custom / Manual Input**: Enter any adapter name manually
- Leave empty to use `msg.adapter` for dynamic targeting
- Examples: `telegram.0`, `email`, `sql.0`, `javascript.0`

**Command**
- Optional command parameter required by some adapters
- Common commands: `send`, `query`, `toScript`, `play`, `stop`
- Leave empty if adapter doesn't require a command
- Can be overridden by `msg.command`

**Static Message**
- Optional JSON message content to send to the adapter
- If empty, `msg.payload` will be used as the message content
- Must be valid JSON when specified
- Can be overridden by `msg.message`

**Wait for Response**
- **Disabled (Fire-and-forget)**: Send command without waiting for response
- **Enabled (Response mode)**: Wait for adapter response and send as output

**Response Timeout** (Response mode only)
- Maximum time to wait for adapter response (1000-60000 milliseconds)
- Default: 10000ms (10 seconds)
- Can be overridden by `msg.timeout`

## Dynamic Configuration

Override static settings using message properties:

### Dynamic Adapter Targeting
```javascript
msg.adapter = "telegram.0";
msg.payload = { text: "Hello!", user: "admin" };
```

### Dynamic Command Selection
```javascript
msg.adapter = "sql.0";
msg.command = "query";
msg.payload = "SELECT * FROM sensors WHERE timestamp > NOW() - INTERVAL 1 HOUR";
```

### Dynamic Message Content
```javascript
msg.adapter = "javascript.0";
msg.command = "toScript";
msg.message = {
    script: "myAutomationScript",
    data: { temperature: 25, humidity: 60 }
};
```

### Dynamic Response Timeout
```javascript
msg.adapter = "influxdb.0";
msg.command = "query";
msg.timeout = 30000; // 30 seconds for complex database queries
```

## Error Handling

### Common Error Scenarios
- **Adapter not found**: Specified adapter doesn't exist or isn't running
- **Invalid command**: Command not supported by the target adapter
- **Timeout**: Adapter didn't respond within the specified timeout period
- **Invalid message format**: Message content not compatible with adapter expectations
- **Permission denied**: Insufficient rights to execute command on adapter

### Error Response Format
When an error occurs, the output includes:
```javascript
{
    error: "Timeout waiting for response from telegram.0",
    adapter: "telegram.0",
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

### Adapter Not Responding
1. **Check adapter status** in ioBroker admin interface
2. **Verify adapter supports sendTo** functionality
3. **Test command manually** in ioBroker scripts or admin
4. **Check adapter logs** for error messages
5. **Restart adapter** if necessary

### Command Format Issues
1. **Review adapter documentation** for correct command format
2. **Test with minimal message** first
3. **Validate JSON syntax** in static messages
4. **Check parameter types** (string vs object vs array)
5. **Use adapter examples** from ioBroker community

## Related Nodes

- **WS ioB in**: Monitor adapter states and responses
- **WS ioB out**: Control adapter settings and configurations
- **WS ioB get**: Read adapter status and information
- **WS ioB log**: Monitor adapter log messages for debugging

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples and complete flow configurations.