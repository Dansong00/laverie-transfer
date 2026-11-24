import type { getBatch } from "../../transfer/board";
import { t, type Locale } from "../../i18n";
import { phaseLabel } from "../../i18n/transfer";
import { formatLocalDate } from "../../i18n/dates";

type History = NonNullable<Awaited<ReturnType<typeof getBatch>>>["history"];
const clocks = {
  en: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeStyle: "short" }),
  es: new Intl.DateTimeFormat("es-US", { timeZone: "America/New_York", timeStyle: "short" }),
};
const phases = ["planned", "sent", "received", "processing", "ready_for_return", "return_sent", "returned"];

function description(locale: Locale, { handoff, reason }: History[number]) {
  if (handoff.action === "correctSentMembership") return t(locale, "didNotTravel");
  return reason ? `${phaseLabel(locale, handoff.fromPhase)} → ${phaseLabel(locale, handoff.toPhase)}` : phaseLabel(locale, handoff.toPhase);
}

export function OrderHistory({ entries, locale }: { entries: History; locale: Locale }) {
  return <>
    <h3 className="group-label">{t(locale, "orderHistory")}</h3>
    {entries.length ? <ol className="order-history">{entries.map(entry => <li key={entry.handoff.id}>
      <span>{description(locale, entry)}{entry.reason && <span className="reason">{t(locale, "boardReason", { reason: entry.reason })}</span>}</span>
      <span className="who-when">{entry.staffName} · <time dateTime={entry.handoff.at.toISOString()}>{formatLocalDate(locale, entry.handoff.at)}</time></span>
    </li>)}</ol> : <p>{t(locale, "boardNoHandoffs")}</p>}
  </>;
}

export function HistoryTimeline({ entries, currentPhases, locale }: { entries: History; currentPhases: string[]; locale: Locale }) {
  const operations = new Map<string, History>();
  for (const entry of entries) {
    const id = entry.handoff.operationId;
    const group = operations.get(id);
    if (group) group.push(entry);
    else operations.set(id, [entry]);
  }
  const latestPhase = Math.max(-1, ...currentPhases.map(phase => phases.indexOf(phase)));
  const pending = latestPhase < 0 ? [] : phases.slice(latestPhase + 1);
  return <>
    <h2 className="group-label">{t(locale, "handoffHistory")}</h2>
    <div className="card history-card">
      {!entries.length && <p className="empty-group">{t(locale, "boardNoHandoffs")}</p>}
      <ol className="timeline">
        {Array.from(operations, ([id, group], index) => {
          const first = group[0];
          const commonReason = group.every(entry => entry.reason === first.reason) ? first.reason : null;
          return <li className={index + 1 === operations.size ? "step is-current" : "step is-done"} key={id}>
            <span className="dot" aria-hidden="true" />
            <details className="handoff-step">
              <summary><span className="step-phase">{description(locale, first)}</span>{" "}
                <span className="step-who">{first.staffName}</span>{" "}
                <time className="when" dateTime={first.handoff.at.toISOString()} title={formatLocalDate(locale, first.handoff.at)}>{clocks[locale].format(first.handoff.at)}</time>
              </summary>
              <time className="handoff-date" dateTime={first.handoff.at.toISOString()}>{formatLocalDate(locale, first.handoff.at)}</time>
              <small className="op-id">{t(locale, "operationIdLabel", { id })}</small>
              <div className="handoff-orders">{group.map(entry => <span key={entry.handoff.id}>#{entry.handoff.orderNumber}{entry.reason && !commonReason && <> · {t(locale, "boardReason", { reason: entry.reason })}</>}</span>)}</div>
            </details>
            {commonReason && <p className="correction">{t(locale, "boardReason", { reason: commonReason })}</p>}
          </li>;
        })}
        {pending.map(phase => <li key={phase} className="step is-pending"><span className="dot" aria-hidden="true" />
          <div><span className="step-phase">{phaseLabel(locale, phase)}</span> <span className="step-who">{t(locale, "notYet")}</span></div>
        </li>)}
      </ol>
    </div>
  </>;
}
