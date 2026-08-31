/**
 * The widget renderers: the four `Finding.context` shapes (text / kv / table / json),
 * shared by the Judge node (T9) and the decision view (T10). Every value is trusted
 * as data, never as markup: React's default text-node rendering is the whole safety
 * story here, so nothing in this file reaches for `dangerouslySetInnerHTML`.
 */
import type { Context, Widget } from "../../sim/finding";

/** One widget, dispatched to its typed renderer. */
function WidgetItem({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "text":
      return <TextWidget widget={widget} />;
    case "kv":
      return <KvWidget widget={widget} />;
    case "table":
      return <TableWidget widget={widget} />;
    case "json":
      return <JsonWidget widget={widget} />;
  }
}

/** An optional widget title, rendered only when present. */
function WidgetTitle({ title }: { title: string | undefined }) {
  return title !== undefined ? <h4 className="widget-title">{title}</h4> : null;
}

function TextWidget({ widget }: { widget: Extract<Widget, { type: "text" }> }) {
  return (
    <div className="widget widget-text">
      <WidgetTitle title={widget.title} />
      <p className="widget-text-body">{widget.text}</p>
    </div>
  );
}

function KvWidget({ widget }: { widget: Extract<Widget, { type: "kv" }> }) {
  return (
    <div className="widget widget-kv">
      <WidgetTitle title={widget.title} />
      <dl className="widget-kv-list">
        {widget.entries.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no stable identity; the widget is a snapshot rendered once, never reordered.
          <div className="widget-kv-entry" key={`${entry.label}-${index}`}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TableWidget({ widget }: { widget: Extract<Widget, { type: "table" }> }) {
  return (
    <div className="widget widget-table">
      <WidgetTitle title={widget.title} />
      <table className="widget-table-grid">
        <thead>
          <tr>
            {widget.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {widget.rows.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no stable identity; the widget is a snapshot rendered once, never reordered.
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: same as the row above.
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonWidget({ widget }: { widget: Extract<Widget, { type: "json" }> }) {
  return (
    <div className="widget widget-json">
      <WidgetTitle title={widget.title} />
      <pre className="widget-json-body">{JSON.stringify(widget.value, null, 2)}</pre>
    </div>
  );
}

/** Renders every widget in `context`, in order. Renders nothing for an absent or empty context. */
export function WidgetList({ context }: { context?: Context }) {
  if (context === undefined || context.length === 0) {
    return null;
  }
  return (
    <div className="widget-list">
      {context.map((widget, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the context list is a fixed snapshot, never reordered.
        <WidgetItem widget={widget} key={`${widget.type}-${index}`} />
      ))}
    </div>
  );
}
