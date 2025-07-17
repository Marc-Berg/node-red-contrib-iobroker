# Multiple States Feature - iob-in-evented Node

## Overview

The **Multiple States** feature allows a single `iob-in-evented` node to monitor and respond to changes in multiple ioBroker states simultaneously. This feature provides two output modes for handling multiple state changes.

## Configuration

### Input Mode
- **Single State / Wildcard Pattern**: Traditional mode for monitoring one state or wildcard pattern
- **Multiple States**: New mode for monitoring multiple specific states

### Multiple States Configuration
When **Multiple States** mode is selected:

1. **Multiple States Text Area**: Enter one state ID per line
   ```
   0_userdata.0.temperature
   0_userdata.0.humidity  
   0_userdata.0.pressure
   lights.living.state
   lights.kitchen.state
   ```

2. **Output Mode**: Choose how messages are delivered
   - **Individual Messages**: Each state change creates a separate message
   - **Grouped Object**: All current values in one message object

## Output Modes

### Individual Messages Mode
Each state change generates a separate Node-RED message:

```javascript
{
  topic: "0_userdata.0.temperature",
  payload: 23.5,
  ts: 1640995200000,
  ack: true,
  state: { /* complete ioBroker state object */ },
  timestamp: 1640995200123,
  multipleStatesMode: true
}
```

### Grouped Object Mode  
State changes trigger a message containing all current values:

```javascript
{
  topic: "grouped_states",
  payload: {
    "0_userdata.0.temperature": 23.5,
    "0_userdata.0.humidity": 65.2,
    "0_userdata.0.pressure": 1013.25
  },
  states: {
    "0_userdata.0.temperature": {
      value: 23.5,
      ts: 1640995200000,
      ack: true,
      state: { /* complete state object */ }
    },
    // ... other states
  },
  triggeredBy: "0_userdata.0.temperature", // which state caused this update
  timestamp: 1640995200123,
  multipleStatesMode: true,
  outputMode: "grouped"
}
```

## Initial Values

When **Send initial value on deploy** is enabled:

- **Individual Mode**: Sends initial value message for each configured state as they arrive
- **Grouped Mode**: Waits for ALL initial values before sending one grouped message with complete state snapshot

### Grouped Mode Initial Value Behavior

The grouped mode ensures you receive a complete snapshot of all monitored states:

1. **Complete Collection**: Waits for initial values from all configured states
2. **Timeout Protection**: If some states don't respond within 10 seconds, sends partial data marked with `partial: true`
3. **Single Message**: Only one initial message is sent containing all available values

Example grouped initial message:
```javascript
{
  topic: "grouped_states_initial",
  payload: {
    "0_userdata.0.temperature": 23.5,
    "0_userdata.0.humidity": 65.2,
    "0_userdata.0.pressure": 1013.25
  },
  initial: true,
  partial: false, // true if timeout occurred
  // ... complete state data
}
```

## Benefits

1. **Reduced Node Count**: Monitor multiple related states with one node
2. **Coordinated Updates**: Grouped mode provides snapshot of all monitored states
3. **Flexible Output**: Choose individual or grouped messages based on use case
4. **Consistent Filtering**: ACK filter applies to all monitored states

## Use Cases

### Individual Mode
- Monitoring multiple sensors where each needs separate processing
- Triggering different actions based on specific state changes
- Maintaining separate message flows per state

### Grouped Mode  
- Dashboard updates requiring current values of all monitored states
- Calculations needing multiple state values
- Reducing message frequency for related states
- Creating snapshots of system state

## Migration from Old Multiple States

The new implementation provides:
- Cleaner configuration through dedicated UI
- Better performance with event-based architecture
- More reliable message delivery
- Enhanced debugging capabilities

## Example Flows

See `examples/iob-in-evented-multiple.json` for complete working examples of both output modes.
