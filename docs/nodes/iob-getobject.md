# WS ioB getObject - Object Getter

Retrieve ioBroker object definitions and metadata with support for wildcard patterns and multiple output formats.

## Purpose

The WS ioB getObject node allows you to retrieve ioBroker object definitions, which contain metadata about states, devices, adapters, and other ioBroker entities. This is useful for discovering available states, reading device configurations, and understanding object structures.

## Configuration

### Basic Settings

**Object ID**
- Single object ID (e.g., `system.adapter.admin.0`)
- Wildcard pattern (e.g., `system.adapter.*`)
- Leave empty to use `msg.topic` for dynamic selection

**Output Property**
- Target message property for the retrieved object(s)
- Default: `payload`
- Can be set to any valid message property

**Output Format**
- **Single Object**: Returns object directly (for single matches)
- **Array**: Returns array of objects
- **Object Map**: Returns `{objectId: object}` mapping

## Object Types

### System Objects
**Adapter Objects**
- `system.adapter.admin.0` - Admin adapter instance
- `system.adapter.*` - All adapter instances
- `system.adapter.*.alive` - Adapter alive states

**Host Objects**
- `system.host.hostname` - Host system information
- `system.host.versions` - Node versions

**Configuration Objects**
- `system.config` - System configuration
- `system.certificates` - SSL certificates

### Device Objects
**Device Instances**
- `hue.0.lights.1` - Philips Hue light device
- `sonoff.0.DVES_123456` - Sonoff device
- `zigbee.0.00158d00023a5b7c` - Zigbee device

**Channel Objects**
- `hue.0.lights` - Light device channel
- `homematic.0.BidCos-RF.NEQ1234567` - HomeMatic channel

### State Objects
**Data Points**
- `0_userdata.0.temperature` - User-defined state
- `javascript.0.myScript` - JavaScript variable
- `hue.0.lights.1.state` - Device state

### Pattern Examples

**Discover Adapters**
```
system.adapter.*          // All adapter instances
system.adapter.*.alive    // Adapter status states
system.adapter.hue.*      // All Hue adapter objects
```

**Find Device Objects**
```
*.lights.*                // All light objects
zigbee.0.*.available      // Zigbee device availability
```

**System Information**
```
system.host.*             // Host information
system.config             // System configuration
system.certificates       // SSL certificates
```

## Output Formats

### Single Object Format
Returns the object directly when only one match is found:

```
{
  _id: "system.adapter.admin.0",
  type: "instance",
  common: {
    name: "admin",
    version: "7.0.1",
    enabled: true,
    host: "iobroker-host"
  },
  native: {
    port: 8081,
    auth: false
  }
}
```

### Array Format
Returns an array of objects:

```
[
  {
    _id: "system.adapter.admin.0",
    type: "instance",
    // ... object data
  },
  {
    _id: "system.adapter.web.0", 
    type: "instance",
    // ... object data
  }
]
```

### Object Map Format
Returns a mapping of object IDs to objects:

```
{
  "system.adapter.admin.0": {
    _id: "system.adapter.admin.0",
    type: "instance",
    // ... object data
  },
  "system.adapter.web.0": {
    _id: "system.adapter.web.0",
    type: "instance", 
    // ... object data
  }
}
```

## Object Structure

### Common Properties
All objects contain these properties:

- `_id`: Unique object identifier
- `type`: Object type (state, channel, device, instance, etc.)
- `common`: Common metadata (name, role, type, etc.)
- `native`: Adapter-specific configuration

### Object Types
- **state**: Data points with values
- **channel**: Grouping of related states
- **device**: Physical or logical devices
- **instance**: Adapter instances
- **host**: System host information
- **config**: Configuration objects

### Common Metadata
The `common` section contains:

- `name`: Human-readable name
- `role`: Functional role (e.g., "value.temperature")
- `type`: Data type (number, string, boolean, object)
- `read`/`write`: Access permissions
- `unit`: Physical unit
- `min`/`max`: Value ranges
- `states`: Possible values for enums

## Use Cases

### System Discovery
- Find all installed adapters
- Discover available devices
- Map system architecture
- Audit configurations

### Dynamic Configuration
- Build device lists for UIs
- Generate adapter monitoring
- Validate object structures

### Troubleshooting
- Check object definitions
- Verify permissions and roles
- Analyze configuration issues

## Error Handling

### Common Errors
- **Object not found**: Specified object doesn't exist
- **Permission denied**: User lacks read permissions
- **Connection error**: WebSocket unavailable

## Troubleshooting

### No Results
1. Check object ID syntax and existence
2. Verify wildcard pattern is correct
3. Confirm read permissions
4. Test with simpler patterns

### Too Many Results
1. Narrow wildcard scope
2. Add filtering logic
3. Implement result pagination
4. Use more specific patterns

## Related Nodes

- **WS ioB inObj**: Monitor object changes
- **WS ioB get**: Read state values
- **WS ioB in**: Subscribe to state changes

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.