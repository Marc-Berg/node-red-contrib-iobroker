# External Triggering - Dynamic Topic Switching

The iob-in node supports **External Triggering** with three modes:

## 1. Cached Value Triggering (existing)
Sends the last received value again without changing the subscription.

## 2. Dynamic Topic Switching (Single Mode)
Switches to a new state/topic and then receives updates from that new state.

## 3. Dynamic Topics Array (Multiple Mode)
Switches to a new array of states and then receives updates from all new states.

---

## Configuration

### Set up the iob-in node
1. Enable **Enable external triggering**
2. Enter a **Trigger Group** name (for example: `iobroker_in_nodes`)
3. Select an **Input Mode**:
    - `single` -> `triggerWithTopic()` is available
    - `multiple` -> `triggerWithTopicArray()` is available
    - wildcard -> only `triggerCached()` is available

### Node registration
When external triggering is enabled, the node registers itself in flow context:
```javascript
{
     nodeRef: node,                               // Reference to the node
     triggerCached: function(),                   // Sends cached value
     triggerWithTopic: async function(topic),     // Switches to new topic (single only)
     triggerWithTopicArray: async function(array),// Switches to new array (multiple only)
    supportsDynamicTopic: true/false,            // Single Mode Capability Flag
    supportsDynamicArray: true/false,            // Multiple Mode Capability Flag
    states: ['current.state.id'],
    mode: 'single' | 'multiple',
    name: 'Node Name',
    // ...
}
```

---

## Usage

### Call from a Function node

#### Send cached value
```javascript
// Read flow context
const nodes = flow.get('iobroker_in_nodes') || {};

// Find node (ID of iob-in node)
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.triggerCached) {
    // Send cached value again
    targetNode.triggerCached();
}
```

#### Switch to a new topic
```javascript
// Read flow context
const nodes = flow.get('iobroker_in_nodes') || {};

// Find node
const targetNode = nodes['<NODE_ID>'];

// Check whether dynamic topic switching is supported
if (targetNode && targetNode.supportsDynamicTopic) {
    // Async: switch to a new state
    await targetNode.triggerWithTopic('system.adapter.hm-rpc.0.alive');
} else {
    node.warn('Dynamic topic switching not supported (wildcard or multiple mode)');
}
```

#### Use new topic from msg.topic
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.supportsDynamicTopic && msg.topic) {
    await targetNode.triggerWithTopic(msg.topic);
}
```

### Multiple Mode (Array of States)

#### Switch to a new topic array
```javascript
// Read flow context
const nodes = flow.get('iobroker_in_nodes') || {};

// Find node
const targetNode = nodes['<NODE_ID>'];

// Check whether dynamic array switching is supported
if (targetNode && targetNode.supportsDynamicArray) {
    // Async: switch to a new state array
    const newTopics = [
        'system.adapter.admin.0.alive',
        'system.adapter.admin.0.connected',
        'system.adapter.admin.0.memRss'
    ];

    // Optional: change output mode
    const outputMode = 'grouped'; // or 'individual' or undefined
    
    await targetNode.triggerWithTopicArray(newTopics, outputMode);
} else {
    node.warn('Dynamic array switching not supported (not in multiple mode)');
}
```

#### Use new array from msg.payload
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};
const targetNode = nodes['<NODE_ID>'];

if (targetNode && targetNode.supportsDynamicArray && Array.isArray(msg.payload)) {
    await targetNode.triggerWithTopicArray(msg.payload);
}
```

---

## Use Cases

### Single Mode Use Cases

### 1. Dashboard with room selection
User selects a room -> node switches to the temperature state of that room:
```javascript
// msg.room = 'living_room' | 'bedroom' | 'kitchen'
const stateId = `0_userdata.0.temperature.${msg.room}`;

await targetNode.triggerWithTopic(stateId);
```

### 2. Adapter monitoring via dropdown
User selects an adapter -> node switches to the `.alive` state of that adapter:
```javascript
// msg.adapter = 'admin.0' | 'hm-rpc.0' | 'sql.0'
const aliveState = `system.adapter.${msg.adapter}.alive`;

await targetNode.triggerWithTopic(aliveState);
```

### 3. Dynamic device monitoring
Switch between devices that share the same structure:
```javascript
// msg.deviceId = 'device_001' | 'device_002'
const deviceState = `hm-rpc.0.${msg.deviceId}.STATE`;

await targetNode.triggerWithTopic(deviceState);
```

### 4. Context-aware monitoring
Switch based on user preferences or system status:
```javascript
// Different states based on time of day
const now = new Date().getHours();
const stateId = now < 12 
    ? '0_userdata.0.morning_temperature'
    : '0_userdata.0.evening_temperature';

await targetNode.triggerWithTopic(stateId);
```

### Multiple Mode Use Cases

### 5. Dashboard with adapter group selection
User selects an adapter group -> node switches to all states in that group:
```javascript
// msg.group = 'system' | 'hvac' | 'security'
const groups = {
    system: [
        'system.adapter.admin.0.alive',
        'system.adapter.admin.0.connected',
        'system.host.nuc.cpuPercent'
    ],
    hvac: [
        'hm-rpc.0.thermostat_1.ACTUAL_TEMPERATURE',
        'hm-rpc.0.thermostat_1.SET_TEMPERATURE',
        'hm-rpc.0.thermostat_2.ACTUAL_TEMPERATURE'
    ],
    security: [
        'hm-rpc.0.door_sensor_1.STATE',
        'hm-rpc.0.window_sensor_1.STATE',
        'hm-rpc.0.motion_sensor_1.MOTION'
    ]
};

await targetNode.triggerWithTopicArray(groups[msg.group]);
```

### 6. Dynamic device list
Build a runtime list of devices and monitor all corresponding states:
```javascript
// msg.deviceIds = ['device_001', 'device_002', 'device_003']
const stateIds = msg.deviceIds.map(id => `hm-rpc.0.${id}.STATE`);

await targetNode.triggerWithTopicArray(stateIds, 'grouped');
```

### 7. Multi-room monitoring
Switch between different room configurations:
```javascript
// msg.rooms = ['living_room', 'bedroom', 'kitchen']
const stateIds = msg.rooms.flatMap(room => [
    `0_userdata.0.${room}.temperature`,
    `0_userdata.0.${room}.humidity`,
    `0_userdata.0.${room}.presence`
]);

await targetNode.triggerWithTopicArray(stateIds, 'individual');
```

---

## Limitations

### Supported
- **Single State Mode**: `state: 'system.adapter.admin.0.alive'` -> `triggerWithTopic()`
- **Multiple States Mode**: list of states -> `triggerWithTopicArray()`
- Fixed state IDs (no wildcards)
- Environment variables in configured states
- Output mode switching in multiple mode (`individual` <-> `grouped`)

### Not supported
- **Wildcard Patterns**: `state: 'system.adapter.*.alive'`
- **Mode switching**: switching between single and multiple mode at runtime
- Wildcards in dynamic arrays

### Validate before use
```javascript
// Single Mode
if (!targetNode.supportsDynamicTopic) {
    node.warn('Node is in wildcard or multiple mode - single topic switching not available');
    return;
}

// Multiple Mode
if (!targetNode.supportsDynamicArray) {
    node.warn('Node is in single or wildcard mode - array switching not available');
    return;
}
```

---

## Topic switching flow

### Single Mode
1. **Status Update**: "Switching to: new.state.id"
2. **Unsubscribe**: Ends the previous subscription
3. **State Clear**: Clears cached state
4. **Subscribe**: Activates the new subscription
5. **Smart Filter**: For `filterMode: 'changes-smart'`, preloads baseline
6. **Initial Value**: Sends first value automatically
7. **Status Update**: Shows the new state
8. **Context Update**: Updates flow context

### Multiple Mode
1. **Status Update**: "Switching to X states..."
2. **Unsubscribe**: Ends previous subscriptions
3. **State Clear**: Clears cached state
4. **Subscribe**: Activates new subscriptions (with forced initial)
5. **Smart Filter**: For `filterMode: 'changes-smart'`, preloads baselines
6. **Initial Values**: Sends first values automatically
7. **Status Update**: Shows number of states
8. **Context Update**: Updates flow context

---

## Error handling

### Node not found
```javascript
const targetNode = nodes['<NODE_ID>'];
if (!targetNode) {
    node.warn('Node not found - check Node ID and External Triggering enabled');
    return;
}
```

### Unsupported mode
```javascript
if (!targetNode.supportsDynamicTopic) {
    node.error('Dynamic topic switching not supported for this node configuration');
    return;
}
```

### Invalid topic
```javascript
const newTopic = msg.topic;
if (!newTopic || typeof newTopic !== 'string') {
    node.error('Invalid topic: must be non-empty string');
    return;
}
```

### Subscription error
```javascript
try {
    await targetNode.triggerWithTopic(newTopic);
} catch (error) {
    node.error(`Failed to switch topic: ${error.message}`);
}
```

---

## Example flow

See [iob-in-dynamic-trigger.json](../examples/iob-in-dynamic-trigger.json)
See [iob-in-dynamic-trigger-subflow.json](../examples/iob-in-dynamic-trigger-subflow.json)

The example flow demonstrates:
- Cached Value Trigger
- Topic switching across different states
- Listing registered nodes
- Feature-Detection (`supportsDynamicTopic`)

The subflow example demonstrates:
- Reusable trigger logic as a Subflow helper
- Success/error outputs for better flow control
- Target selection via `msg.targetName` or `msg.targetId`

---

## Debugging

### Show all registered nodes
```javascript
const nodes = flow.get('iobroker_in_nodes') || {};

for (const [nodeId, info] of Object.entries(nodes)) {
    node.warn(`Node ${info.name}:`);
    node.warn(`  - Mode: ${info.mode}`);
    node.warn(`  - Current State: ${info.stateId}`);
    node.warn(`  - Supports Dynamic: ${info.supportsDynamicTopic}`);
}
```

### Check node logs
The iob-in node logs:
```
[debug] Unsubscribed from: old.state.id
[debug] Subscribed to: new.state.id
[debug] Smart filter: Pre-loaded new.state.id = <value>
```

### Observe node status
During topic switching, node status changes:
- **Yellow/Ring**: "Switching to: new.state.id"
- **Green/Dot**: Shows new value or state name
- **Red/Ring**: "Switch failed" when an error occurs

---

## Benefits compared to iob-get

| Feature | iob-get (Pull) | iob-in + Dynamic Trigger |
|---------|---------------|--------------------------|
| **Data mode** | On-demand query | Continuous push |
| **Performance** | Requires polling | Automatic updates |
| **Latency** | Depends on poll interval | Real-time |
| **Bandwidth** | Higher (with frequent polling) | Lower (only on change) |
| **Dynamic Topic** | ✅ Via msg.topic | ✅ Via triggerWithTopic() |

**Recommendation:**
- **iob-get**: For one-time queries or infrequent reads
- **iob-in + Dynamic Trigger**: For continuous monitoring with changing targets
