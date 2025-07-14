# Troubleshooting Guide

This guide helps you resolve common issues with the Node-RED ioBroker integration nodes.

> **📊 Advanced Diagnostics**: For detailed log analysis and message interpretation, see the [Logging Guide](logging.md).

## Connection Issues

### WebSocket Adapter Not Working
1. **Check WebSocket adapter** is installed and running in ioBroker
2. **Verify port number** matches your configuration (8081/8082/8084)
3. **Test network connectivity** from Node-RED to ioBroker server
4. **Check authentication** credentials if using secured installation

**Log Indicators:**
```
ERROR [ConnectionManager] Connection error for 192.168.1.100:8084: ECONNREFUSED
ERROR [SocketClient] WebSocket error: Connection timeout
```

### Cannot Connect to ioBroker
1. Verify ioBroker server is running and accessible
2. Check firewall settings on both Node-RED and ioBroker systems
3. Ensure the selected port is open and not blocked
4. Test connection using browser: `http://your-iobroker-ip:port`

**Expected Log Sequence:**
```
INFO [ConnectionManager] Creating connection 1 to 192.168.1.100:8091
INFO [AuthManager] OAuth authentication successful for user: admin
INFO [ConnectionManager] Connection state changed: connecting -> connected
```

### Connection Drops Frequently
1. Check network stability between Node-RED and ioBroker
2. Increase session duration to ≥3600 seconds (1 hour) in ioBroker settings
3. Verify adapter configuration in ioBroker
4. Check for high system load on either server

**Log Analysis:**
```bash
# Check for connection drop patterns
grep "Connection lost\|Connection error" nodered.log

# Monitor token refresh frequency  
grep "Token refresh\|Token expires" nodered.log
```

### SSL/TLS Connection Issues
1. **Check SSL certificate validity** on ioBroker server
2. **Verify SSL port configuration**
3. **Test with SSL disabled** first to isolate SSL issues

**Log Messages:**
```
INFO [SocketClient] SSL connection established with cipher: ECDHE-RSA-AES256-GCM-SHA384
DEBUG [AuthManager] OAuth authentication via HTTPS successful
```

## Authentication Problems

### "Invalid credentials" Error
1. **Verify username/password** in ioBroker admin interface
2. **Check user exists** and has proper permissions
3. **Test login** directly in ioBroker web interface
4. **Clear browser cache** and try again

**Log Messages:**
```
ERROR [AuthManager] Authentication failed permanently for 192.168.1.100:8091: Invalid credentials
ERROR [AuthManager] OAuth authentication failed: unauthorized
```

### "Access forbidden" Error
1. **Check user permissions** in ioBroker user management
2. **Verify user has WebSocket access** enabled
3. **Check adapter-specific permissions** if using restricted access
4. **Review ioBroker security settings**

### "Token expired" Error
1. **Increase session duration** to ≥3600 seconds in ioBroker settings
2. **Check system time synchronization** between servers
3. **Clear authentication cache** by redeploying Node-RED flow

**Log Analysis:**
```
INFO [AuthManager] Starting proactive token refresh with session renewal
```

### Token Refresh Issues
1. **Monitor token refresh logs** for failures
2. **Check if refresh happens before expiry** (should be ~55 minutes for 1-hour tokens)
3. **Verify graceful renewal process** completes successfully
4. **Check for multiple connection conflicts** during token refresh

**Expected Token Refresh Log Sequence:**
```
INFO [AuthManager] Setting token refresh timer for 55 minutes
INFO [AuthManager] Token refresh timer fired - checking conditions...
INFO [AuthManager] Starting graceful connection renewal with event-based overlap
INFO [AuthManager] New token acquired, building parallel connection
INFO [AuthManager] All 12 subscriptions completed on new connection
INFO [AuthManager] Graceful renewal with event-based overlap completed successfully
```

## Node Status Messages

Understanding the visual status indicators on each node:

### Status Colors and Meanings
- **Green dot "Ready"**: Connected and operational
- **Yellow ring "Connecting"**: Establishing connection to ioBroker
- **Red ring "Disconnected"**: Connection lost, automatic retry in progress
- **Red ring "Auth failed"**: Authentication error, check credentials
- **Blue dot "Processing"**: Node is actively processing data
- **Gray dot "Disabled"**: Node is disabled or not configured

**Corresponding Log Messages:**
```
INFO [NodeRegistry] Node abc123 successfully subscribed to 192.168.1.100:8091
INFO [WebSocketManager] Client ready for 192.168.1.100:8091 - processing 5 nodes
ERROR [NodeRegistry] Subscribe failed for node abc123
```

### Advanced Status Indicators
- **Green dot with value**: Shows last received/sent value
- **Yellow ring "Retrying"**: Automatic recovery in progress
- **Red ring "Failed permanently"**: Manual intervention required
- **Blue dot "Queuing"**: Operations queued for processing
- **Green dot "[Changes]"**: Change filtering is active

## Recovery and Retry Behavior

### Understanding Automatic Recovery
The integration includes recovery mechanisms:

1. **Connection Recovery**: Automatic reconnection with exponential backoff
2. **Subscription Recovery**: Re-establishment of all node subscriptions
3. **Token Refresh**: Proactive authentication token renewal
4. **Queue Processing**: Buffering operations during temporary disconnections

**Recovery Log Sequence:**
```
WARN [RecoveryManager] Scheduling retry for 192.168.1.100:8091 in 6s (attempt 1)
INFO [RecoveryManager] Executing scheduled retry for 192.168.1.100:8091
INFO [RecoveryManager] Connection recovered successfully for 192.168.1.100:8091
INFO [NodeRegistry] Executing 15 recovery callbacks for 192.168.1.100:8091
INFO [NodeRegistry] Resubscribing to 8 state patterns for 192.168.1.100:8091
```

### When Recovery Fails
If automatic recovery repeatedly fails:

1. **Check error classification** in logs (authentication vs network errors)
2. **Review retry attempt counts** (stops after 10 attempts for non-retryable errors)
3. **Monitor backoff timing** (should increase with each attempt)
4. **Look for permanent failure states** (auth_failed, network unreachable)

**Failed Recovery Indicators:**
```
ERROR [RecoveryManager] Maximum retry attempts reached for 192.168.1.100:8091, marking as failed
ERROR [RecoveryManager] Non-retryable error for 192.168.1.100:8091, stopping retries
WARN [ConnectionManager] Authentication failed permanently for 192.168.1.100:8091
```

## Configuration Issues

### Missing Objects in ioBroker
1. **Enable auto-create** in WS ioB out node configuration
2. **Check object permissions** in ioBroker
3. **Verify state path** follows ioBroker naming conventions
4. **Review adapter configuration** for target states

**Log Messages:**
```
INFO [OperationManager] Setting state device.light.power = true on 192.168.1.100:8091
ERROR [OperationManager] setState(device.invalid) failed: Object not found
DEBUG [ObjectManager] Object created automatically: device.light.power
```

### Auto-Creation Configuration
When using auto-creation features:

1. **Check object type detection** for proper data type assignment
2. **Verify naming conventions** match ioBroker requirements
3. **Review role assignments** for proper object categorization
4. **Monitor creation permissions** in ioBroker

**Auto-Creation Log Messages:**
```
INFO [iobout] Auto-detected payload type: number for value 23.5
DEBUG [OperationManager] Creating object device.sensor.temperature with role: value.temperature
INFO [OperationManager] Object created successfully: device.sensor.temperature
```

### Wildcard Patterns Not Working
1. **Check pattern syntax** - use `*`, `?` is not supported
2. **Avoid overly broad patterns** like `*` or `*.*` for performance
3. **Test pattern** with smaller subsets first
4. **Verify state existence** in ioBroker objects view

**Log Analysis:**
```
DEBUG [NodeRegistry] Subscription details: wildcard pattern: device.*.state
WARN [NodeRegistry] Wildcard pattern too broad, may impact performance: *.*.*
```

### Multiple State Subscriptions
For nodes subscribing to multiple states:

1. **Check subscription success rates** in logs
2. **Monitor batch processing** for large state lists
3. **Verify output mode configuration** (individual vs grouped)
4. **Review initial value loading** for multiple states

**Multiple State Log Analysis:**
```
INFO [NodeRegistry] Node abc123 successfully subscribed to 192.168.1.100:8091 (8/10 states)
DEBUG [NodeRegistry] Loading initial values in parallel for 8 states
INFO [NodeRegistry] Initial values loading completed for node abc123
```

### Historical Data Issues
1. **Check history adapter** is installed and running
2. **Verify data retention** settings in history adapter
3. **Confirm state logging** is enabled for target states
4. **Test query parameters** with smaller time ranges first

**Log Messages:**
```
INFO [OperationManager] Retrieved 1247 historical data points for device.sensor.temperature
ERROR [HistoryManager] History adapter not found: history.0
```

### History Query Performance
For slow historical queries:

1. **Reduce time range** for initial testing
2. **Check aggregation settings** for data volume reduction
3. **Monitor query mode** (parallel vs sequential vs drop)
4. **Review database performance** in history adapter

**History Performance Logs:**
```
DEBUG [iobhistory] Query completed in 2847ms for 5000 data points
WARN [iobhistory] Query timeout after 30000ms - consider reducing time range
INFO [iobhistory] Using sequential query mode due to high load
```

## Performance Issues

### Slow Response Times
1. **Limit wildcard scope** to reduce data volume
2. **Check network latency** between systems
3. **Monitor system resources** on both servers
4. **Optimize query frequency** for historical data

**Performance Log Analysis:**
```
DEBUG [OperationManager] Operation completed in 145ms
WARN [OperationManager] Operation timeout after 10000ms: getStates
DEBUG [CacheManager] Cache hit for 192.168.1.100:8091
```

### High Memory Usage
1. **Reduce subscription count** by optimizing wildcard patterns
2. **Implement message filtering** in Node-RED flows
3. **Check for memory leaks** in custom function nodes

**Memory Monitoring:**
```
DEBUG [NodeRegistry] Node count for 192.168.1.100:8091: 15
WARN [PerformanceMonitor] High subscription count detected: 50+ patterns
```

### Operation Queue Issues
When operations get queued or delayed:

1. **Check queue processing mode** (parallel/sequential/drop)
2. **Monitor queue sizes** in status information
3. **Review operation timeout settings**
4. **Identify bottleneck operations**

**Queue Analysis:**
```
DEBUG [OperationManager] Queued setState for 192.168.1.100:8091 (queue size: 3)
INFO [OperationManager] Processing 5 queued operations for 192.168.1.100:8091
WARN [OperationManager] Operation timeout in queue: setState after 10000ms
```

### Subscription Limits
When dealing with many subscriptions:

1. **Monitor total subscription count** per server
2. **Use grouped output modes** to reduce message volume
3. **Implement change filtering** to reduce unnecessary messages
4. **Consider subscription consolidation** with wildcards

**Subscription Monitoring:**
```
INFO [NodeRegistry] Total subscriptions for 192.168.1.100:8091: 127
WARN [NodeRegistry] High subscription count may impact performance
DEBUG [NodeRegistry] Grouped mode active for 25 states in node abc123
```

## Deployment Issues

### Full Deploy vs Modified Nodes
**Issue**: Using "Modified nodes" instead of "Full deploy" can cause problems:

**Problems with Modified Deploy:**
- **Orphaned Subscriptions**: Old subscriptions may persist in WebSocket manager
- **Connection Sharing Conflicts**: Shared WebSocket connections get inconsistent state
- **Node Registry Issues**: Registry contains entries for non-existent nodes
- **Authentication Problems**: Token refresh may fail for new node instances

**Symptoms:**
```
WARN [NodeRegistry] Node abc123 not found in registry
ERROR [AuthManager] Token refresh failed for non-existent node
DEBUG [ConnectionManager] Duplicate subscription detected for pattern: device.*
```

**Solutions:**
1. **Use Full Deploy** for ioBroker node changes
2. **Restart Node-RED** after major configuration changes
3. **Monitor connection status** after partial deploys

**When to use Full Deploy:**
- Server configuration changes
- Authentication parameter changes
- Multiple ioBroker nodes modified
- After unexplained connection issues

**When Modified Nodes is safe:**
- Single node parameter changes (state IDs, names)
- UI-only changes
- Small logic modifications in single nodes

### Deployment Verification
After deployment, verify proper operation:

```bash
# Check for deployment issues
grep "Node not found\|Duplicate subscription\|State mismatch" nodered.log

# Monitor connection recovery
grep "Connection recovered\|Resubscribing" nodered.log

# Verify clean startup sequence
grep "Creating connection\|Client ready" nodered.log | tail -10
```

## Tree View and UI Issues

### Tree View Not Loading
1. **Check server configuration** is properly selected
2. **Test state endpoint** manually: `/iobroker/ws/states/server:port`
3. **Clear browser cache** and refresh Node-RED editor

**Tree View Error Messages:**
```
[ioBroker] States API error: Failed to retrieve states
[ioBroker] TreeView component not available. Manual input only.
[ioBroker] Failed to load TreeView component: script not found
```

### Search and Filtering Issues
1. **Use hierarchical search** for better performance with large datasets
2. **Check search index building** for initial delays
3. **Verify wildcard detection** works with pattern input
4. **Test virtual scrolling** with large state lists

### Auto-Selection Problems
When server auto-selection fails:

1. **Verify single server configuration** exists
2. **Check server configuration validity**
3. **Manually select server** if auto-selection is incorrect
4. **Review server connection parameters**

## Adapter-Specific Issues

### SendTo Adapter Problems
1. **Verify target adapter** is running and accessible
2. **Check command syntax** for specific adapter requirements
3. **Test with fire-and-forget mode** before enabling response waiting
4. **Review adapter documentation** for sendTo message format

**SendTo Log Messages:**
```
INFO [OperationManager] Executing sendTo(telegram.0, send) for 192.168.1.100:8091
ERROR [OperationManager] SendTo timeout after 10000ms for telegram.0
DEBUG [OperationManager] SendTo response received from telegram.0: success
```

### Log Subscription Issues
1. **Check log level filtering** matches expected volume
2. **Verify log adapter compatibility** with live log subscription
3. **Monitor log message processing** for performance impact
4. **Review log level hierarchy** (silly → debug → info → warn → error)
5. **Use Admin Adapter**

**Log Subscription Messages:**
```
INFO [ioblog] Successfully subscribed to live logs (level: info+)
WARN [ioblog] High volume: Debug level may generate many messages
DEBUG [ioblog] Log message processed: level=warn from=admin
```

### Object Subscription Monitoring
For object change monitoring:

1. **Use appropriate wildcard patterns** for object types
2. **Monitor object creation/deletion events**
3. **Check object change frequency** vs performance needs
4. **Review adapter object update patterns**

## Advanced Diagnostics

### Enable Debug Logging
For detailed troubleshooting, enable debug logging in Node-RED:

**Node-RED settings.js:**
```javascript
logging: {
    console: {
        level: "debug",
        metrics: true,
        audit: true
    }
}
```

### Connection State Analysis
**Check connection lifecycle:**
```bash
# Full connection sequence
grep "Creating connection\|Connection established\|Client ready" nodered.log

# Authentication and token flow
grep "OAuth\|Authentication\|Token\|Graceful renewal" nodered.log

# Recovery and retry analysis
grep "Retry\|Recovery\|Backoff\|Failed permanently" nodered.log
```

**Error Tracking:**
```bash
# All errors in last hour
grep "ERROR" nodered.log | tail -50

# Specific error patterns
grep "ECONNREFUSED\|timeout\|Authentication failed" nodered.log
```

## Getting Diagnostic Information

### Status Information Command
Send a message with `msg.topic = "status"` to any ioBroker node to get detailed connection information including:
- Connection state and uptime
- WebSocket protocol version
- Authentication status
- Error history
- Performance metrics

**Example Status Response:**
```json
{
  "connected": true,
  "authenticated": true,
  "ready": true,
  "sessionID": 1234567890,
  "subscriptionCount": 12,
  "queuedOperations": 0,
  "lastError": null,
  "tokenAge": 1800000,
  "timeUntilRefresh": 1500000,
  "recovery": {
    "retryScheduled": false,
    "nodeCount": 8,
    "attempts": 0,
    "active": false
  },
  "ssl": {
    "enabled": true,
    "protocol": "wss/https"
  },
  "authentication": {
    "method": "oauth2",
    "authenticated": true
  }
}
```

### Advanced Status Information
For detailed diagnostics, status responses include:

- **Connection pooling**: Shared connection statistics
- **Queue status**: Pending operations and processing mode
- **Recovery status**: Retry attempts and backoff timers
- **Subscription details**: Pattern counts and success rates
- **Performance metrics**: Response times and throughput

### Debug Logging Best Practices
1. **Enable debug temporarily** for troubleshooting specific issues
2. **Monitor log file sizes** when debug logging is active
3. **Focus on specific components** using grep filters
4. **Return to INFO/WARN level** in production for performance

## When to Seek Help

If you've tried the above solutions and still experience issues:

1. **Check GitHub Issues**: [Known Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
2. **Review Logging Guide**: [Detailed Log Analysis](logging.md)
3. **Create Bug Report** with relevant logs
4. **ioBroker Community**: [ioBroker Forum](https://forum.iobroker.net)

### Information to Include in Bug Reports
- Node-RED version
- ioBroker version
- Adapter type and version
- Operating system details
- Node configuration (sanitized)
- **Relevant log messages** (use appropriate log level)
- Steps to reproduce the issue
- **Connection status** during issue occurrence
- **Deployment method** used (Full vs Modified)

### Log Sanitization for Support
When sharing logs for support:
1. **Remove sensitive information** (passwords, API keys, personal data)
2. **Sanitize usernames** if necessary
3. **Include timestamp ranges** for context
4. **Focus on relevant time periods** around the issue
5. **Include connection sequence** leading up to the problem
6. **Provide status information** from affected nodes

### Escalation Checklist
Before seeking help, ensure you have:

- [ ] **Tried Full Deploy** instead of Modified Nodes
- [ ] **Checked all connection parameters** (host, port, auth)
- [ ] **Verified ioBroker adapter status** and configuration
- [ ] **Collected relevant log messages** with appropriate detail level
- [ ] **Obtained status information** from affected nodes
- [ ] **Documented exact steps to reproduce** the issue
- [ ] **Tested with different network conditions** if applicable
- [ ] **Verified compatibility** between versions

---

**📖 Related Documentation:**
- **📊 [Logging Guide](logging.md)** - Detailed log message interpretation and analysis
- **🎯 [Use Cases](use-cases.md)** - Practical implementation examples
- **🔧 [Configuration Guide](../README.md#configuration)** - Setup and configuration details