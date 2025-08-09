# WS ioB history - Historical Data

Access historical data from ioBroker history adapters with flexible time ranges, aggregation options, and multiple output formats.

## Purpose

The WS ioB history node allows you to retrieve historical data from ioBroker's history adapters (History, SQL, InfluxDB). This enables analysis of trends, generation of reports, and creation of data visualizations from stored time-series data.

## Configuration

### Basic Settings

**State ID**
- Target state for historical data retrieval
- Single state ID only (no wildcards)
- If empty in the node config, it is taken from `msg.topic`

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
- **Duration Unit**: minutes, hours, days, weeks
- **End Time**: Now or custom timestamp

**Absolute Settings** (for Absolute type)
- **Start Time**: Specific start timestamp
- **End Time**: Specific end timestamp

### Query Management

**Query Mode**
- **Parallel** (default): Multiple queries can run simultaneously
- **Sequential**: Queue queries and process them one by one in order
- **Drop**: Discard new queries while one is already running

### Data Processing

**Aggregation**
- `none`: Raw data points
- `onchange`: Only values that changed
- `average`: Average values over time intervals
- `min`: Minimum values over intervals
- `max`: Maximum values over intervals
- `minmax`: Min/Max pairs
- `total`: Sum of values over intervals
- `count`: Number of data points per interval
- `percentile`: Percentile value per interval (requires `percentile` option)
- `quantile`: Quantile per interval (requires `quantile` option)
- `integral`: Time integral per interval (requires `integralUnit`)

**Step Interval** (for aggregation)
- Time interval for aggregation
- Units: seconds, minutes, hours
- Common values: 300s (5min), 3600s (1h)

**Output Format**
- **Array**: Simple array of data points
- **Chart.js**: Formatted for Chart.js library
- **Dashboard 2.0**: Formatted for Node-RED Dashboard 2.0 ui-chart components
- **Statistics**: Summary statistics

## Query Management Modes

### Parallel Mode (Default)
- **Behavior**: Multiple queries execute simultaneously
- **Advantages**: Fastest processing for individual queries
- **Disadvantages**: May overload history adapter with many concurrent requests
- **Best for**: Low-frequency queries, powerful ioBroker systems
- **Status Display**: Shows "Processing..." or "Ready"

### Sequential Mode
- **Behavior**: Queries are queued and processed one after another
- **Advantages**: All queries are executed, reliable processing, no adapter overload
- **Disadvantages**: Slower overall processing time
- **Best for**: High-frequency queries, limited system resources, guaranteed execution
- **Status Display**: Shows "Queue: X" when queries are waiting

### Drop Mode
- **Behavior**: While a query is running, any new incoming queries are immediately discarded.
- **Advantages**: Prevents queue buildup and system overload.
- **Disadvantages**: Queries may be lost if sent while another query is processing.
- **Best for**: Scenarios where it is acceptable for intermediate or newer requests to be dropped if a request is already running (e.g., non-critical UI updates).
- **Status Display**: Shows "Running (dropping)" when discarding queries.
- **Output**: Dropped queries receive `msg.dropped = true` in the error response.

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
[
  {x: 1640995200000, y: 23.5},
  {x: 1640995500000, y: 23.7},
  {x: 1640995800000, y: 23.3}
]
// msg.topic = "<stateId>" (series name)
```

### Statistics Format
Summary statistics:
```javascript
{
  count: 288,
  numericCount: 288,
  min: 18.2,
  max: 26.8,
  avg: 22.5,
  sum: 6480.0,
  first: { ts: 1640995200000, val: 23.5 },
  last: { ts: 1641081600000, val: 22.1 }
}
```

## Enhanced Output Properties

All queries include additional metadata:
- `msg.queryId` - Unique identifier for tracking queries
- `msg.queryMode` - Processing mode used (parallel/sequential/drop)
- `msg.queryTime` - Time taken to execute the query (ms)
- `msg.dropped` - True if query was dropped (drop mode only)
- `msg.stateId` - The queried state ID
- `msg.instance` - History adapter instance used
- `msg.queryOptions` - Options sent to the adapter (start/end, aggregate, step, etc.)
- `msg.formatOptions` - Formatting settings (timestamp format, data format, removeBorderValues, timezone)

## Performance Optimization

### Query Mode Selection
- **High-frequency triggers**: Use Sequential or Drop mode
- **Periodic reports**: Use Parallel mode
- **Real-time dashboards**: Use Drop mode
- **Data analysis**: Use Sequential mode

### Query Efficiency
- Use appropriate time ranges to limit data volume
- Choose suitable aggregation levels
- Monitor queue status in Sequential mode
- Consider using Drop mode for UI updates

### Aggregation Strategy
- Use aggregation for large time ranges
- Match step size to analysis needs
- Consider data resolution requirements

### Memory Management
- Limit result set sizes
- Process data in chunks for large queries
- Clear unused data from context
- Monitor Node-RED memory usage

## Dashboard Integration

### Dashboard 2.0 ui-chart
The Dashboard 2.0 format provides direct compatibility with Node-RED Dashboard 2.0 ui-chart components using default settings:

```
[WS ioB history: Dashboard 2.0 Format] → [ui-chart]
```

**ui-chart Configuration:**
- **Series**: `msg.topic` ✓ (automatically set)
- **X**: `key` → `x` (one-time setup)
- **Y**: `key` → `y` (one-time setup)

### Chart.js Integration
For custom Chart.js implementations:

```
[WS ioB history: Chart.js Format] → [Chart.js Dashboard Node]
```

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
1. Switch to Sequential or Drop mode for high-frequency queries
2. Reduce time range scope
3. Increase aggregation step size
4. Check adapter configuration
5. Monitor queue status

### Query Management Issues
1. **Too many parallel queries**: Switch to Sequential mode
2. **Missing queries**: Avoid Drop mode for critical data
3. **Slow processing**: Check queue length in Sequential mode
4. **System overload**: Use Drop mode to reduce load

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