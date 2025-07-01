# Troubleshooting Guide

This guide helps you resolve common issues with the Node-RED ioBroker integration nodes.

## Connection Issues

### WebSocket Adapter Not Working
1. **Check WebSocket adapter** is installed and running in ioBroker
2. **Verify port number** matches your configuration (8081/8082/8084)
3. **Test network connectivity** from Node-RED to ioBroker server
4. **Check authentication** credentials if using secured installation

### Cannot Connect to ioBroker
1. Verify ioBroker server is running and accessible
2. Check firewall settings on both Node-RED and ioBroker systems
3. Ensure the selected port is open and not blocked
4. Test connection using browser: `http://your-iobroker-ip:port`

### Connection Drops Frequently
1. Check network stability between Node-RED and ioBroker
2. Increase session duration to ≥3600 seconds (1 hour) in ioBroker settings
3. Verify adapter configuration in ioBroker
4. Check for high system load on either server

## Authentication Problems

### "Invalid credentials" Error
1. **Verify username/password** in ioBroker admin interface
2. **Check user exists** and has proper permissions
3. **Test login** directly in ioBroker web interface
4. **Clear browser cache** and try again

### "Access forbidden" Error
1. **Check user permissions** in ioBroker user management
2. **Verify user has WebSocket access** enabled
3. **Check adapter-specific permissions** if using restricted access
4. **Review ioBroker security settings**

### "Token expired" Error
1. **Increase session duration** to ≥3600 seconds in ioBroker settings
2. **Check system time synchronization** between servers
3. **Clear authentication cache** by redeploying Node-RED flow

## Node Status Messages

Understanding the visual status indicators on each node:

### Status Colors and Meanings
- **Green dot "Ready"**: Connected and operational
- **Yellow ring "Connecting"**: Establishing connection to ioBroker
- **Red ring "Disconnected"**: Connection lost, automatic retry in progress
- **Red ring "Auth failed"**: Authentication error, check credentials
- **Blue dot "Processing"**: Node is actively processing data
- **Gray dot "Disabled"**: Node is disabled or not configured

## Configuration Issues

### Missing Objects in ioBroker
1. **Enable auto-create** in WS ioB out node configuration
2. **Check object permissions** in ioBroker
3. **Verify state path** follows ioBroker naming conventions
4. **Review adapter configuration** for target states

### Wildcard Patterns Not Working
1. **Check pattern syntax** - use `*`, `?` is not supported
2. **Avoid overly broad patterns** like `*` or `*.*` for performance
3. **Test pattern** with smaller subsets first
4. **Verify state existence** in ioBroker objects view

### Historical Data Issues
1. **Check history adapter** is installed and running
2. **Verify data retention** settings in history adapter
3. **Confirm state logging** is enabled for target states

## Performance Issues

### Slow Response Times
1. **Limit wildcard scope** to reduce data volume
2. **Check network latency** between systems
3. **Monitor system resources** on both servers
4. **Optimize query frequency** for historical data

### High Memory Usage
1. **Reduce subscription count** by optimizing wildcard patterns
2. **Implement message filtering** in Node-RED flows
3. **Check for memory leaks** in custom function nodes

## Getting Diagnostic Information

### Status Information Command
Send a message with `msg.topic = "status"` to any ioBroker node to get detailed connection information including:
- Connection state and uptime
- WebSocket protocol version
- Authentication status
- Error history

### Debug Logging
Enable debug logging in Node-RED to see detailed communication:
1. Set logging level to "debug" in settings.js
2. Monitor Node-RED logs during operation
3. Check ioBroker logs for server-side issues

### Common Log Messages
- `WebSocket connection established`: Successful connection
- `Authentication successful`: Login completed
- `Subscription active for pattern`: Wildcard subscription working
- `Object created automatically`: Auto-create feature working
- `History adapter detected`: Historical data available

## When to Seek Help

If you've tried the above solutions and still experience issues:

1. **Check GitHub Issues**: [Known Issues](https://github.com/Marc-Berg/node-red-contrib-iobroker/issues)
2. **Create Bug Report**
3. **ioBroker Community**: [ioBroker Forum](https://forum.iobroker.net)

### Information to Include in Bug Reports
- Node-RED version
- ioBroker version
- adapter type and version
- Operating system details
- Node configuration (sanitized)
- Error messages and logs
- Steps to reproduce the issue