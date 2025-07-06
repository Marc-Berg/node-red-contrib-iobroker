# WS ioB getObject - Object Getter with Enum Assignment Support

Retrieve ioBroker object definitions and metadata with support for wildcard patterns, multiple output formats, and automatic enum assignment integration.

## Purpose

The WS ioB getObject node allows you to retrieve ioBroker object definitions, which contain metadata about states, devices, adapters, and other ioBroker entities. This is useful for discovering available states, reading device configurations, and understanding object structures. The node includes enum assignment features for automatic room and function categorization.

## Configuration

### Basic Settings

**Object ID / Pattern**
- Single object ID (e.g., `system.adapter.admin.0`)
- Wildcard pattern (e.g., `system.adapter.*`)
- Leave empty to use `msg.topic` for dynamic selection

**Output Property**
- Target message property for the retrieved object(s)
- Default: `payload`
- Can be set to any valid message property

**Output Mode**
- **Single Object**: Returns object directly (for single matches)
- **Array of Objects**: Returns array of objects (ideal for wildcards)
- **Object Map**: Returns `{objectId: object}` mapping

**Object Type Filter**
- Filter objects by type (state, channel, device, etc.)

### Enum Assignment Integration

**Include assigned Enums**
- Enriches objects with room and function assignments
- Provides structured enum data for each object

**Enum Types**
- **All Types**: Include rooms, functions, and custom enums
- **Rooms only**: Only room assignments
- **Functions only**: Only function assignments  
- **Rooms and Functions**: Both rooms and functions, excluding custom enums

## Enhanced Output with Enum Assignments

When enum assignments are enabled, each object includes an `enumAssignments` property:

```javascript
{
  _id: "hue.0.lights.1.state",
  type: "state",
  common: {
    name: "Living Room Light",
    role: "switch.state"
  },
  native: {},
  enumAssignments: {
    rooms: [
      {
        id: "enum.rooms.living_room",
        name: "Living Room", 
        type: "rooms",
        icon: "home",
        color: "#ff6600"
      }
    ],
    functions: [
      {
        id: "enum.functions.lighting",
        name: "Lighting",
        type: "functions", 
        icon: "lightbulb",
        color: "#ffcc00"
      }
    ],
    other: [],
    totalEnums: 2,
    hasRoom: true,
    hasFunction: true,
    roomName: "Living Room",
    functionName: "Lighting"
  }
}
```

### Enum Assignment Properties

**Arrays by Type**
- `rooms`: Array of assigned room enums
- `functions`: Array of assigned function enums  
- `other`: Array of custom enum assignments

**Summary Information**
- `totalEnums`: Total number of enum assignments
- `hasRoom`: Boolean indicating room assignment
- `hasFunction`: Boolean indicating function assignment

**Convenience Properties**
- `roomName`: Name of first assigned room (null if none)
- `functionName`: Name of first assigned function (null if none)

### Enhanced Message Properties

**Standard Output Properties**
- Target property (default `payload`): Object(s) with enum data
- `objects`: Object map for compatibility
- `objectId`: The object ID or pattern used
- `count`: Number of objects returned
- `timestamp`: When the data was retrieved

**Enum-Specific Properties**
- `includesEnums`: Boolean flag indicating enum data inclusion
- `enumStatistics`: Summary statistics about enum coverage (for multiple objects)

**Example Enum Statistics**
```javascript
{
  enumStatistics: {
    objectsWithRooms: 15,
    objectsWithFunctions: 12, 
    objectsWithAnyEnum: 18,
    totalEnumAssignments: 32
  }
}
```

## Object Types and Filtering

### Supported Object Types
- **state**: Data points with values
- **channel**: Grouping of related states
- **device**: Physical or logical devices  
- **folder**: Organizational containers
- **adapter**: Adapter instances
- **instance**: Adapter instance configurations
- **host**: System host information
- **group**: User groups
- **user**: User accounts
- **config**: Configuration objects
- **enum**: Enumeration objects

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

## Wildcard Pattern Examples

### Discover Adapters
```
system.adapter.*          // All adapter instances
system.adapter.*.alive    // Adapter status states
system.adapter.hue.*      // All Hue adapter objects
```

### Find Device Objects with Room Context
```
*.lights.*                // All light objects (with room assignments)
zigbee.0.*.available      // Zigbee device availability (with location info)
hue.0.*                   // All Hue objects (with room/function data)
```

### Enum Discovery
```
enum.*                    // All enum objects
enum.rooms.*              // All room definitions
enum.functions.*          // All function definitions
```

### System Information
```
system.host.*             // Host information
system.config             // System configuration
system.certificates       // SSL certificates
```

## Output Formats

### Single Object Format
Returns the object directly when only one match is found:

```javascript
{
  _id: "hue.0.lights.1.state",
  type: "state",
  common: {
    name: "Living Room Light",
    role: "switch.state"
  },
  native: {},
  enumAssignments: {
    // ... enum data as shown above
  }
}
```

### Array Format
Returns an array of objects with enum assignments:

```javascript
[
  {
    _id: "hue.0.lights.1.state",
    type: "state",
    enumAssignments: { /* ... */ }
  },
  {
    _id: "hue.0.lights.2.state", 
    type: "state",
    enumAssignments: { /* ... */ }
  }
]
```

### Object Map Format
Returns a mapping of object IDs to enriched objects:

```javascript
{
  "hue.0.lights.1.state": {
    _id: "hue.0.lights.1.state",
    type: "state",
    enumAssignments: { /* ... */ }
  },
  "hue.0.lights.2.state": {
    _id: "hue.0.lights.2.state",
    type: "state", 
    enumAssignments: { /* ... */ }
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
- `enumAssignments`: Room/function assignments (when enabled)

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

### Smart Home Dashboard Creation
- Build room-based device lists automatically
- Group devices by function (lighting, heating, security)
- Generate navigation based on enum structure
- Create responsive UIs that adapt to ioBroker configuration

### System Discovery with Context
- Find all devices with their room assignments
- Discover uncategorized objects (missing enum assignments)
- Audit room and function assignments across the system
- Generate device installation reports

### Dynamic Configuration
- Build device lists for UIs with room/function context
- Generate adapter monitoring with location awareness
- Validate object structures and enum consistency
- Create installation wizards based on existing room structure

### Home Automation Logic
- Find all lights in specific rooms for scene control
- Group devices by function for bulk operations
- Create location-aware automation rules
- Build voice control interfaces with room context

## Advanced Features

### Pattern and Mode Compatibility
- **Single Mode + Pattern**: Returns only the first matching object (warning shown)
- **Array/Object Mode + Single ID**: Wraps single result appropriately  
- **Recommended**: Use Array/Object modes with wildcard patterns for best results

### Performance Optimization
- **Server-side filtering**: Type filtering applied at ioBroker level
- **Efficient enum loading**: Enum data loaded once per request
- **Optimized patterns**: Use specific patterns when possible
- **Result caching**: Avoid repeated requests for same data

## Error Handling

### Common Errors
- **Object not found**: Specified object doesn't exist
- **Permission denied**: User lacks read permissions  
- **Connection error**: WebSocket unavailable
- **Type mismatch**: Object exists but doesn't match type filter
- **Enum loading failed**: Enum data unavailable (continues without enum assignments)

### Error Response
Error information is included in the output message:
- `error`: Error description
- `errorType`: Error category (timeout, unknown, etc.)
- Output still includes basic structure with null payload

## Performance Considerations

### Enum Assignment Impact
- Enum data loading adds minimal overhead
- Enum assignments resolved for each matching object
- May take longer for large result sets
- Consider disabling for pure metadata queries

### Query Optimization
- Use specific wildcard patterns: `lights.*` instead of `*`
- Apply type filtering to reduce result sets
- Limit scope for broad enum queries
- Monitor response times with large object counts

## Troubleshooting

### No Results
1. Check object ID syntax and existence
2. Verify wildcard pattern is correct
3. Confirm read permissions
4. Test with simpler patterns
5. Check type filter settings

### Missing Enum Assignments
1. Verify enum objects exist in ioBroker
2. Check object is actually assigned to rooms/functions
3. Test enum types filter settings
4. Confirm enum assignment in ioBroker admin interface

### Too Many Results
1. Narrow wildcard scope
2. Add type filtering
3. Use more specific patterns
4. Implement result pagination
5. Consider disabling enum assignments for discovery queries

## Related Nodes

- **WS ioB inObj**: Monitor object changes with enum context
- **WS ioB get**: Read state values
- **WS ioB in**: Subscribe to state changes
- **WS ioB out**: Create objects with enum assignments

## Examples

### Room-Based Device Discovery
```javascript
// Get all lights with room assignments
msg.topic = "*.lights.*";
msg.objectType = "state";
// Enable enum assignments to get room context
```

### Smart Home Dashboard Data
```javascript
// Get all devices grouped by room and function
msg.topic = "*";
msg.outputMode = "array";
// Use enum assignments to build room/function navigation
```

### System Audit
```javascript
// Find objects without room assignments
msg.topic = "*";
// Filter results to find objects with enumAssignments.hasRoom = false
```

See [Common Use Cases](../use-cases.md) for practical implementation examples.