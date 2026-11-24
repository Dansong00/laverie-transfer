import { AppHeader } from "../ui/app-header";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { formatLocalDate } from "../../i18n/dates";
import { t, type Locale } from "../../i18n";
import { phaseLabel } from "../../i18n/transfer";
import { stores, type StoreId } from "../../db/eligible-orders";
import { boardSections } from "../../db/schema";
import { requestLocale, requestProfile } from "../../staff/request-profile";
import { getStaffPreferences } from "../../staff/preferences";
import { getBatch, listBatchesForStore, type BoardCard, type Section } from "../../transfer/board";
import { BoardChanges, CorrectionForm, StoreButton } from "./store-actions";
import { BoardRefresh, SectionFilter } from "./controls";

function sectionLabel(locale: Locale, section: Section) {
  switch (section) {
    case "arriving":
      return t(locale, "boardArriving");
    case "returning":
      return t(locale, "boardReturning");
    case "recently_returned":
      return t(locale, "boardRecentlyReturned");
    default:
      return phaseLabel(locale, section);
  }
}

function cardSummary(locale: Locale, card: BoardCard) {
  if (card.section === "recently_returned") {
    return t(locale, "boardReturnedCount", { count: card.phaseCounts.returned, total: card.total });
  }
  if (card.section === "planned" && card.total === 0) return t(locale, "emptyPlan");
  if (
    (card.section === "received" && card.ready > 0) ||
    card.section === "processing" ||
    card.section === "ready_for_return"
  ) {
    return t(locale, "boardReadyCount", { count: card.ready, total: card.total });
  }
  return t(locale, card.total === 1 ? "boardOneOrder" : "boardManyOrders", { count: card.total });
}

export default async function BoardPage(props: PageProps<"/board">) {
  const locale = await requestLocale();
  return (
    <Suspense fallback={<p>{t(locale, "boardLoading")}</p>}>
      <Board {...props} locale={locale} />
    </Suspense>
  );
}

async function Board({ searchParams, locale }: PageProps<"/board"> & { locale: Locale }) {
  const actor = await requestProfile();
  if (!actor) redirect("/");
  const query = await searchParams;
  const store = query.store ?? "soho";
  if (store !== "soho" && store !== "east_village") notFound();
  if (query.batch && typeof query.batch !== "string") notFound();
  const base = "/board?store=" + store;
  return (
    <>
      <AppHeader actor={actor} locale={locale} store={store} />
      <main className="eligible-orders transfer-board">
        <BoardRefresh />
        <h1>{t(locale, "board")}</h1>
        <nav aria-label={t(locale, "store")}>
          {Object.entries(stores).map(([id, name]) => (
            <Link key={id} href={"/board?store=" + id} aria-current={store === id ? "page" : undefined}>
              {name}
            </Link>
          ))}
        </nav>
        {query.saved === "again" && <p role="status">{t(locale, "alreadySaved")}</p>}
        <BoardChanges locale={locale} key={actor.staffId + store} staffId={actor.staffId} store={store}>
          {query.batch ? (
            <BatchDetail locale={locale} id={query.batch} store={store} admin={actor.role === "admin"} />
          ) : (
            <Sections locale={locale} store={store} staffId={actor.staffId} />
          )}
        </BoardChanges>
        {query.batch && <Link href={base}>{t(locale, "boardBackToStore", { store: stores[store] })}</Link>}
      </main>
    </>
  );
}

async function Sections({ store, staffId, locale }: { store: StoreId; staffId: string; locale: Locale }) {
  const [cards, visible] = await Promise.all([listBatchesForStore(store), getStaffPreferences(staffId)]);
  return (
    <>
      <div className="board-tools">
        <Link className="create" href={"/orders?store=" + store}>
          {t(locale, "boardCreateTransfer")}
        </Link>
        <SectionFilter
          key={visible.join(",")}
          locale={locale}
          visible={visible}
          choices={boardSections.map((id) => ({ id, name: sectionLabel(locale, id) }))}
        />
      </div>
      {!visible.length && <p>{t(locale, "boardHiddenSections")}</p>}
      {visible.map((section) => {
        const items = cards.filter((card) => card.section === section);
        const label = sectionLabel(locale, section);
        return (
          <section key={section} aria-label={label}>
            <h2>{label}</h2>
            {items.length ? (
              <ul>
                {items.map((card) => (
                  <li key={card.id}>
                    <Link href={`/board?store=${store}&batch=${encodeURIComponent(card.id)}`}>{card.id}</Link>
                    <span>{cardSummary(locale, card)}</span>
                    {section === "arriving" && (
                      <StoreButton
                        label={t(locale, "boardReceive")}
                        command={{
                          kind: "runAction",
                          action: "receive",
                          origin: card.origin as StoreId,
                          store,
                          batchId: card.id,
                          expectedVersion: card.version,
                        }}
                      />
                    )}
                    {card.contentsChanged && <small>{t(locale, "contentsChanged")}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t(locale, "boardNoBatches")}</p>
            )}
          </section>
        );
      })}
    </>
  );
}

async function BatchDetail({ id, store, admin, locale }: {
  id: string;
  store: StoreId;
  admin: boolean;
  locale: Locale;
}) {
  const detail = await getBatch(id);
  if (!detail || ![detail.origin, detail.destination].includes(store)) notFound();
  const { section, orders, history } = detail;
  const origin = detail.origin as StoreId;
  const command = { kind: "runAction", origin, store, batchId: id, expectedVersion: detail.version } as const;
  const waiting = orders
    .filter(({ membership }) => membership.active && membership.phase === "received")
    .map(({ order }) => ({ storeId: origin, orderNumber: order.orderNumber }));
  const processing = orders
    .filter(({ membership }) => membership.active && membership.phase === "processing")
    .map(({ order }) => ({ storeId: origin, orderNumber: order.orderNumber }));
  const atDestination = detail.destination === store && !detail.batch.cancelledAt;
  const correction = { origin, batchId: id, expectedVersion: detail.version };
  const travel = detail.travel;
  const canCorrectTravel =
    admin &&
    !detail.batch.cancelledAt &&
    (travel === "sent" || travel === "received") &&
    orders.every(({ membership }) => membership.active && membership.phase === travel);
  return (
    <section className="batch-detail">
      <h2>{id}</h2>
      <p>
        {section
          ? sectionLabel(locale, section)
          : t(locale, detail.batch.cancelledAt ? "boardCancelled" : "boardNoRemaining")} ·{" "}
        {section === "recently_returned"
          ? t(locale, "boardReturnedCount", { count: detail.phaseCounts.returned, total: detail.total })
          : section === "returning"
            ? t(locale, "boardReturningCount", { total: detail.total })
            : t(locale, "boardReadyCount", { count: detail.ready, total: detail.total })}
      </p>
      {detail.contentsChanged && <p>{t(locale, "contentsChanged")}</p>}
      {section === "planned" && store === detail.origin && (
        <Link href={`/orders?store=${store}&batch=${encodeURIComponent(id)}`}>{t(locale, "boardEditPlan")}</Link>
      )}
      {store === detail.destination &&
        section &&
        !["planned", "returning", "recently_returned"].includes(section) && (
          <Link href={`/orders?store=${store}&contents=${encodeURIComponent(id)}`}>{t(locale, "boardCheckSent")}</Link>
        )}
      {atDestination && section === "arriving" && (
        <StoreButton label={t(locale, "boardReceive")} command={{ ...command, action: "receive" }} />
      )}
      {canCorrectTravel && (
        <CorrectionForm
          key={detail.version}
          command={{ ...correction, kind: "correctTravelPhase" }}
          label={t(locale, travel === "sent" ? "boardBackToPlanned" : "boardBackToSent")}
        />
      )}
      <h3>{t(locale, "boardOrders")}</h3>
      {orders.length ? (
        <ul>
          {orders.map(({ membership, order }) => (
            <li key={membership.id}>
              <strong>#{order.orderNumber}</strong>
              <span>{phaseLabel(locale, membership.phase)}</span>
              {atDestination && membership.active && membership.phase === "received" && (
                <StoreButton
                  label={t(locale, "boardStartProcessing")}
                  command={{
                    ...command,
                    action: "startProcessing",
                    orderKeys: [{ storeId: origin, orderNumber: order.orderNumber }],
                  }}
                />
              )}
              {atDestination && membership.active && membership.phase === "processing" && (
                <StoreButton
                  label={t(locale, "boardMarkReady")}
                  command={{
                    ...command,
                    action: "markReady",
                    orderKeys: [{ storeId: origin, orderNumber: order.orderNumber }],
                  }}
                />
              )}
              {atDestination &&
                membership.active &&
                ["processing", "ready_for_return"].includes(membership.phase) && (
                  <CorrectionForm
                    key={detail.version}
                    label={t(locale, membership.phase === "processing" ? "boardBackToReceived" : "boardBackToProcessing")}
                    command={{
                      ...correction,
                      kind: "stepBackOrder",
                      store,
                      orderKey: { storeId: origin, orderNumber: order.orderNumber },
                    }}
                  />
                )}
              {order.isPersonalDetergent && <small>{t(locale, "personalDetergent")}</small>}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t(locale, "boardNoRemainingSentence")}</p>
      )}
      {atDestination && section === "ready_for_return" && !detail.contentsChanged && (
        <StoreButton label={t(locale, "boardSendReturn")} command={{ ...command, action: "sendReturn" }} />
      )}
      {store === origin && section === "returning" && (
        <StoreButton label={t(locale, "boardAcknowledgeReturn")} command={{ ...command, action: "acknowledgeReturn" }} />
      )}
      {atDestination && waiting.length > 1 && (
        <StoreButton
          label={t(locale, "boardStartProcessingMany", { count: waiting.length })}
          command={{ ...command, action: "startProcessing", orderKeys: waiting }}
        />
      )}
      {atDestination && processing.length > 0 && (
        <StoreButton
          label={t(locale, "boardMarkRemainingReady", { count: processing.length })}
          command={{ ...command, action: "markReady", orderKeys: processing }}
        />
      )}
      {detail.emptyCorrections.length > 0 && (
        <section>
          <h3>{t(locale, "emptyCorrections")}</h3>
          <ol>
            {detail.emptyCorrections.map((c) => (
              <li key={c.operationId}>
                {phaseLabel(locale, c.fromPhase)} → {phaseLabel(locale, c.toPhase)} · {c.reason}
                <small>
                  {c.staffName} · {formatLocalDate(locale, c.at)}
                </small>
                <small>{t(locale, "operationIdLabel", { id: c.operationId })}</small>
              </li>
            ))}
          </ol>
        </section>
      )}
      <h3>{t(locale, "handoffHistory")}</h3>
      {history.length ? (
        <ol>
          {history.map(({ handoff, staffName, reason }) => (
            <li key={handoff.id}>
              <strong>#{handoff.orderNumber}</strong>{" "}
              {handoff.action === "correctSentMembership"
                ? t(locale, "didNotTravel")
                : reason
                  ? `${phaseLabel(locale, handoff.fromPhase)} → ${phaseLabel(locale, handoff.toPhase)}`
                  : phaseLabel(locale, handoff.toPhase)}
              {reason && <small>{t(locale, "boardReason", { reason })}</small>}
              <small>
                {staffName} ·{" "}
                <time dateTime={handoff.at.toISOString()}>{formatLocalDate(locale, handoff.at)}</time>
              </small>
              <small>{t(locale, "operationIdLabel", { id: handoff.operationId })}</small>
            </li>
          ))}
        </ol>
      ) : (
        <p>{t(locale, "boardNoHandoffs")}</p>
      )}
    </section>
  );
}
