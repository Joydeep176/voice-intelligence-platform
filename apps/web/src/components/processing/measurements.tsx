import type { ProcessingPreprocessing } from '@vip/contracts';
import {
  formatQuantity,
  measurementViews,
  quantityLabel,
  SOURCE_LABEL,
  unavailableReason,
} from './model';

/**
 * Whole-recording measurements as numbers with units and their kind. No scores, categories or
 * colours: interpretation belongs to the future Audio Quality agent (ADR-0019).
 */
export function Measurements({ p }: { p: ProcessingPreprocessing }) {
  const views = measurementViews(p);
  if (views.length === 0) {
    return <p className="text-muted-foreground text-sm">Measurements are not available.</p>;
  }
  return (
    <div className="grid gap-5">
      {views.map(({ source, record }) => (
        <section
          key={source}
          aria-label={`Measurements: ${SOURCE_LABEL[source]}`}
          className="grid gap-2"
        >
          <h4 className="text-sm font-medium">{SOURCE_LABEL[source]}</h4>
          {record === null ? (
            <p className="text-muted-foreground text-sm">
              These measurements could not be displayed.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-xs tabular-nums">
                {record.sampleRateHz.toLocaleString('en-US')} Hz · {record.channels}{' '}
                {record.channels === 1 ? 'channel' : 'channels'} ·{' '}
                {record.frames.toLocaleString('en-US')} frames
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-64 text-left text-sm">
                  <caption className="sr-only">{`${SOURCE_LABEL[source]} measurements`}</caption>
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th scope="col" className="py-1 pr-3 font-normal">
                        Quantity
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-normal">
                        Value
                      </th>
                      <th scope="col" className="py-1 font-normal">
                        Kind
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(record.quantities).map(([name, q]) => (
                      <tr key={name} className="border-t">
                        <th scope="row" className="py-1.5 pr-3 font-normal">
                          {quantityLabel(name)}
                          <span className="text-muted-foreground block text-xs">{q.method}</span>
                        </th>
                        <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                          {formatQuantity(q)}
                        </td>
                        <td className="text-muted-foreground py-1.5 text-xs">{q.kind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {record.unavailable.length > 0 ? (
                <ul
                  aria-label="Unavailable measurements"
                  className="text-muted-foreground grid gap-0.5 text-xs"
                >
                  {record.unavailable.map((u) => (
                    <li key={u.name}>
                      {quantityLabel(u.name)}: unavailable ({unavailableReason(u.reason)})
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
