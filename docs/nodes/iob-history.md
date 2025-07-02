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
- **Dashboard 2.0**: Formatted for Node-RED Dashboard 2.0 ui-chart components
- **Statistics**: Summary statistics

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

**Total/Sum**
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

### Dashboard 2.0 Format
Formatted for Node-RED Dashboard 2.0 ui-chart components:
```javascript
[{
  series: ["Temperature"],
  data: [
    [1640995200000, 23.5],
    [1640995500000, 23.7],
    [1640995800000, 23.3]
  ],
  labels: [""]
}]
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

### Modern Dashboard 2.0 Dashboards
```
[WS ioB history: Dashboard 2.0] → [ui-chart: Line Chart]
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

See [Common Use Cases](../use-cases.md) for practical implementation examples.