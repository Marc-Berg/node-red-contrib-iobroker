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
WARN [AuthManager] Token expires in 300 seconds - consider increasing session duration
INFO [AuthManager] Starting proactive token refresh with session renewal
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
ERROR [NodeRegistry] Subscribe failed for node abc123: Pattern too broad
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

### Historical Data Issues
1. **Check history adapter** is installed and running
2. **Verify data retention** settings in history adapter
3. **Confirm state logging** is enabled for target states

**Log Messages:**
```
INFO [OperationManager] Retrieved 1247 historical data points for device.sensor.temperature
ERROR [HistoryManager] History adapter not found: history.0
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

### Log Analysis Commands
**Connection Issues:**
```bash
# Monitor connection sequence
grep "Creating connection\|Connection established\|Client ready" nodered.log

# Check authentication flow
grep "OAuth\|Authentication\|Token" nodered.log | tail -20
```

**Performance Analysis:**
```bash
# Operation timing
grep "completed in\|timeout after" nodered.log

# Queue analysis
grep "Queueing\|Processing.*queued" nodered.log
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
  "timeUntilRefresh": 1500000
}
```

### Debug Logging Best Practices
1. **Enable debug temporarily** for troubleshooting specific issues
2. **Monitor log file sizes** when debug logging is active
3. **Focus on specific components** using grep filters
4. **Return to INFO level** in production for performance

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
- **Status information** from affected nodes

### Log Sanitization for Support
When sharing logs for support:
1. **Remove sensitive information** (passwords, API keys, personal data)
2. **Replace IP addresses** with placeholders (e.g., X.X.X.X)
3. **Sanitize usernames** if necessary
4. **Include timestamp ranges** for context
5. **Focus on relevant time periods** around the issue

---

**📖 Related Documentation:**
- **📊 [Logging Guide](logging.md)** - Detailed log message interpretation and analysis
- **🎯 [Use Cases](use-cases.md)** - Practical implementation examples
- **🔧 [Configuration Guide](../README.md#configuration)** - Setup and configuration details