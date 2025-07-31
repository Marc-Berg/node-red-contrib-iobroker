# Troubleshooting Guide

This guide helps you resolve common issues with the Node-RED ioBroker integration nodes.

> **📊 Advanced Diagnostics**: For detailed log analysis and message interpretation, see the [Logging Guide](logging.md).

## 1. Connection Issues

### 1.1 WebSocket Connection Problems

#### Cannot Connect to ioBroker
**Common Causes:**
- ioBroker server not running or not accessible
- Wrong IP address or port configuration
- Firewall blocking connection
- WebSocket adapter not installed in ioBroker

**Quick Check:**
1. Test connection in browser: `http://your-iobroker-ip:port`
2. Verify WebSocket adapter is running in ioBroker
3. Check port number matches configuration
4. Test network connectivity from Node-RED to ioBroker

**Log Indicators:**
```
ERROR [ConnectionManager] Connection error: ECONNREFUSED
ERROR [SocketClient] WebSocket error: Connection timeout
```

#### Connection Drops Frequently
**Solutions:**
1. Increase session duration to ≥3600 seconds in ioBroker settings
2. Check network stability between servers
3. Verify ioBroker adapter configuration
4. Monitor system load on both servers

**Expected Recovery Log:**
```
INFO [RecoveryManager] Connection recovered successfully
INFO [NodeRegistry] Resubscribing to 8 state patterns
```

### 1.2 SSL/TLS Issues

#### SSL Connection Problems
**Troubleshooting Steps:**
1. Check SSL certificate validity on ioBroker server
2. Verify SSL port configuration
3. Test with SSL disabled first to isolate issues

**Success Log:**
```
INFO [SocketClient] SSL connection established
```

## 2. Authentication Issues

### 2.1 Login Problems

#### Invalid Credentials Error
**Solutions:**
1. Verify username/password in ioBroker admin interface
2. Test login directly in ioBroker web interface
3. Check user exists and has proper permissions
4. Clear authentication cache by redeploying flow

**Log Messages:**
```
ERROR [AuthManager] Authentication failed: Invalid credentials
ERROR [AuthManager] OAuth authentication failed: unauthorized
```

#### Access Forbidden Error
**Check These Settings:**
1. User permissions in ioBroker user management
2. WebSocket access enabled for user
3. ioBroker security settings

### 2.2 Token Management

#### Token Expired Error
**Solutions:**
1. Increase session duration to ≥3600 seconds in ioBroker
2. Check system time synchronization between servers
3. Monitor token refresh process in logs

**Expected Token Refresh:**
```
INFO [AuthManager] Starting proactive token refresh
INFO [AuthManager] Graceful renewal completed successfully
```

## 3. Node Status and Behavior

### 3.1 Status Indicators

#### Understanding Node Status
- 🟢 **Green dot "Ready"**: Connected and operational
- 🟡 **Yellow ring "Connecting"**: Establishing connection
- 🔴 **Red ring "Disconnected"**: Connection lost, retrying
- 🔴 **Red ring "Auth failed"**: Authentication error
- 🔵 **Blue dot "Processing"**: Actively processing data
- ⚪ **Gray dot "Disabled"**: Node disabled or not configured

### 3.2 Recovery Behavior

#### Automatic Recovery Process
The integration includes built-in recovery:
1. **Connection Recovery**: Automatic reconnection with backoff
2. **Subscription Recovery**: Re-establishment of subscriptions
3. **Token Refresh**: Proactive authentication renewal
4. **Queue Processing**: Operation buffering during disconnections

**When Recovery Fails:**
```
ERROR [RecoveryManager] Maximum retry attempts reached
ERROR [RecoveryManager] Non-retryable error, stopping retries
```

## 4. Configuration Issues

### 4.1 State and Object Problems

#### Missing Objects in ioBroker
**Solutions:**
1. Enable auto-create in WS ioB out node configuration
2. Check object permissions in ioBroker
3. Verify state path follows naming conventions
4. Review target adapter configuration

**Auto-Creation Log:**
```
INFO [OperationManager] Object created successfully: device.sensor.temperature
```

#### Wildcard Patterns Not Working
**Best Practices:**
1. Check pattern syntax - use `*`, not `?`
2. Avoid overly broad patterns like `*.*.*`
3. Test with smaller subsets first
4. Verify states exist in ioBroker

**Pattern Examples:**
- ✅ Good: `lights.*`, `sensors.*.temperature`
- ❌ Avoid: `*`, `*.*.*`

### 4.2 Historical Data Issues

#### History Queries Failing
**Check These Items:**
1. History adapter installed and running
2. Data retention settings configured
3. State logging enabled for target states
4. Query parameters reasonable (time range)

**Performance Tips:**
- Start with smaller time ranges
- Use aggregation for large datasets
- Monitor query timeout settings

## 5. Performance Issues

### 5.1 Slow Response Times

#### Optimization Strategies
1. **Limit wildcard scope** to reduce data volume
2. **Optimize subscription patterns** - use specific prefixes
3. **Implement message filtering** in Node-RED flows
4. **Monitor system resources** on both servers

**Performance Monitoring:**
```
DEBUG [OperationManager] Operation completed in 145ms
WARN [OperationManager] Operation timeout after 10000ms
```

### 5.2 Memory and Queue Issues

#### High Memory Usage
**Solutions:**
1. Reduce subscription count by optimizing patterns
2. Implement change filtering
3. Check for memory leaks in custom functions

#### Operation Queue Problems
**Monitoring:**
```
DEBUG [OperationManager] Queued operation (queue size: 3)
WARN [OperationManager] Operation timeout in queue after 10000ms
```

## 6. Deployment Issues

### 6.1 Deploy Strategy

#### Full Deploy vs Modified Nodes
**⚠️ Important**: Use **Full Deploy** for ioBroker node changes

**Problems with Modified Deploy:**
- Orphaned subscriptions persist
- Connection sharing conflicts
- Authentication token issues
- Registry inconsistencies

**When to use Full Deploy:**
- Server configuration changes
- Authentication parameter changes
- Multiple ioBroker nodes modified
- After unexplained connection issues

**When Modified Nodes is safe:**
- Single node parameter changes
- UI-only changes
- Small logic modifications

### 6.2 Deployment Verification

#### Post-Deploy Checks
```bash
# Check for deployment issues
grep "Node not found\|Duplicate subscription" nodered.log

# Verify connection recovery
grep "Connection recovered\|Client ready" nodered.log
```

## 7. UI and Interface Issues

### 7.1 Tree View Problems

#### Tree View Not Loading
**Troubleshooting:**
1. Check server configuration is selected
2. Clear browser cache and refresh
3. Verify network connectivity

**Error Messages:**
```
[ioBroker] States API error: Failed to retrieve states
[ioBroker] TreeView component not available
```

## 8. Adapter-Specific Issues

### 8.1 SendTo Problems

#### SendTo Command Issues
**Check These Items:**
1. Target adapter running and accessible
2. Command syntax matches adapter requirements
3. Message format follows adapter documentation
4. Timeout settings appropriate for operation

**Log Examples:**
```
INFO [OperationManager] Executing sendTo(telegram.0, send)
ERROR [OperationManager] SendTo timeout after 10000ms
```

### 8.2 Log Subscription Issues

#### Live Log Problems
**Solutions:**
1. Check log level filtering matches expectations
2. Verify log adapter compatibility
3. Monitor performance impact of debug levels
4. Use Admin Adapter for log management

## 9. Diagnostics and Support

### 9.1 Getting Status Information

#### Status Command
Send `msg.topic = "status"` to any ioBroker node for diagnostic information:

**Status Response:**
```json
{
  "connected": true,
  "authenticated": true,
  "sessionID": 1234567890,
  "subscriptionCount": 12,
  "queuedOperations": 0,
  "tokenAge": 1800000,
  "recovery": {
    "retryScheduled": false,
    "attempts": 0
  }
}
```

### 9.2 Debug Logging

#### Enable Debug Mode
**Node-RED settings.js:**
```javascript
logging: {
    console: {
        level: "debug",
        metrics: true
    }
}
```

#### Log Analysis Commands
```bash
# Connection issues
grep "Connection error\|timeout\|ECONNREFUSED" nodered.log

# Authentication problems
grep "Authentication\|Token\|OAuth" nodered.log

# Recovery attempts
grep "Recovery\|Retry\|Backoff" nodered.log
```

### 9.3 When to Seek Help

#### Before Creating Bug Reports
**Checklist:**
- [ ] Tried Full Deploy instead of Modified Nodes
- [ ] Verified all connection parameters
- [ ] Checked ioBroker adapter status
- [ ] Collected relevant log messages
- [ ] Obtained status information from nodes
- [ ] Documented steps to reproduce issue

#### Information for Bug Reports
- Node-RED and ioBroker versions
- Node configuration (sanitized)
- Relevant log messages with timestamps
- Steps to reproduce
- Connection status during issue

#### Getting Help
- **GitHub Issues**: [Known Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
- **Logging Guide**: [Detailed Log Analysis](logging.md)
- **ioBroker Community**: [ioBroker Forum](https://forum.iobroker.net)

---

**📖 Related Documentation:**
- **📊 [Logging Guide](logging.md)** - Detailed log analysis
- **🎯 [Use Cases](use-cases.md)** - Implementation examples
- **🔧 [README](../README.md)** - Setup and configuration details