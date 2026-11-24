import { HistoryTimeline, OrderHistory } from "../ui/history-timeline";
import { OrderSheet } from "../ui/order-sheet";
import { BackButton } from "../ui/back-button";
import { Banner } from "../ui/banner";
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
import { getBatch, listBatchesForStore, type Section } from "../../transfer/board";
import { BoardChanges, TravelCorrection, StoreButton } from "./store-actions";
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
  return (
    <>
      <AppHeader actor={actor} locale={locale} store={store} />
      <main className={`${query.batch ? "e2e-page batch-screen" : "board-list"} ${store === "soho" ? "store-soho" : "store-ev"}`}
        data-screen={query.batch ? "batch-detail" : undefined}>
        <BoardRefresh />
        {!query.batch && <h1 className="sr-only">{t(locale, "board")}</h1>}
        <BoardChanges locale={locale} key={actor.staffId + store + (query.batch ?? "")} staffId={actor.staffId} store={store}
          batchId={query.batch} replayed={query.saved === "again"}>
          {query.batch ? (
            <BatchDetail locale={locale} id={query.batch} store={store} admin={actor.role === "admin"} />
          ) : (
            <Sections locale={locale} store={store} staffId={actor.staffId} />
          )}
        </BoardChanges>
      </main>
    </>
  );
}

async function boardSnapshot(store: StoreId, staffId: string) {
  const [cards, visible] = await Promise.all([listBatchesForStore(store), getStaffPreferences(staffId)]);
  return { cards, visible, updatedAt: Date.now() };
}

async function Sections({ store, staffId, locale }: { store: StoreId; staffId: string; locale: Locale }) {
  const { cards, visible, updatedAt } = await boardSnapshot(store, staffId);
  const groups = boardSections.map(id => {
    const items = cards.filter(card => card.section === id);
    const content = items.length ? <ul className="board-batches">
      {items.map(card => {
        const metaId = "meta-" + card.id;
        return <li key={card.id}>
          <Link className="batch-row" aria-label={card.id} aria-describedby={metaId}
            href={`/board?store=${store}&batch=${encodeURIComponent(card.id)}`}>
            <span className="batch-id">{card.id}</span>
            {card.ready > 0 && card.ready < card.total && <span className="badges"><span className="count-chip">
              {t(locale, "boardReadyCount", { count: card.ready, total: card.total })}
            </span></span>}
            <span className="batch-meta" id={metaId}>
              {stores[card.origin as StoreId]} → {stores[card.destination as StoreId]} · {t(locale, card.total === 1 ? "boardOneOrder" : "boardManyOrders", { count: card.total })}
              {id === "recently_returned" && <> · <span>{t(locale, "boardReturnedCount", { count: card.phaseCounts.returned, total: card.total })}</span></>}
              {id === "planned" && !card.total && <> · {t(locale, "emptyPlan")}</>}
              {card.contentsChanged && <> · <span className="anomaly">{t(locale, "contentsChanged")}</span></>}
            </span>
          </Link>
          {id === "arriving" && <div className="row-actions">
            <StoreButton outline label={t(locale, "boardReceive")}
              command={{
                kind: "runAction",
                action: "receive",
                origin: card.origin as StoreId,
                store,
                batchId: card.id,
                expectedVersion: card.version,
              }}
            />
          </div>}
        </li>;
      })}
    </ul> : <p className="empty-group">{t(locale, "boardNoBatches")}</p>;
    return { id, name: sectionLabel(locale, id), content };
  });
  return <SectionFilter groups={groups} visible={visible} staffId={staffId}
    store={store} names={stores} locale={locale} updatedAt={updatedAt} />;
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
  const progress = section === "recently_returned"
    ? t(locale, "boardReturnedCount", { count: detail.phaseCounts.returned, total: detail.total })
    : section === "returning" ? t(locale, "boardReturningCount", { total: detail.total })
    : t(locale, "boardReadyCount", { count: detail.ready, total: detail.total });
  const canCheck = atDestination && section && !["planned", "returning", "recently_returned"].includes(section);
  return <>
    <div className="store-band" />
    <div className="e2e-body">
      <div className="back-row"><BackButton href={"/board?store=" + store}
        label={t(locale, "batchStoreBoard", { store: stores[store] })}
        ariaLabel={t(locale, "boardBackToStore", { store: stores[store] })} /></div>
      <h1 className="flow-title">{id}</h1>
      <p className="flow-sub">{stores[origin]} → {stores[detail.destination as StoreId]} · {section
        ? <span>{sectionLabel(locale, section)} · {progress}</span>
        : t(locale, detail.batch.cancelledAt ? "boardCancelled" : "boardNoRemaining")}</p>
      {section && section !== "planned" && <p className="locked-note">{t(locale, "batchLockedNote")}</p>}
      {detail.contentsChanged && <Banner>{t(locale, "contentsChanged")}</Banner>}
      <h2 className="group-label">{t(locale, "boardOrders")}</h2>
      <div className="card orders-card">
        {orders.length && !detail.batch.cancelledAt ? orders.map(({ membership, order }) => {
          const { orderNumber, customerFirstName, customerLastInitial } = order;
          const phase = membership.phase;
          const editable = atDestination && membership.active;
          const orderKey = { storeId: origin, orderNumber };
          const action = phase === "received" ? "startProcessing" : "markReady";
          return <OrderSheet key={membership.id} locale={locale} number={orderNumber}
            name={[customerFirstName, customerLastInitial && customerLastInitial + "."].filter(Boolean).join(" ")}
            origin={stores[origin]} batch={id} phase={phase} detergent={order.isPersonalDetergent === true}
            advance={editable && (phase === "received" || phase === "processing") ? { ...command, action, orderKeys: [orderKey] } : undefined}
            back={editable && (phase === "processing" || phase === "ready_for_return") ? { ...correction, kind: "stepBackOrder", store, orderKey } : undefined}>
            <OrderHistory locale={locale} entries={history.filter(entry => entry.handoff.orderNumber === orderNumber)} />
          </OrderSheet>;
        }) : <p className="empty-group">{t(locale, "boardNoRemainingSentence")}</p>}
      </div>
      <HistoryTimeline locale={locale} entries={history} currentPhases={section ? orders.length ? orders.map(item => item.membership.phase) : [travel ?? "planned"] : []} />
      {detail.emptyCorrections.length > 0 && <section>
        <h2 className="group-label">{t(locale, "emptyCorrections")}</h2>
        {detail.emptyCorrections.map(c => <div className="correction-callout" key={c.operationId}>
          <strong>{phaseLabel(locale, c.fromPhase)} → {phaseLabel(locale, c.toPhase)}</strong> · {c.reason}
          <small>{c.staffName} · {formatLocalDate(locale, c.at)}</small>
          <small className="op-id">{t(locale, "operationIdLabel", { id: c.operationId })}</small>
        </div>)}
      </section>}
      {(section || canCorrectTravel) && <div className="btn-row">
        {section === "planned" && store === origin && <Link className="btn" href={`/orders?store=${store}&batch=${encodeURIComponent(id)}`}>{t(locale, "boardEditPlan")}</Link>}
        {atDestination && section === "arriving" && <StoreButton label={t(locale, "boardReceive")} command={{ ...command, action: "receive" }} />}
        {atDestination && waiting.length > 1 && <StoreButton label={t(locale, "boardStartProcessingMany", { count: waiting.length })} command={{ ...command, action: "startProcessing", orderKeys: waiting }} />}
        {atDestination && processing.length > 0 && <StoreButton label={t(locale, "boardMarkRemainingReady", { count: processing.length })} command={{ ...command, action: "markReady", orderKeys: processing }} />}
        {atDestination && section === "ready_for_return" && !detail.contentsChanged && <StoreButton label={t(locale, "boardSendReturn")} command={{ ...command, action: "sendReturn" }} />}
        {atDestination && detail.total > 0 && (section === "received" || section === "processing") && <>
          <button className="btn btn-outline" disabled>{t(locale, "boardSendReturn")}</button>
          <p className="btn-hint">{t(locale, "boardSendReturnHint", { total: detail.total })}</p>
        </>}
        {store === origin && section === "returning" && <StoreButton label={t(locale, "boardAcknowledgeReturn")} command={{ ...command, action: "acknowledgeReturn" }} />}
        {canCheck && <Link className="btn btn-outline" href={`/orders?store=${store}&contents=${encodeURIComponent(id)}`}>{t(locale, "boardCheckSent")}</Link>}
        {canCorrectTravel && <TravelCorrection key={detail.version} command={{ ...correction, kind: "correctTravelPhase" }}
          label={t(locale, travel === "sent" ? "boardBackToPlanned" : "boardBackToSent")} />}
      </div>}
    </div>
  </>;
}
