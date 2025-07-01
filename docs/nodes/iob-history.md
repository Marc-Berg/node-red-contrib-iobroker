# WS ioB history - Historical Data

Access historical data from ioBroker history adapters with flexible time ranges, aggregation options, and multiple output formats.

## Purpose

The WS ioB history node allows you to retrieve historical data from ioBroker's history adapters (History, SQL, InfluxDB). This enables analysis of trends, generation of reports, and creation of data visualizations from stored time-series data.

## Configuration

### Basic Settings

**State ID**
- Target state for historical data retrieval
- Single state ID only (no wildcards)
- Can be overridden by `msg.stateId`

**History Adapter**
- Auto-detected from available history adapters
- Shows status indicators for adapter availability
- Supports History, SQL, and InfluxDB adapters

### Time Range Configuration

**Time Range Type**
- **Duration**: Relative time from now (e.g., last 24 hours)
- **Absolute**: Specific start and end timestamps
- **From Message**: Time range provided in message properties

**Duration Settings** (for Duration type)
- **Duration**: Numeric value (e.g., 24)
- **Duration Unit**: hours, days, weeks, months, years
- **End Time**: Now or custom timestamp

**Absolute Settings** (for Absolute type)
- **Start Time**: Specific start timestamp
- **End Time**: Specific end timestamp
- **Time Format**: Various formats supported

### Data Processing

**Aggregation**
- **None**: Raw data points
- **OnChange**: Only values that changed
- **Average**: Average values over time intervals
- **Min**: Minimum values over intervals
- **Max**: Maximum values over intervals
- **Total**: Sum of values over intervals
- **Count**: Number of data points per interval

**Step Size** (for aggregation)
- Time interval for aggregation in seconds
- Common values: 300 (5min), 3600 (1h), 86400 (1d)

**Output Format**
- **Array**: Simple array of data points
- **Chart.js**: Formatted for Chart.js library
- **Statistics**: Summary statistics

## Time Range Examples

### Duration-Based Queries
```javascript
// Last 24 hours
duration: 24, durationUnit: "hours"

// Last 7 days  
duration: 7, durationUnit: "days"

// Last month
duration: 1, durationUnit: "months"
```

### Absolute Time Queries
```javascript
// Specific date range
startTime: "2024-01-01T00:00:00Z"
endTime: "2024-01-02T00:00:00Z"

// Unix timestamps
startTime: 1640995200000
endTime: 1641081600000
```

### Message-Based Queries
```javascript
// Set in incoming message
msg.startTime = new Date(Date.now() - 24*60*60*1000);
msg.endTime = new Date();
msg.stateId = "sensors.temperature";
```

## Aggregation Types

### Raw Data (None)
Returns all stored data points without processing:
- Useful for detailed analysis
- May return large amounts of data
- Preserves all data precision

### Change Detection (OnChange)
Returns only values that actually changed:
- Filters out repeated identical values
- Reduces data volume significantly
- Maintains data accuracy

### Statistical Aggregations
Process data over time intervals:

**Average**
- Mean value over each interval
- Useful for smoothing noisy data
- Good for trend analysis

**Min/Max**
- Extreme values over intervals
- Useful for range analysis
- Important for limit monitoring

**Total**
- Sum of values over intervals
- Perfect for counters and consumption
- Energy usage, page views, etc.

**Count**
- Number of data points per interval
- Useful for activity analysis
- Data quality assessment

## Output Formats

### Array Format
Simple array of data points:
```javascript
[
  { ts: 1640995200000, val: 23.5 },
  { ts: 1640995500000, val: 23.7 },
  { ts: 1640995800000, val: 23.3 }
]
```

### Chart.js Format
Formatted for direct use with Chart.js:
```javascript
{
  labels: ["12:00", "12:05", "12:10"],
  datasets: [{
    label: "Temperature",
    data: [23.5, 23.7, 23.3],
    borderColor: "rgb(75, 192, 192)"
  }]
}
```

### Statistics Format
Summary statistics:
```javascript
{
  count: 288,
  min: 18.2,
  max: 26.8,
  average: 22.5,
  sum: 6480.0,
  first: { ts: 1640995200000, val: 23.5 },
  last: { ts: 1641081600000, val: 22.1 }
}
```

## Advanced Usage

### Dynamic Queries
Configure queries through message properties:

```javascript
// Function node before WS ioB history
msg.stateId = "sensors.living.temperature";
msg.duration = 12;
msg.durationUnit = "hours";
msg.aggregate = "average";
msg.step = 3600; // 1 hour intervals
return msg;
```

### Multiple State Analysis
Query multiple states sequentially:

```javascript
// Prepare multiple queries
const states = [
    "sensors.living.temperature",
    "sensors.kitchen.temperature", 
    "sensors.bedroom.temperature"
];

let messages = [];
for (let state of states) {
    messages.push({
        ...msg,
        stateId: state,
        duration: 24,
        durationUnit: "hours"
    });
}
return [messages];
```

### Data Comparison
Compare different time periods:

```javascript
// Current week vs last week
const now = new Date();
const weekAgo = new Date(now.getTime() - 7*24*60*60*1000);
const twoWeeksAgo = new Date(now.getTime() - 14*24*60*60*1000);

// Current week
let currentWeek = {
    ...msg,
    startTime: weekAgo,
    endTime: now,
    topic: "currentWeek"
};

// Previous week  
let lastWeek = {
    ...msg,
    startTime: twoWeeksAgo,
    endTime: weekAgo,
    topic: "lastWeek"
};

return [[currentWeek], [lastWeek]];
```

## Data Processing

### Filtering and Validation
```javascript
// Filter valid data points
const validData = msg.payload.filter(point => 
    point.val !== null && 
    point.val !== undefined &&
    point.val >= -50 && 
    point.val <= 100
);
msg.payload = validData;
return msg;
```

### Data Transformation
```javascript
// Convert units (Celsius to Fahrenheit)
const convertedData = msg.payload.map(point => ({
    ...point,
    val: point.val * 9/5 + 32
}));
msg.payload = convertedData;
return msg;
```

### Trend Analysis
```javascript
// Calculate trend
const data = msg.payload;
if (data.length >= 2) {
    const first = data[0].val;
    const last = data[data.length - 1].val;
    const trend = last - first;
    
    msg.trend = {
        change: trend,
        percentage: (trend / first) * 100,
        direction: trend > 0 ? "increasing" : "decreasing"
    };
}
return msg;
```

## Performance Optimization

### Query Efficiency
- Use appropriate time ranges to limit data volume
- Choose suitable aggregation levels
- Avoid querying too frequently
- Cache results when possible

### Aggregation Strategy
- Use aggregation for large time ranges
- Match step size to analysis needs
- Consider data resolution requirements
- Balance detail vs performance

### Memory Management
- Limit result set sizes
- Process data in chunks for large queries
- Clear unused data from context
- Monitor Node-RED memory usage

## Error Handling

### Common Errors
- **State not found**: State ID doesn't exist in history
- **No data**: Time range contains no data points
- **Adapter offline**: History adapter not running
- **Query timeout**: Query took too long
- **Invalid time range**: Start time after end time

### Error Recovery
```javascript
// Handle empty results
if (!msg.payload || msg.payload.length === 0) {
    node.warn(`No historical data found for ${msg.stateId}`);
    msg.payload = [];
    return msg;
}

// Handle errors
if (msg.error) {
    node.error(`History query failed: ${msg.error}`);
    return null;
}

return msg;
```

## History Adapter Support

### History Adapter
- Simple file-based storage
- Good for basic historical data
- Limited aggregation capabilities
- Suitable for small installations

### SQL Adapter  
- Database storage (MySQL, PostgreSQL, SQLite)
- Advanced aggregation support
- Better performance for large datasets
- Configurable retention policies

### InfluxDB Adapter
- Time-series database optimized storage
- Excellent aggregation performance
- Advanced query capabilities
- Best for high-frequency data

## Use Cases

### Energy Monitoring
```javascript
// Daily energy consumption
{
  stateId: "energy.meter.consumption",
  duration: 30,
  durationUnit: "days", 
  aggregate: "total",
  step: 86400 // Daily totals
}
```

### Temperature Trends
```javascript
// Hourly temperature averages
{
  stateId: "sensors.outdoor.temperature",
  duration: 7,
  durationUnit: "days",
  aggregate: "average", 
  step: 3600 // Hourly averages
}
```

### System Performance
```javascript
// Memory usage over time
{
  stateId: "system.adapter.admin.0.memRss",
  duration: 24,
  durationUnit: "hours",
  aggregate: "average",
  step: 900 // 15-minute intervals
}
```

### Activity Analysis
```javascript
// Motion detection frequency
{
  stateId: "sensors.motion.detected",
  duration: 1,
  durationUnit: "weeks",
  aggregate: "count",
  step: 3600 // Hourly counts
}
```

## Best Practices

### Query Design
- Choose appropriate time ranges for your analysis
- Use aggregation to reduce data volume
- Match step size to visualization needs
- Consider data storage costs

### Data Quality
- Validate data before processing
- Handle missing or invalid values
- Document data quality assumptions
- Monitor adapter health

### Performance
- Cache frequently accessed data
- Use appropriate aggregation levels
- Limit query frequency
- Monitor system resources

## Troubleshooting

### No Data Returned
1. Check state exists and has logging enabled
2. Verify time range contains data
3. Confirm history adapter is running
4. Test with broader time range

### Poor Performance
1. Reduce time range scope
2. Increase aggregation step size
3. Check adapter configuration
4. Monitor database performance

### Data Quality Issues
1. Validate adapter logging settings
2. Check for data gaps
3. Verify state value ranges
4. Monitor adapter status

## Integration Examples

### Dashboard Charts
```
[WS ioB history] → [Chart.js Dashboard Node]
```

### Energy Reports
```
[Schedule] → [WS ioB history: energy data] → [Report Generator]
```

### Trend Alerts
```
[WS ioB history] → [Trend Analysis] → [Alert System]
```

## Related Nodes

- **WS ioB in**: Real-time state monitoring
- **WS ioB get**: Current state values
- **WS ioB out**: Write state values

## Examples

See [Common Use Cases](use-cases.md) for practical implementation examples.