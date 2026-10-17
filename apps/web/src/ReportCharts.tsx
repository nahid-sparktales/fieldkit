import { useId } from "react";
import type { ReportWidget } from "../../../packages/platform/src/reporting-contracts.js";
type Row = Record<string, any>;
export const reportValue = (value: number | null | undefined, unit: string) =>
  value === null || value === undefined
    ? "—"
    : unit === "percent"
      ? `${value.toFixed(1)}%`
      : unit === "milliseconds"
        ? value < 60000
          ? `${(value / 1000).toFixed(1)}s`
          : value < 3600000
            ? `${(value / 60000).toFixed(1)}m`
            : `${(value / 3600000).toFixed(1)}h`
        : new Intl.NumberFormat(undefined, {
            maximumFractionDigits: 1,
            notation: Math.abs(value) >= 1000000 ? "compact" : "standard",
          }).format(value);
const colors = [
  "#3563d9",
  "#157b70",
  "#c87429",
  "#8562c1",
  "#bc4b78",
  "#66849b",
];
export function ReportChart({
  widget,
  result,
  inspect,
}: {
  widget: ReportWidget;
  result: Row;
  inspect: (selection?: { group?: string; series?: string }) => void;
}) {
  const id = useId(),
    rows: Row[] = result.groups ?? [],
    unit = result.metric.unit,
    total = result.total,
    valid = rows.filter((r) => r.value !== null),
    max = Math.max(1, ...valid.map((r) => r.value)),
    format = (v: number | null) => reportValue(v, unit);
  const exact = (
    <details className="report-exact">
      <summary>View exact values</summary>
      <div className="report-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              {widget.stackBy && <th>Series</th>}
              <th>Value</th>
              <th>Eligible</th>
              <th>Unknown</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <button
                    className="report-text-button"
                    onClick={() =>
                      inspect({
                        group: r.key,
                        ...(widget.stackBy ? { series: r.series_key } : {}),
                      })
                    }
                  >
                    {r.label}
                  </button>
                </td>
                {widget.stackBy && <td>{r.series}</td>}
                <td>{format(r.value)}</td>
                <td>{r.eligible}</td>
                <td>{r.unknown}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
  if (widget.type === "kpi")
    return (
      <div className="report-kpi">
        <button
          onClick={() => inspect()}
          aria-label={`View records for ${widget.title}`}
        >
          <strong>{format(total?.value)}</strong>
        </button>
        {unit === "percent" ? (
          <span>
            {total?.numerator ?? 0} / {total?.denominator ?? 0} eligible
          </span>
        ) : unit === "milliseconds" ? (
          <span>
            {total?.eligible ?? 0} timed records · {total?.unknown ?? 0} unknown
          </span>
        ) : (
          <span>{total?.eligible ?? 0} contributing records</span>
        )}
        {result.comparison ? (
          <small>
            Previous period: {format(result.comparison.total?.value)}
          </small>
        ) : result.metric.dataset === "current" ? (
          <small>Current snapshot · date filter does not apply</small>
        ) : null}
      </div>
    );
  if (!valid.length)
    return (
      <div className="report-empty-chart">
        <p>No eligible records for these filters.</p>
        {total?.unknown > 0 && (
          <small>{total.unknown} records have unknown outcomes.</small>
        )}
      </div>
    );
  if (widget.type === "table")
    return (
      <div className="report-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              {widget.stackBy && <th>Series</th>}
              <th>Value</th>
              <th>Eligible / unknown</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <button
                    className="report-text-button"
                    onClick={() =>
                      inspect({
                        group: r.key,
                        ...(widget.stackBy ? { series: r.series_key } : {}),
                      })
                    }
                  >
                    {r.label}
                  </button>
                </td>
                {widget.stackBy && <td>{r.series}</td>}
                <td>{format(r.value)}</td>
                <td>
                  {r.eligible} / {r.unknown}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (widget.type === "line") {
    const points = valid
      .map(
        (r, i) =>
          `${35 + (i * 530) / Math.max(1, valid.length - 1)},${165 - (r.value / max) * 140}`,
      )
      .join(" ");
    return (
      <>
        <svg
          className="report-chart-svg"
          viewBox="0 0 600 210"
          role="img"
          aria-labelledby={id}
        >
          <title id={id}>
            {widget.title}. Exact values are in the table below.
          </title>
          <line
            x1="35"
            y1="165"
            x2="565"
            y2="165"
            stroke="currentColor"
            opacity=".2"
          />
          <text x="35" y="15">
            {format(max)}
          </text>
          <polyline
            fill="none"
            stroke={colors[0]}
            strokeWidth="3"
            points={points}
          />
          {valid.map((r, i) => (
            <circle
              key={i}
              cx={35 + (i * 530) / Math.max(1, valid.length - 1)}
              cy={165 - (r.value / max) * 140}
              r="5"
              fill={colors[0]}
              tabIndex={0}
              role="button"
              aria-label={`${r.label}: ${format(r.value)}. View records`}
              onClick={() => inspect({ group: r.key })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inspect({ group: r.key });
                }
              }}
            >
              <title>
                {r.label}: {format(r.value)}
              </title>
            </circle>
          ))}
          <text x="35" y="195">
            {valid[0].label}
          </text>
          <text x="565" y="195" textAnchor="end">
            {valid.at(-1)!.label}
          </text>
        </svg>
        {exact}
      </>
    );
  }
  if (widget.type === "donut") {
    const sum = valid.reduce((a, r) => a + Math.max(0, r.value), 0);
    let before = 0;
    return (
      <>
        <div className="report-donut">
          <svg viewBox="0 0 180 180" role="img" aria-labelledby={id}>
            <title id={id}>{widget.title}. Exact values follow.</title>
            <circle
              cx="90"
              cy="90"
              r="62"
              fill="none"
              stroke="#e8edf5"
              strokeWidth="26"
            />
            {sum > 0 &&
              valid.map((r, i) => {
                const portion = (Math.max(0, r.value) / sum) * 100,
                  offset = -before;
                before += portion;
                return (
                  <circle
                    key={i}
                    cx="90"
                    cy="90"
                    r="62"
                    fill="none"
                    pathLength="100"
                    stroke={colors[i % colors.length]}
                    strokeWidth="26"
                    strokeDasharray={`${portion} ${100 - portion}`}
                    strokeDashoffset={offset}
                    transform="rotate(-90 90 90)"
                  />
                );
              })}
            <text x="90" y="94" textAnchor="middle">
              {format(total.value)}
            </text>
          </svg>
          <ul>
            {valid.slice(0, 12).map((r, i) => (
              <li key={i}>
                <button onClick={() => inspect({ group: r.key })}>
                  <i style={{ background: colors[i % colors.length] }} />
                  <span>{r.label}</span>
                  <strong>{format(r.value)}</strong>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {valid.length > 12 && (
          <small>
            First 12 legend entries. All groups are in exact values.
          </small>
        )}
        {exact}
      </>
    );
  }
  if (widget.type === "stacked_bar") {
    const keys = [...new Set(rows.map((r) => r.key))],
      series = [...new Set(rows.map((r) => r.series_key))],
      maxSum = Math.max(
        1,
        ...keys.map((key) =>
          rows
            .filter((r) => r.key === key)
            .reduce((a, r) => a + (r.value ?? 0), 0),
        ),
      );
    return (
      <>
        <div className="report-bars">
          {keys.map((key) => (
            <div key={key} className="report-stack-row">
              <span>{rows.find((r) => r.key === key)!.label}</span>
              <div>
                {rows
                  .filter((r) => r.key === key)
                  .map((r) => (
                    <button
                      key={r.series_key}
                      style={{
                        width: `${(Math.max(0, r.value ?? 0) / maxSum) * 100}%`,
                        background:
                          colors[series.indexOf(r.series_key) % colors.length],
                      }}
                      onClick={() =>
                        inspect({ group: r.key, series: r.series_key })
                      }
                      aria-label={`${r.label}, ${r.series}: ${format(r.value)}. View records`}
                      title={`${r.series}: ${format(r.value)}`}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
        <div className="report-legend">
          {series.map((s, i) => (
            <span key={s}>
              <i style={{ background: colors[i % colors.length] }} />
              {rows.find((r) => r.series_key === s)!.series}
            </span>
          ))}
        </div>
        {unit === "percent" && (
          <small>
            Each series uses its own denominator; stacked percentages are not a
            combined rate.
          </small>
        )}
        {exact}
      </>
    );
  }
  return (
    <>
      <div className="report-bars">
        {rows.map((r, i) => (
          <button
            key={i}
            className="report-bar-row"
            onClick={() => inspect({ group: r.key })}
          >
            <span>{r.label}</span>
            <i>
              <b
                style={{ width: `${(Math.max(0, r.value ?? 0) / max) * 100}%` }}
              />
            </i>
            <strong>{format(r.value)}</strong>
          </button>
        ))}
      </div>
      {exact}
    </>
  );
}
