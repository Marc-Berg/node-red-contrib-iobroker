# WS ioB in - State Subscription

Subscribe to ioBroker state changes in real-time using WebSocket communication with support for single states, wildcard patterns, and multiple predefined states.

## Purpose

The WS ioB in node allows you to monitor ioBroker states and receive notifications whenever they change. It supports three input modes: single state monitoring, wildcard patterns for monitoring multiple states simultaneously, and multiple predefined states with flexible output formats.

## Input Modes

### Single State Mode
Monitor one specific state:
- **State**: `0_userdata.0.temperature`
- **Output**: Individual message per state change
- **Use Case**: Simple state monitoring

### Wildcard Pattern Mode (Auto-detected)
Monitor multiple states matching a pattern:
- **Pattern**: `system.adapter.*.alive`
- **Output**: Individual message per matching state change
- **Use Case**: Monitor related states dynamically
- **Auto-detection**: Automatically enabled when `*` is present

### Multiple States Mode
Monitor a predefined list of specific states:
- **Configuration**: List of exact state IDs (one per line)
- **Output Options**: Individual messages OR grouped object
- **Use Case**: Monitor specific related states efficiently

## Configuration

### Basic Settings

**Input Mode**
- **Single State / Wildcard Pattern**: Supporting one state or wildcard pattern
- **Multiple States**: Predefined list of states

#### Single State / Wildcard Configuration
**State ID / Pattern**
- Single state ID (e.g., `0_userdata.0.temperature`)
- Wildcard pattern (e.g., `system.adapter.*.alive`)
- Auto-detects wildcard mode when `*` is present

#### Multiple States Configuration
**Multiple States**
- Enter one state ID per line
- Supports exact state IDs only (no wildcards in this mode)
- Example:
  ```
  0_userdata.0.temperature
  0_userdata.0.humidity
  lights.living.state
  sensors.kitchen.temperature
  ```

**Output Mode** (Multiple States only)
- **Individual Messages**: Each state change creates separate message (like single mode)
- **Grouped Object**: All current values combined in single message object

### Common Settings

**Output Property**
- Target message property for the state value
- Default: `payload`
- Can be set to any valid message property

**Trigger On**
- **Both (ack and no-ack)**: Receive all state changes regardless of acknowledgment
- **Acknowledged only**: Only changes with `ack=true`
- **Unacknowledged only**: Only changes with `ack=false` (commands)

**Send Initial Value on Startup**
- When enabled, emits current state value(s) immediately after subscription
- **Single State**: Sends one initial message
- **Multiple States**: Sends all current values (individually or grouped based on output mode)
- **Wildcard**: Automatically disabled for performance reasons

## Output Message Formats

### Individual Messages (Single State, Wildcard, Multiple States Individual Mode)

Standard message format for each state change:

```javascript
{
  payload: 23.5,                    // State value
  topic: "0_userdata.0.temperature", // State ID
  timestamp: 1640995200000,         // Change timestamp
  state: {                          // Complete state object
    val: 23.5,
    ack: true,
    ts: 1640995200000,
    from: "system.adapter.javascript.0",
    lc: 1640995190000,
    q: 0
  }
}
```

**Additional Properties for Wildcard:**
- `pattern`: The original wildcard pattern that matched

**Additional Properties for Initial Values:**
- `initial`: `true` when message is an initial value

### Grouped Object (Multiple States Grouped Mode)

Single message containing all current values:

```javascript
{
  topic: "grouped_states",
  payload: {                        // All current state values
    "0_userdata.0.temperature": 23.5,
    "0_userdata.0.humidity": 65,
    "lights.living.state": true,
    "sensors.kitchen.temperature": 22.1
  },
  states: {                         // Complete state objects
    "0_userdata.0.temperature": {
      val: 23.5,
      ack: true,
      ts: 1640995200000,
      from: "system.adapter.javascript.0",
      lc: 1640995190000,
      q: 0
    },
    // ... other state objects
  },
  timestamp: 1640995200000,         // Message timestamp
  changedState: "0_userdata.0.temperature", // Which state triggered this message
  changedValue: 23.5,               // New value of changed state
  initial: true                     // Present for initial value messages
}
```

## Use Cases by Mode

### Single State Mode
- **Simple monitoring**: One specific sensor or device
- **Critical alerts**: Monitor single important state
- **Testing**: Quick state monitoring during development

### Wildcard Pattern Mode
- **Dynamic discovery**: Monitor states that may be added/removed
- **Category monitoring**: All states of specific type
- **System overview**: Monitor related system states

### Multiple States Mode
- **Dashboard data**: Fixed set of states for UI display
- **Related sensors**: Group of sensors in same room/category
- **System health**: Predefined list of critical system states

## Performance Considerations

### Message Frequency
- **Individual mode**: Can generate many messages with high-frequency states
- **Grouped mode**: Generates one message per any state change
- **Wildcard patterns**: Monitor count shown in node status

### Optimization Tips
- Use **specific patterns** instead of broad wildcards: `lights.*` vs `*`
- Choose **appropriate output mode** based on downstream processing needs
- **Limit scope** of wildcard patterns to reduce subscription count
- Use **grouped mode** for dashboard-type applications
- Consider **rate limiting** in downstream nodes for high-frequency states

## Initial Values Behavior

### Single State Mode
- Sends current value immediately after subscription
- Message includes `initial: true` property
- Respects ack filter settings

### Wildcard Pattern Mode
- **Automatically disabled** for performance reasons
- Many matching states could flood the system at startup
- Consider using **Multiple States mode** if initial values needed

### Multiple States Mode
- **Individual Output**: Sends separate initial message for each state
- **Grouped Output**: Sends single initial message with all current values
- Only sends initial values for states that actually exist and have values
- Includes `initial: true` property in messages

## Troubleshooting

### No Messages Received
1. **Check state exists** in ioBroker objects view
2. **Verify pattern syntax** for wildcards (only `*` supported)
3. **Test with simpler pattern** or single state first
4. **Check trigger settings** (all/ack/unack)

### Missing State Changes
1. **Check trigger filter** settings (all/ack/unack)
2. **Verify state actually changes** in ioBroker
3. **Test with different ack filter** to isolate issue

### Grouped Mode Issues
1. **Check all states exist** - non-existent states are skipped
2. **Verify state subscription** - check node status for subscription count
3. **Monitor initial values** - may not include states without values

## Connection Status

The node status indicator shows:
- **Green dot**: Connected and subscribed successfully
- **Yellow ring**: Connecting or reconnecting
- **Red ring**: Connection failed or authentication error
- **Number in status**: Count of active subscriptions (for wildcards/multiple states)

## Related Nodes

- **WS ioB out**: Send values to states
- **WS ioB get**: Read current state values
- **WS ioB inObj**: Monitor object changes

See [Common Use Cases](../use-cases.md) for practical implementation examples.
