# Logging Guide

This guide explains the logging system used in the Node-RED ioBroker integration nodes and how to interpret log messages for troubleshooting and monitoring.

## 🎯 Log Level Overview

The logging system uses a hierarchical structure to provide appropriate information for different audiences:

### Log Levels

| Level | Purpose | Audience | Examples |
|-------|---------|----------|----------|
| **ERROR** | Critical failures that impact functionality | Users, Admins | Authentication failed, Connection lost |
| **WARN** | Issues requiring attention but not breaking functionality | Users, Admins | Token expiry warning, Performance degradation |
| **INFO** | Important business events and lifecycle information | Users, Admins | Connection established, Node subscribed |
| **DEBUG** | Technical details for development and troubleshooting | Developers | Parameter values, Internal state changes |

## 📋 Log Message Categories

### Connection Lifecycle (INFO Level)
These messages indicate important connection state changes:

```
INFO [ConnectionManager] Creating connection 1 to 192.168.1.100:8091 (SSL, OAuth2)
INFO [ConnectionManager] Connection established to 192.168.1.100:8091
INFO [AuthManager] OAuth authentication successful for user: nodeред
INFO [ConnectionManager] Connection state changed: connecting -> connected (5 nodes affected)
INFO [RecoveryManager] Connection recovered for 192.168.1.100:8091
```

### Node Operations (INFO Level)
Important node activities and state changes:

```
INFO [NodeRegistry] Node abc123 successfully subscribed to 192.168.1.100:8091
INFO [OperationManager] Setting state device.light.power = true on 192.168.1.100:8091
INFO [OperationManager] Retrieved 1247 states for 192.168.1.100:8091
INFO [WebSocketManager] Client ready for 192.168.1.100:8091 - processing 5 nodes
```

### Authentication & Security (INFO Level)
Authentication events and security-related activities:

```
INFO [AuthManager] Starting proactive token refresh with session renewal
INFO [AuthManager] Token and session refreshed successfully (1234567 -> 1234568)
INFO [AuthManager] WebSocket connection rebuilt successfully
```

### Technical Details (DEBUG Level)
Internal operations and parameter information:

```
DEBUG [NodeRegistry] Subscription details: wildcard pattern: device.*.state
DEBUG [OperationManager] getObjects called with pattern: *, objectType: state
DEBUG [ConnectionManager] WebSocket URL constructed: wss:// with session 1234567
DEBUG [NodeRegistry] Node count for 192.168.1.100:8091: 3
DEBUG [OperationManager] Operation completed in 145ms
```

### Performance & Queue Management (DEBUG Level)
Queue processing and performance metrics:

```
DEBUG [OperationManager] Queueing setState(device.light) for 192.168.1.100:8091 - connection in progress
DEBUG [OperationManager] Processing 3 queued operations for 192.168.1.100:8091
DEBUG [CacheManager] Cache hit for 192.168.1.100:8091
DEBUG [PerformanceMonitor] Token refresh completed in 234ms
```

## 🔍 Reading Log Messages

### Message Format
```
[timestamp] - [level] [component] message
```

**Example:**
```
09 Dec 14:30:15 - [info] [ConnectionManager] Connection established to 192.168.1.100:8091
```

### Component Identification
- **ConnectionManager**: WebSocket connection handling
- **AuthManager**: Authentication and token management
- **NodeRegistry**: Node subscription and lifecycle management
- **OperationManager**: ioBroker operations (setState, getState, etc.)
- **RecoveryManager**: Connection recovery and retry logic
- **WebSocketManager**: Overall coordination and orchestration

## 🚨 Common Error Messages

### Authentication Errors
```
ERROR [AuthManager] Authentication failed permanently for 192.168.1.100:8091: Invalid credentials
ERROR [AuthManager] Token refresh failed: unauthorized
```
**Solution**: Check username/password, verify user permissions in ioBroker

### Connection Errors
```
ERROR [ConnectionManager] Connection error for 192.168.1.100:8091: ECONNREFUSED
ERROR [SocketClient] WebSocket error: Connection timeout
```
**Solution**: Verify ioBroker is running, check network connectivity, firewall settings

### Operation Errors
```
ERROR [OperationManager] setState(device.invalid) failed for 192.168.1.100:8091: Object not found
ERROR [NodeRegistry] Subscribe failed for node abc123: Pattern too broad
```
**Solution**: Check object existence, verify state paths, optimize wildcard patterns

## ⚠️ Important Warning Messages

### Performance Warnings
```
WARN [OperationManager] Operation timeout after 10000ms: getStates
WARN [NodeRegistry] Query dropped - another query was already running
WARN [CacheManager] Cache miss for frequently accessed data
```

### Authentication Warnings
```
WARN [AuthManager] Token expires in 300 seconds - consider increasing session duration
WARN [ConnectionManager] Session duration too short, may cause frequent reconnections
```

### Configuration Warnings
```
WARN [PatternMatcher] Invalid alias configuration for alias.device.light
WARN [NodeRegistry] Wildcard pattern too broad, may impact performance: *.*.*
```

## 🔧 Configuring Log Levels

### Node-RED Settings
Configure logging in your Node-RED `settings.js`:

```javascript
// Production recommended
logging: {
    console: {
        level: "info",
        metrics: false,
        audit: false
    }
}

// Development/debugging
logging: {
    console: {
        level: "debug",
        metrics: true,
        audit: true
    }
}
```

### Environment-Specific Recommendations

| Environment | Recommended Level | Rationale |
|-------------|------------------|-----------|
| **Production** | INFO | Focus on business events, reduce log volume |
| **Staging** | INFO | Mirror production, but allow detailed testing |
| **Development** | DEBUG | Full technical details for troubleshooting |
| **Troubleshooting** | DEBUG | Temporary detailed logging for issue resolution |

## 📊 Log Analysis Patterns

### Successful Connection Sequence
```
INFO [ConnectionManager] Creating connection 1 to 192.168.1.100:8091
INFO [AuthManager] OAuth authentication successful for user: admin
INFO [ConnectionManager] Connection state changed: connecting -> connected
INFO [WebSocketManager] Client ready for 192.168.1.100:8091
INFO [NodeRegistry] Node abc123 successfully subscribed to 192.168.1.100:8091
```

### Recovery Sequence
```
ERROR [ConnectionManager] Connection error for 192.168.1.100:8091: Connection lost
INFO [RecoveryManager] Scheduling retry for 192.168.1.100:8091 in 5s
INFO [RecoveryManager] Executing scheduled retry for 192.168.1.100:8091
INFO [RecoveryManager] Connection recovered for 192.168.1.100:8091
INFO [NodeRegistry] Executing 3 recovery callbacks for 192.168.1.100:8091
```

### Token Refresh Sequence
```
INFO [AuthManager] Starting proactive token refresh with session renewal
DEBUG [AuthManager] Getting OAuth token for user: admin via HTTPS
INFO [AuthManager] Token and session refreshed successfully
INFO [AuthManager] WebSocket connection rebuilt successfully
DEBUG [AuthManager] Token refresh scheduled in 55 minutes
```

## 🎛️ Monitoring and Alerting

### Key Metrics to Monitor

**Connection Health:**
- Connection establishment frequency
- Token refresh success rate
- Recovery operation frequency
- WebSocket connection stability

**Performance Metrics:**
- Operation response times
- Queue depth and processing time
- Subscription count per connection
- Memory usage patterns

**Error Tracking:**
- Authentication failure rate
- Network error frequency
- Operation timeout occurrences
- Invalid state/object access attempts

### Recommended Alerts

**Critical Alerts (immediate action required):**
```
ERROR [AuthManager] Authentication failed permanently
ERROR [ConnectionManager] Connection error.*ECONNREFUSED
ERROR [RecoveryManager] Recovery failed.*auth_failed
```

**Warning Alerts (attention required):**
```
WARN [AuthManager] Token expires in.*300 seconds
WARN [OperationManager] Operation timeout after
WARN [NodeRegistry] Query dropped.*already running
```

## 🛠️ Troubleshooting with Logs

### Step-by-Step Log Analysis

1. **Check Connection Sequence**
   - Look for "Creating connection" messages
   - Verify authentication success
   - Confirm "Client ready" message

2. **Identify Error Patterns**
   - Search for ERROR level messages
   - Check error frequency and timing
   - Correlate with network or system events

3. **Analyze Performance Issues**
   - Review operation timing (DEBUG level)
   - Check queue processing patterns
   - Monitor subscription counts

4. **Validate Configuration**
   - Verify connection parameters in logs
   - Check authentication method used
   - Confirm node subscription patterns

### Common Log-Based Diagnostics

**Issue: Frequent Disconnections**
```bash
# Look for connection error patterns
grep "Connection error\|Connection lost" nodered.log

# Check token refresh frequency
grep "Token refresh\|Token expires" nodered.log
```

**Issue: Slow Performance**
```bash
# Check operation timing
grep "Operation.*completed in\|timeout after" nodered.log

# Monitor queue processing
grep "Queueing\|Processing.*queued" nodered.log
```

**Issue: Authentication Problems**
```bash
# Check auth sequence
grep "OAuth\|Authentication\|Token" nodered.log | tail -20

# Look for specific auth errors
grep "Invalid credentials\|unauthorized\|Access denied" nodered.log
```

## 📝 Best Practices

### Log Management
1. **Rotate logs regularly** to prevent disk space issues
2. **Use appropriate log levels** for each environment
3. **Monitor log file sizes** and growth patterns
4. **Archive historical logs** for trend analysis

### Performance Considerations
1. **Avoid DEBUG level in production** unless troubleshooting
2. **Monitor log volume impact** on system performance
3. **Use log filtering** to focus on relevant messages
4. **Regular log analysis** to identify optimization opportunities

### Security Considerations
1. **Logs may contain sensitive information** (usernames, patterns)
2. **Restrict log file access** to authorized personnel
3. **Sanitize logs** before sharing for support
4. **Monitor for authentication-related patterns** that might indicate security issues

---

**📖 Related Documentation:**
- [Troubleshooting Guide](troubleshooting.md) - General troubleshooting steps
- [Use Cases](use-cases.md) - Practical implementation examples
- [GitHub Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues) - Known issues and solutions