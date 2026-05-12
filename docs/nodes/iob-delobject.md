# WS ioB delObj - Delete ioBroker Objects

Delete ioBroker objects via WebSocket.

## Purpose

The WS ioB delObj node deletes existing ioBroker objects. It is intended for explicit cleanup tasks such as removing objects in custom namespaces or deleting generated object trees.

## When to Use This Node

- Delete obsolete custom objects in namespaces such as `0_userdata.0`
- Remove generated test objects after development
- Clean up whole object trees when recursive deletion is intended

## Important Warning

Deleting an object removes the ioBroker object definition. For states this is not the same as clearing the current value.

- Use this node only for deliberate cleanup
- Avoid deleting system objects unless you know the consequences
- Recursive deletion can remove complete object hierarchies

## Configuration

### Basic Settings

**Object ID**
- The object identifier to delete
- Leave empty to use `msg.objectId`

**Delete children recursively**
- Uses recursive object deletion for the selected object and all children below it

**Maintenance mode**
- Passes the maintenance flag through to ioBroker for special deletion scenarios when supported

## Input Message

### msg.objectId (string, optional)
Overrides the configured object ID.

### msg.recursive (boolean, optional)
Overrides the recursive delete setting.

### msg.maintenance (boolean, optional)
Overrides the maintenance setting. When enabled, the backend may permit deletion of invalid or non-standard IDs that would otherwise be blocked by validation.

## Output Message

```javascript
{
  payload: {
    success: true,
    objectId: "0_userdata.0.cleanup.demo",
    recursive: false,
    maintenance: false
  },
  objectId: "0_userdata.0.cleanup.demo",
  recursive: false,
  maintenance: false,
  timestamp: 1234567890
}
```

## Example

```javascript
msg.objectId = "0_userdata.0.cleanup.demo";
return msg;
```

For recursive deletion:

```javascript
msg.objectId = "0_userdata.0.cleanup";
msg.recursive = true;
return msg;
```

## Notes

- This node deletes objects, not just state values
- Current subscriptions to deleted objects will naturally stop receiving updates
- Permissions must allow object deletion on the ioBroker side