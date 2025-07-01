# WS ioB in - State Subscription

Subscribe to ioBroker state changes in real-time using WebSocket communication.

## Purpose

The WS ioB in node allows you to monitor ioBroker states and receive notifications whenever they change. It supports both single state monitoring and wildcard patterns for monitoring multiple states simultaneously.

## Configuration

### Basic Settings

**State**
- Single state ID (e.g., `0_userdata.0.temperature`)
- Wildcard pattern (e.g., `system.adapter.*.alive`)
- Can be overridden by `msg.topic` in incoming messages

**Output Property**
- Target message property for the state value
- Default: `payload`
- Can be set to any valid message property

**Trigger On**
- **All updates**: Receive all state changes regardless of acknowledgment
- **Acknowledged only**: Only changes with `ack=true`
- **Unacknowledged only**: Only changes with `ack=false` (commands)

**Send Initial Value**
- When enabled, emits current state value immediately after subscription
- Useful for initialization of downstream nodes

## Wildcard Patterns

### Single Level Wildcards
Use `*` to match any single level in the state hierarchy:

- `system.adapter.*.alive` - All adapter alive states
- `lights.*.state` - All light states in any room
- `0_userdata.0.*` - All states under 0_userdata.0

### Multi-Level Wildcards
Use `**` to match multiple levels:

- `system.**` - All system states at any depth
- `**.temperature` - All temperature states anywhere

### Pattern Examples

**Monitor All Adapters**
```
system.adapter.*.alive
system.adapter.*.connected
system.adapter.*.memRss
```

**Monitor Smart Home Devices**
```
lights.*.state
switches.*.state
sensors.*.temperature
```

**Monitor User Data**
```
0_userdata.0.*
javascript.0.*
```

## Output Message Format

The node outputs a message with the following structure:

**Standard Properties:**
- `payload`: The state value (number, string, boolean, object)
- `topic`: The complete state ID
- `timestamp`: Unix timestamp of the change

**State Object:**
Complete ioBroker state information in `msg.state`:
- `val`: The actual value
- `ack`: Acknowledgment flag (true/false)
- `ts`: Timestamp in milliseconds
- `from`: Source that changed the state
- `lc`: Last change timestamp
- `q`: Quality indicator (0=good, others indicate issues)

**Example Output:**
```
{
  payload: 23.5,
  topic: "0_userdata.0.temperature",
  timestamp: 1640995200000,
  state: {
    val: 23.5,
    ack: true,
    ts: 1640995200000,
    from: "system.adapter.javascript.0",
    lc: 1640995190000,
    q: 0
  }
}
```

## Advanced Usage

### Dynamic Subscription
Change subscription at runtime by sending a message with `msg.topic` set to the new state pattern:

```
msg.topic = "system.adapter.admin.*";
return msg;
```

### Quality Filtering
Use the quality indicator in `msg.state.q` to filter unreliable readings:
- `0`: Good quality
- `1`: General problem
- `2`: No connection to device
- `16`: Substitute value
- `64`: Not supported
- `128`: Device not connected

### State Validation
Check acknowledgment status to distinguish between values and commands:
- `ack: true` - Confirmed value from device
- `ack: false` - Command sent to device

## Performance Considerations

### Wildcard Optimization
- **Specific patterns**: Use `lights.*` instead of `*` when possible
- **Limit scope**: Avoid overly broad patterns like `*` or `**`
- **Monitor count**: Check node status for active subscription count

### Message Frequency
- High-frequency states may flood downstream nodes
- Consider using rate limiting or change detection in flow
- Monitor Node-RED memory usage with many subscriptions

### Connection Efficiency
- Multiple nodes can share the same ioBroker connection
- Wildcard patterns are more efficient than multiple single subscriptions
- Connection status is shown in node status indicator

## Troubleshooting

### No Messages Received
1. Check state exists in ioBroker objects view
2. Verify wildcard pattern syntax
3. Confirm WebSocket connection is established
4. Test with simpler pattern first

### Missing State Changes
1. Check trigger settings (all/ack/unack)
2. Verify state actually changes in ioBroker
3. Look for quality issues in state object
4. Check if state has logging enabled

### High CPU Usage
1. Reduce wildcard scope
2. Implement message filtering
3. Check for rapid state changes
4. Monitor subscription count

### Connection Issues
1. Verify ioBroker WebSocket adapter is running
2. Check network connectivity
3. Confirm authentication if required
4. Review ioBroker logs for errors

## Related Nodes

- **WS ioB out**: Send values to states
- **WS ioB get**: Read current state values
- **WS ioB inObj**: Monitor object changes

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.