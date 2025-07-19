# WS ioB in - State Subscription

Subscribe to ioBroker state changes in real-time using WebSocket communication with support for single states, wildcard patterns, multiple predefined states, and value change filtering.

## Input Modes

### Single State Mode
- **State**: `0_userdata.0.temperature`  
- **Use Case**: Simple state monitoring, critical alerts, testing

### Wildcard Pattern Mode (Auto-detected)
- **Pattern**: `system.adapter.*.alive`
- **Use Case**: Monitor related states dynamically, category monitoring
- **Auto-detection**: Automatically enabled when `*` is present

### Multiple States Mode
- **Configuration**: List of exact state IDs (one per line)
- **Output Options**: Individual messages OR grouped object
- **Use Case**: Dashboard data, related sensors, system health monitoring

## State vs Value Changes

**State Update**: Any change to the state object (timestamp, quality, source, acknowledge, etc.)
```javascript
// Only timestamp changed, value stays the same
{ val: 23.5, ts: 1640995200000, ack: true }  // Before
{ val: 23.5, ts: 1640995210000, ack: true }  // After (timestamp-only update)

// Only metadata changed, value stays the same  
{ val: 23.5, ts: 1640995200000, from: "adapter.0" }  // Before
{ val: 23.5, ts: 1640995210000, from: "adapter.1" }  // After (source changed)
```

**Value Update**: The actual `val` property changes
```javascript
// Value actually changed
{ val: 23.5, ts: 1640995200000, ack: true }  // Before  
{ val: 24.1, ts: 1640995210000, ack: true }  // After
```

**Note**: Pure timestamp updates (same value, only `ts` changed) are very common in ioBroker and count as metadata-only changes.

## Value Change Filtering

### Filter Modes

**Send all events** (Default)
- Every **state update** triggers a message (metadata changes too)
- Use for: Real-time monitoring, debugging, systems needing all timestamp/ack info

**Send only value changes**
- Only sends when **value actually changes** (ignores metadata-only updates)
- First change always sent (no baseline), subsequent identical values blocked
- Use for: Reducing message volume, high-frequency sensors, battery-powered devices

**Send only value changes (with baseline)**
- Pre-loads current value as baseline, only sends actual **value changes**
- First change may be blocked if same as current value
- Use for: Consistent behavior across restarts, clean change detection

### Value Comparison
- **Filtering compares only `state.val`** - metadata changes are ignored
- **Primitive values**: Direct equality comparison
- **Objects/arrays**: Deep comparison using JSON serialization
- **Initial values always bypass filtering** for reliable startup

## Configuration

### Basic Settings

**Input Mode**
- Single State / Wildcard Pattern
- Multiple States

**State ID / Pattern** (Single Mode)
- Single state ID: `0_userdata.0.temperature`
- Wildcard pattern: `system.adapter.*.alive`

**Multiple States** (Multiple Mode)
```
0_userdata.0.temperature
0_userdata.0.humidity
lights.living.state
```

**Output Mode** (Multiple States only)
- **Individual Messages**: Each change creates separate message
- **Grouped Object**: All current values in single message

### Filter & Trigger Settings

**Filter Mode**
- Send all events / Send only value changes / Send only value changes (with baseline)

**Trigger On**
- Both (ack and no-ack) / Acknowledged only / Unacknowledged only

**Send Initial Value on Startup**
- Single State: Sends one initial message
- Multiple States: Sends all current values (individual or grouped)
- Wildcard: Automatically disabled for performance

**Output Property**
- Target message property for state value (default: `payload`)

## Output Message Formats

### Individual Messages
```javascript
{
  payload: 23.5,
  topic: "0_userdata.0.temperature",
  timestamp: 1640995200000,
  state: { val: 23.5, ack: true, ts: 1640995200000, ... },
  pattern: "system.adapter.*",  // Only for wildcards
  initial: true                 // Only for initial values
}
```

### Grouped Object (Multiple States)
```javascript
{
  topic: "grouped_states",
  payload: {
    "0_userdata.0.temperature": 23.5,
    "0_userdata.0.humidity": 65
  },
  states: { /* Complete state objects */ },
  timestamp: 1640995200000,
  changedState: "0_userdata.0.temperature",
  changedValue: 23.5,
  initial: true  // For initial values
}
```

## Filter Mode Comparison

**State vs Value Changes Example**:
```
Current state: { val: 25, ts: 1000, ack: true }

1. Timestamp update: { val: 25, ts: 1001, ack: true }
   - Send all events: SENT (state changed)
   - Value filters: BLOCKED (value unchanged)

2. Metadata update: { val: 25, ts: 1002, from: "adapter.1" }
   - Send all events: SENT (state changed)
   - Value filters: BLOCKED (value unchanged)

3. Value update: { val: 26, ts: 1003, ack: true }
   - Send all events: SENT (state changed)  
   - Value filters: SENT (value changed)
```

**Without "Send initial value"** (Current value: 25):

```
Send only value changes:
1. First value change: 25 → SENT (no baseline)
2. Timestamp update: 25 → BLOCKED (same value)
3. Second value change: 25 → BLOCKED (same value)
4. Third value change: 26 → SENT (value changed)

Send only value changes (with baseline):
1. Startup: Load baseline 25 (stored, not sent)
2. Timestamp update: 25 → BLOCKED (same value)
3. First value change: 25 → BLOCKED (same as baseline)
4. Second value change: 26 → SENT (value changed)
```

**With "Send initial value"**: Both modes behave identically (initial values bypass filtering).

## Performance & Optimization

### Tips
- Use **specific patterns**: `lights.*` vs `*`
- Choose **appropriate output mode** for your use case
- Consider **change filtering** for high-frequency/stable states
- Use **grouped mode** for dashboard applications
- **Rate limit** downstream for remaining high-frequency states

## External Triggering

External triggering allows Function nodes or other components to request resending of cached state values without waiting for state changes. This feature enables dashboard refresh scenarios, scheduled updates, and manual value retrieval.

### Configuration

**Enable external triggering** (Default: true)
- Enables the external triggering feature

**Trigger Group** (Default: "iobroker_in_nodes")  
- Custom group name for organizing triggerable nodes
- Function nodes can access this group via flow context

### Usage in Function Node

#### Trigger All Nodes in Default Group
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};

// Trigger all nodes in the group
Object.values(nodes).forEach(nodeInfo => {
    nodeInfo.triggerCached();
});
```

#### Use Custom Groups
```javascript
const dashboardNodes = flow.get('dashboard_sensors') || {};
Object.values(dashboardNodes).forEach(nodeInfo => {
    nodeInfo.triggerCached();
});
```

#### Find Nodes by State ID (Single Mode)
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};

Object.values(nodes).forEach(nodeInfo => {
    if (nodeInfo.stateId === '0_userdata.0.temperature') {
        nodeInfo.triggerCached();
    }
});
```

#### Find Nodes by Name
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};

Object.values(nodes).forEach(nodeInfo => {
    if (nodeInfo.name?.includes('[Dashboard]')) {
        nodeInfo.triggerCached();
    }
});
```

### Node Information Object

Each registered node provides this information:

```javascript
{
  nodeRef: [object],           // Reference to the node
  triggerCached: [function],   // Function to trigger cached values
  states: [array],             // Array of state IDs
  mode: 'single'|'multiple',   // Input mode
  name: 'Node Name',           // Node name or auto-generated
  outputMode: 'individual'|'grouped',  // Output mode (multiple states)
  stateId: 'state.id',         // State ID (single mode only)
  group: 'group_name'          // Trigger group name
}
```

### Use Cases

#### Dashboard Refresh
```javascript
// Refresh all dashboard-relevant nodes after browser refresh
const dashboardNodes = flow.get('dashboard_sensors') || {};
Object.values(dashboardNodes).forEach(nodeInfo => {
    nodeInfo.triggerCached();
});
```

#### Scheduled Updates
```javascript
// Periodic resending of current values (e.g., every 5 minutes)
const nodes = flow.get('iobroker_in_nodes') || {};
Object.values(nodes).forEach(nodeInfo => {
    if (nodeInfo.name?.includes('sensor')) {
        nodeInfo.triggerCached();
    }
});
```

#### Manual Triggers
```javascript
// Button-activated value refresh
const nodes = flow.get('iobroker_in_nodes') || {};
const temperatureNodes = Object.values(nodes).filter(node => 
    node.states?.some(state => state.includes('temperature'))
);

temperatureNodes.forEach(nodeInfo => {
    nodeInfo.triggerCached();
});
```

## Troubleshooting

### No Messages Received
1. Check state exists in ioBroker
2. Verify wildcard syntax (only `*` supported)  
3. Test with simpler pattern first
4. Check trigger settings (all/ack/unack)
5. Try "Send all events" to test filtering

### Missing State Changes
1. Verify trigger filter settings
2. Check state actually changes in ioBroker
3. Ensure values are actually different
4. Compare filter modes to understand behavior

### Change Filtering Issues
1. Ensure correct filter mode for use case
2. Monitor node status for [Changes] indicator
3. Test with "Send all events" first
4. Check data types for complex objects

### External Triggering Issues
1. Verify "Enable external triggering" is checked
2. Check correct trigger group name in Function node
3. Ensure nodes are registered: `Object.keys(flow.get('group_name'))`
4. Test with simple trigger: `Object.values(flow.get('iobroker_in_nodes')).forEach(n => n.triggerCached())`
5. Check node logs for registration messages
6. Verify Function node has access to flow context

## Connection Status

- **Green dot**: Connected and subscribed
- **Yellow ring**: Connecting/reconnecting
- **Red ring**: Connection/authentication failed
- **[Changes] label**: Active value change filtering
- **Number**: Active subscription count (wildcards/multiple states)

## Related Nodes

- **WS ioB out**: Send values to states
- **WS ioB get**: Read current state values  
- **WS ioB inObj**: Monitor object changes