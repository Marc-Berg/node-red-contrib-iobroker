# WS ioB setObject - Write Object Definitions

Write and update ioBroker object definitions (metadata) via WebSocket.

## Purpose

The WS ioB setObject node allows you to create or modify ioBroker object definitions, which contain metadata about states, devices, adapters, and other entities in your ioBroker installation.

## When to Use This Node

- **Modify adapter configurations:** Change settings like `native.publish` in MQTT adapter, `native.enabled` flags, etc.
- **Update object properties:** Change `common.name`, `common.role`, `common.unit`, and other metadata
- **Create new objects:** Dynamically create custom states or objects
- **Programmatic configuration:** Automate ioBroker configuration changes via flows

## Configuration

### Basic Settings

**Object ID**
- The ioBroker object identifier (e.g., `system.adapter.mqtt.0`)
- Leave empty to use `msg.objectId` for dynamic operation
- Examples: `javascript.0.myState`, `hue.0.lights.1`, `system.adapter.admin.0`

**Object Source**
- **msg.payload (complete object):** Object definition is in `msg.payload`
- **msg property (specify below):** Object is in a custom message property

**Object Property**
- Target property path when using "msg property" source
- Examples: `payload`, `data.object`, `modifiedObject`
- Supports nested properties with dot notation

**Mode**
- **Replace:** Completely overwrites the object with your definition
- **Merge:** Fetches existing object and merges only your changes

**Validate object structure**
- Ensures object has required properties (`type`, `common`) before writing
- Recommended to keep enabled to prevent invalid objects

### Server
- The ioBroker WebSocket server configuration

## Input Message

### msg.objectId (string, optional)
Target object ID to write. Overrides configured Object ID.

```javascript
msg.objectId = "system.adapter.mqtt.0";
```

### msg.payload or msg.[property] (object)
The object definition to write. Must contain:

```javascript
{
  type: "state",           // Required: Object type
  common: {                // Required: Common properties
    name: "My State",
    type: "boolean",
    role: "switch",
    read: true,
    write: true
  },
  native: {}              // Optional: Adapter-specific properties
}
```

## Output Message

### Success Output

```javascript
{
  payload: {
    success: true,
    objectId: "system.adapter.mqtt.0",
    object: { /* written object definition */ }
  },
  objectId: "system.adapter.mqtt.0",
  timestamp: 1234567890
}
```

## Modes Explained

### Replace Mode

**When to use:**
- Creating new objects
- Complete object replacement
- When you have the full object definition

**Behavior:**
- Completely overwrites the existing object
- You must provide all required properties
- Previous object data is lost

**Example:**
```javascript
msg.objectId = "javascript.0.myState";
msg.payload = {
  type: "state",
  common: {
    name: "My Custom State",
    type: "number",
    role: "value",
    read: true,
    write: true,
    unit: "°C"
  },
  native: {}
};
// Connect to iob-setobject in replace mode
```

### Merge Mode

**When to use:**
- Changing single properties
- Updating adapter configurations
- Partial object updates
- Preserving existing settings

**Behavior:**
- Fetches existing object first
- Deep merges your changes with existing data
- Only specified properties are updated
- Unspecified properties remain unchanged

**Example:**
```javascript
// Only change the publish pattern in MQTT adapter
msg.objectId = "system.adapter.mqtt.0";
msg.payload = {
  native: {
    publish: "mqtt.0.*, system.*"
  }
};
// All other properties (patterns, enabled, etc.) are preserved
```

## Use Cases

### 1. Modify MQTT Adapter Configuration

**Flow: Get → Modify → Write**

```
[iob-getobject] → [function] → [iob-setobject]
```

**Function node code:**
```javascript
// Get current config, modify it, write back
msg.payload.native.publish = "mqtt.0.*, system.adapter.*";
msg.payload.native.patterns = "sensor/#, actuator/#";
msg.payload.native.enabled = true;
return msg;
```

**iob-setobject settings:**
- Mode: **Merge** (preserves other settings)
- Object ID: Leave empty (uses ID from getobject)

### 2. Update Object Name

```javascript
msg.objectId = "hue.0.lights.livingroom";
msg.payload = {
  common: {
    name: "Living Room Light - Updated Name"
  }
};
// Use merge mode
```

### 3. Create Custom State

```javascript
msg.objectId = "javascript.0.sensors.temperature";
msg.payload = {
  type: "state",
  common: {
    name: "Temperature Sensor",
    type: "number",
    role: "value.temperature",
    read: true,
    write: false,
    unit: "°C",
    min: -50,
    max: 100
  },
  native: {}
};
// Use replace mode for new objects
```

### 4. Enable/Disable Adapter

```javascript
msg.objectId = "system.adapter.hue.0";
msg.payload = {
  common: {
    enabled: false  // Disable adapter
  }
};
// Use merge mode
// Note: Adapter automatically restarts when configuration is changed
```

### 5. Change State Role and Unit

```javascript
msg.objectId = "mqtt.0.sensor.temperature";
msg.payload = {
  common: {
    role: "value.temperature",
    unit: "°F",  // Change from °C to °F
    name: "Temperature (Fahrenheit)"
  }
};
// Use merge mode
```

### 6. Batch Update with Loop

```javascript
// Update multiple objects
const objectIds = [
  "javascript.0.room1.temp",
  "javascript.0.room2.temp",
  "javascript.0.room3.temp"
];

const messages = objectIds.map(id => ({
  objectId: id,
  payload: {
    common: {
      unit: "°C",
      role: "value.temperature"
    }
  }
}));

return [messages];  // Send as array to process one by one
```

## Object Structure Reference

### Common Object Types

**state** - Data point (sensor value, switch, etc.)
```javascript
{
  type: "state",
  common: {
    name: "State Name",
    type: "number",          // boolean, number, string, object, array
    role: "value",           // See role list below
    read: true,
    write: false,
    unit: "°C"
  },
  native: {}
}
```

**channel** - Group of states
```javascript
{
  type: "channel",
  common: {
    name: "Channel Name",
    role: "sensor"
  },
  native: {}
}
```

**device** - Physical or logical device
```javascript
{
  type: "device",
  common: {
    name: "Device Name",
    role: "device"
  },
  native: {}
}
```

**adapter/instance** - Adapter configuration
```javascript
{
  type: "instance",
  common: {
    name: "Adapter Name",
    enabled: true,
    mode: "daemon"
  },
  native: {
    // Adapter-specific configuration
  }
}
```

### Common Roles (examples)

**Sensors:**
- `value.temperature`
- `value.humidity`
- `value.pressure`
- `value.brightness`

**Switches:**
- `switch`
- `switch.light`
- `switch.power`

**Buttons:**
- `button`
- `button.play`
- `button.stop`

**Indicators:**
- `indicator`
- `indicator.alarm`
- `indicator.connected`

## Important Notes

### Adapter Configuration Changes

When modifying adapter objects (e.g., `system.adapter.mqtt.0`):
1. The adapter **automatically restarts** when its configuration is changed - no manual restart needed
2. Some settings require adapter reconfiguration
3. Always test configuration changes in a safe environment first

### Object Validation

With validation enabled, the node checks for:
- Required `type` property
- Required `common` object
- Valid object structure

Disable validation only if you know the object structure is valid.

### Backup Important Objects

Before modifying critical objects:
1. Use `iob-getobject` to backup the current state
2. Store the backup in a file or database
3. Test your changes
4. Restore if needed using the backup

### The _id Property

The `_id` property is automatically removed from object definitions before writing, as ioBroker's `setObject` API expects the ID as a parameter, not in the object definition itself.

## Error Handling

### Common Errors

**"Object ID missing"**
- Solution: Provide Object ID in configuration or `msg.objectId`

**"Object not found at msg.payload"**
- Solution: Ensure object source setting matches your message structure

**"Invalid object: must have 'type' property"**
- Solution: Add required `type` property to object definition

**"Invalid object: must have 'common' property"**
- Solution: Add required `common` object to definition

**"Write failed"**
- Check connection to ioBroker server
- Verify object ID format is correct
- Check ioBroker logs for details

### Debugging Tips

1. Use a debug node after `iob-getobject` to inspect object structure
2. Test with merge mode first to avoid data loss
3. Enable validation to catch structural errors early
4. Check node status for connection and operation status

## Complete Example Flow

**Goal:** Change MQTT adapter publish pattern

```json
[
  {
    "type": "inject",
    "name": "Trigger",
    "wires": [["getobject"]]
  },
  {
    "id": "getobject",
    "type": "iobgetobject",
    "objectId": "system.adapter.mqtt.0",
    "server": "iob-server",
    "wires": [["modify"]]
  },
  {
    "id": "modify",
    "type": "function",
    "func": "msg.payload.native.publish = 'mqtt.0.*';\nreturn msg;",
    "wires": [["setobject", "debug1"]]
  },
  {
    "id": "setobject",
    "type": "iobsetobject",
    "mergeMode": "merge",
    "server": "iob-server",
    "wires": [["debug2"]]
  }
]
```

## Performance Considerations

- **Merge mode** requires an additional read operation (getObject) before writing
- Use **replace mode** when creating new objects or when you have complete definitions
- Batch updates using loops may take time - consider rate limiting for many objects
- Object writes are generally fast (<100ms) but depend on server load

## Security Considerations

- Modifying adapter configurations can affect system behavior
- Some objects require admin permissions
- Always validate user input before writing objects
- Consider implementing user authentication for flows that modify objects

## Related Nodes

- **iob-getobject:** Read object definitions
- **iob-out:** Write state values (not objects)
- **iob-get:** Read state values
- **iob-sendto:** Send commands to adapters

## Additional Resources

- [ioBroker Object Schema Documentation](https://www.iobroker.net/#en/documentation/dev/objectsschema.md)
- [ioBroker Adapter Development](https://www.iobroker.net/#en/documentation/dev/adapterdev.md)
- [ioBroker API Documentation](https://github.com/ioBroker/ioBroker.js-controller/blob/master/doc/SCHEMA.md)
