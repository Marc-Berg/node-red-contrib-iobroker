# WS ioB log - Live Log Monitoring

Subscribe to ioBroker live log messages for real-time system monitoring and debugging.

## Purpose

The WS ioB log node allows you to monitor ioBroker's live log stream in real-time. This is essential for system monitoring, troubleshooting, error detection, and maintaining awareness of system activities across all adapters and components.

## Configuration

### Basic Settings

**Log Level**
- **silly**: Most verbose, includes all messages
- **debug**: Detailed debugging information
- **info**: General information messages
- **warn**: Warning messages that need attention
- **error**: Error messages requiring immediate attention

**Output Property**
- Target message property for log message text
- Default: `payload`
- Can be set to any valid message property

### Message Properties
- **payload**: The actual log message text
- **level**: Log level (error, warn, info, debug, silly)
- **source**: Full source identifier
- **timestamp**: ISO timestamp string
- **severity**: Numeric severity (1=error, 2=warn, 3=info, 4=debug, 5=silly)
- **from**: Short source name

## Filtering and Processing

### Level-Based Filtering
The configured log level acts as a minimum threshold:
- **error**: Only error messages
- **warn**: Warning and error messages
- **info**: Info, warning, and error messages
- **debug**: Debug, info, warning, and error messages
- **silly**: All messages

## Troubleshooting

### No Log Messages
1. Confirm log level is appropriate
2. Test with lower (more verbose) log level

### Too Many Messages
1. Increase log level threshold
2. Implement source filtering
3. Add content-based filtering

### Missing Important Logs
1. Check adapter logging configuration
2. Verify log level settings in ioBroker
3. Confirm adapter is generating logs
4. Test with silly level temporarily

## Examples

See [Common Use Cases](../use-cases.md) for practical implementation examples.