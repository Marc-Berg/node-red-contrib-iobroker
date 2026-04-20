# WS ioB sendTo - Send Commands to Instances and Hosts

Send commands and messages to ioBroker adapter instances and hosts using `sendTo` and `sendToHost` for service integration, notifications, automation tasks, and log access.

## Purpose

The WS ioB sendTo node allows you to send commands directly to ioBroker adapter instances that support the `sendTo` interface. It can also send host-level commands using `sendToHost` when `msg.host` is provided. This enables integration with notification services, database operations, script execution, media control, and host functions such as reading ioBroker log files.

## Configuration

### Basic Settings

**Target Instance**
- Dropdown list of available adapter instances
- Leave empty to use `msg.instance` for dynamic targeting
- Leave empty when using host commands via `msg.host`
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

### Dynamic Host Targeting
```javascript
msg.host = "iobroker";
msg.command = "getLogs";
msg.payload = 200;
```

If `msg.host` is set, the node uses `sendToHost` instead of `sendTo`.

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

## Host Commands For Logs

The ioBroker controller exposes several host commands for reading logs.

### `getLogs`
Reads the currently active log file.

Input:
```javascript
msg.host = "iobroker";
msg.command = "getLogs";
msg.payload = 100; // number of lines
```

Normalized output:
```javascript
{
  payload: {
    lines: ["2026-04-20 09:20:59.927 - warn: ..."],
    size: 718
  },
  host: "iobroker",
  command: "getLogs"
}
```

### `getLogFiles`
Lists available log files for the host.

Input:
```javascript
msg.host = "iobroker";
msg.command = "getLogFiles";
msg.payload = {};
```

Normalized output:
```javascript
{
  payload: {
    files: [
      {
        path: "log/iobroker/file1/iobroker.2026-04-19.log.gz",
        name: "iobroker.2026-04-19.log.gz",
        host: "iobroker",
        transport: "file1",
        request: {
          transport: "file1",
          filename: "iobroker.2026-04-19.log.gz"
        },
        size: 994,
        gz: true,
        current: false
      }
    ],
    count: 1
  }
}
```

### `getLogFile`
Reads a specific log file. Use the exact filename from `getLogFiles`. For compressed `.gz` files, the node automatically decompresses the content into `payload.text`.

Input:
```javascript
msg.host = "iobroker";
msg.command = "getLogFile";
msg.payload = {
    transport: "file1",
    filename: "iobroker.2026-04-19.log.gz"
};
```

Normalized output:
```javascript
{
  payload: {
    data: [31, 139, 8, 0],
    gz: true,
    size: 994,
    text: "2026-04-19 12:34:56.789 - info: ...\n..."
  }
}
```

## Output (Response Mode)

When "Wait for Response" is enabled, the node outputs a structured response:
```javascript
{
  payload: <adapter response>,
  host: undefined,
  instance: "telegram.0",
  command: "send",
  originalMessage: { text: "Hello!", user: "admin" },
  responseTime: 42,            // in ms
  timestamp: 1690000000000
}
```

## Error Handling

### Common Error Scenarios
- **Instance not found**: Specified instance doesn't exist or isn't running
- **Host not found**: Specified host doesn't exist or isn't reachable
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

### Host Log Commands
1. Use `msg.host` instead of `msg.instance`
2. Enable response mode for `getLogs`, `getLogFiles`, and `getLogFile`
3. Use the exact filename returned by `getLogFiles`
4. For `getLogs`, note that only the currently active log file is read
5. For `.gz` log files, use `payload.text` from the normalized response

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

### Read Active Host Log
```javascript
msg.host = "iobroker";
msg.command = "getLogs";
msg.payload = 200;
return msg;
```

### List Log Files On Host
```javascript
msg.host = "iobroker";
msg.command = "getLogFiles";
msg.payload = {};
return msg;
```

### Read A Specific Compressed Log File
```javascript
msg.host = "iobroker";
msg.command = "getLogFile";
msg.payload = {
  transport: "file1",
  filename: "iobroker.2026-04-19.log.gz"
};
return msg;
```

See [Common Use Cases](../use-cases.md) for practical implementation examples and complete flow configurations.