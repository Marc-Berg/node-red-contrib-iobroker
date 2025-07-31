# Logging Guide

This guide explains the logging system used in the Node-RED ioBroker integration nodes and how to interpret log messages for troubleshooting.

## 1. Log Configuration

### 1.1 Configure Log Levels in Node-RED

**Important**: Configure logging in your `settings.js` file first:

```javascript
// Production (recommended)
logging: {
    console: {
        level: "info",
        metrics: false
    }
}

// Development/Troubleshooting
logging: {
    console: {
        level: "debug",
        metrics: true
    }
}
```

### 1.2 Log Levels and Environment Recommendations

| Level | Purpose | Audience | Production | Development |
|-------|---------|----------|------------|-------------|
| **ERROR** | Critical failures that impact functionality | Users, Admins | ✅ Always | ✅ Always |
| **WARN** | Issues requiring attention but not breaking functionality | Users, Admins | ✅ Always | ✅ Always |
| **INFO** | Important business events and lifecycle information | Users, Admins | ✅ **Recommended** | ✅ Always |
| **DEBUG** | Technical details for development and troubleshooting | Developers | ❌ Avoid | ✅ **For troubleshooting** |

**⚠️ Important**: Always return to INFO level after troubleshooting to avoid performance impact.

## 2. Component Identification

- **ConnectionManager**: WebSocket connection handling
- **AuthManager**: Authentication and token management
- **NodeRegistry**: Node subscription and lifecycle management
- **OperationManager**: ioBroker operations (setState, getState, etc.)
- **RecoveryManager**: Connection recovery and retry logic
- **WebSocketManager**: Overall coordination

## 3. Common Log Messages

### 3.1 Connection Lifecycle (INFO Level)

#### Successful Connection Sequence
```
INFO [ConnectionManager] Creating connection 1 to 192.168.1.100:8091
INFO [AuthManager] OAuth authentication successful for user: admin
INFO [ConnectionManager] Connection state changed: connecting -> connected
INFO [WebSocketManager] Client ready for 192.168.1.100:8091
```

#### Connection Recovery
```
ERROR [ConnectionManager] Connection error: Connection lost
INFO [RecoveryManager] Scheduling retry in 5s
INFO [RecoveryManager] Connection recovered for 192.168.1.100:8091
```

### 3.2 Node Operations (INFO Level)

#### Node Subscription and Operations
```  
INFO [NodeRegistry] Node abc123 successfully subscribed
INFO [OperationManager] Setting state device.light.power = true
INFO [OperationManager] Retrieved 1247 states for server
```

### 3.3 Authentication Events (INFO Level)

#### Token Management
```
INFO [AuthManager] Starting proactive token refresh
INFO [AuthManager] Token and session refreshed successfully
INFO [AuthManager] WebSocket connection rebuilt successfully
```

## 4. Error Messages and Solutions

### 4.1 Authentication Errors

#### Invalid Credentials
```
ERROR [AuthManager] Authentication failed: Invalid credentials
ERROR [AuthManager] Token refresh failed: unauthorized
```
**Solution**: Check username/password, verify user permissions in ioBroker

### 4.2 Connection Errors

#### Network Issues
```
ERROR [ConnectionManager] Connection error: ECONNREFUSED
ERROR [SocketClient] WebSocket error: Connection timeout
```
**Solution**: Verify ioBroker is running, check network connectivity, firewall settings

### 4.3 Operation Errors

#### State and Object Issues
```
ERROR [OperationManager] setState(device.invalid) failed: Object not found
ERROR [NodeRegistry] Subscribe failed: Pattern too broad
```
**Solution**: Check object existence, verify state paths, optimize wildcard patterns

## 5. Warning Messages

### 5.1 Performance Warnings

#### Timeout and Queue Issues
```
WARN [OperationManager] Operation timeout after 10000ms: getStates
WARN [NodeRegistry] Query dropped - another query already running
WARN [NodeRegistry] Wildcard pattern too broad: *.*.*
```

## 6. Monitoring and Troubleshooting

### 6.1 Key Monitoring Metrics

#### Connection Health
- Connection establishment frequency
- Token refresh success rate
- Recovery operation frequency
- WebSocket connection stability

#### Performance Metrics
- Operation response times
- Queue processing times
- Subscription count per connection

#### Critical Alerts
```
ERROR [AuthManager] Authentication failed permanently
ERROR [ConnectionManager] Connection error.*ECONNREFUSED
ERROR [RecoveryManager] Recovery failed.*auth_failed
```

## 7. Troubleshooting with Logs

### 7.1 Step-by-Step Analysis

#### 1. Check Connection Sequence
- Look for "Creating connection" messages
- Verify authentication success
- Confirm "Client ready" message

#### 2. Identify Error Patterns
- Search for ERROR level messages
- Check error frequency and timing
- Correlate with system events

#### 3. Analyze Performance
- Review operation timing (DEBUG level)
- Check queue processing patterns
- Monitor subscription counts

### 7.2 Common Diagnostic Commands

#### Connection Issues
```bash
# Connection error patterns
grep "Connection error\|Connection lost" nodered.log

# Token refresh problems
grep "Token refresh\|Token expires" nodered.log
```

#### Performance Issues
```bash
# Operation timing
grep "completed in\|timeout after" nodered.log

# Queue processing
grep "Queueing\|Processing.*queued" nodered.log
```

#### Authentication Problems
```bash
# Auth sequence
grep "OAuth\|Authentication\|Token" nodered.log | tail -20

# Auth errors
grep "Invalid credentials\|unauthorized" nodered.log
```

## 8. Best Practices

### 8.1 Log Management

#### Production Guidelines
1. **Use INFO level** for production environments
2. **Rotate logs regularly** to prevent disk space issues
3. **Monitor log file sizes** and growth patterns
4. **Archive historical logs** for trend analysis

#### Troubleshooting Guidelines
1. **Enable DEBUG temporarily** for specific issues
2. **Return to INFO level** after troubleshooting
3. **Use log filtering** to focus on relevant messages
4. **Monitor performance impact** of debug logging

### 8.2 Security Considerations

#### Sensitive Information
1. **Logs may contain sensitive data** (usernames, patterns)
2. **Restrict log file access** to authorized personnel
3. **Sanitize logs** before sharing for support
4. **Monitor authentication patterns** for security issues

---

**📖 Related Documentation:**
- **🔧 [Troubleshooting Guide](troubleshooting.md)** - General troubleshooting steps
- **🎯 [Use Cases](use-cases.md)** - Practical implementation examples
- **📋 [GitHub Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)** - Known issues and solutions