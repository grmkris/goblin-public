import type { ReactElement } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartSpec } from './specs.ts'

/** The n-th series colour: goblin's five chart tokens, in order. */
const color = (index: number) => `var(--chart-${(index % 5) + 1})`

const tick = { fill: 'var(--muted-foreground)', fontSize: 12 }
const tooltip = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--popover-foreground)',
    fontSize: 12,
  },
  cursor: { fill: 'var(--muted)', opacity: 0.5 },
}

function cartesian(spec: ChartSpec, rows: Record<string, string | number | null>[]): ReactElement {
  const stack = spec.stacked === true ? { stackId: 'stack' } : {}
  const axes = [
    <CartesianGrid key="grid" stroke="var(--border)" vertical={false} />,
    <XAxis key="x" dataKey={spec.x} tick={tick} tickLine={false} axisLine={false} />,
    <YAxis
      key="y"
      tick={tick}
      tickLine={false}
      axisLine={false}
      width={44}
      {...(spec.unit !== undefined && { unit: spec.unit })}
    />,
    <Tooltip key="tooltip" {...tooltip} />,
    ...(spec.series.length > 1 ? [<Legend key="legend" wrapperStyle={{ fontSize: 12 }} />] : []),
  ]
  if (spec.type === 'bar')
    return (
      <BarChart data={rows}>
        {axes}
        {spec.series.map((series, index) => (
          <Bar
            key={series.key}
            dataKey={series.key}
            name={series.label ?? series.key}
            fill={color(index)}
            radius={3}
            {...stack}
          />
        ))}
      </BarChart>
    )
  if (spec.type === 'area')
    return (
      <AreaChart data={rows}>
        {axes}
        {spec.series.map((series, index) => (
          <Area
            key={series.key}
            dataKey={series.key}
            name={series.label ?? series.key}
            stroke={color(index)}
            fill={color(index)}
            fillOpacity={0.2}
            {...stack}
          />
        ))}
      </AreaChart>
    )
  return (
    <LineChart data={rows}>
      {axes}
      {spec.series.map((series, index) => (
        <Line
          key={series.key}
          dataKey={series.key}
          name={series.label ?? series.key}
          stroke={color(index)}
          strokeWidth={2}
          dot={false}
        />
      ))}
    </LineChart>
  )
}

function pie(spec: ChartSpec, rows: Record<string, string | number | null>[]): ReactElement {
  const value = spec.series[0]?.key ?? ''
  // Each slice takes its colour from its row.
  const slices = rows.map((row, index) => ({ ...row, fill: color(index) }))
  return (
    <PieChart>
      <Tooltip {...tooltip} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Pie data={slices} dataKey={value} nameKey={spec.x} innerRadius="45%" stroke="var(--background)" />
    </PieChart>
  )
}

/** A chart drawn from a spec in goblin's chart colours, following the theme through its tokens. */
export function Chart({ spec }: { readonly spec: ChartSpec }) {
  const rows = spec.data.map((row) => ({ ...row }))
  return (
    <figure className="kit-chart">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <div className="kit-chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === 'pie' ? pie(spec, rows) : cartesian(spec, rows)}
        </ResponsiveContainer>
      </div>
    </figure>
  )
}
