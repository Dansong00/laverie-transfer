import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { stores } from "../../db/eligible-orders";
import { boardSections } from "../../db/schema";
import { readSession, sessionCookie } from "../../staff/session";
import { getStaffPreferences } from "../../staff/preferences";
import { getBatch, listBatchesForStore, sectionNames } from "../../transfer/board";
import { BoardChanges, StoreButton } from "./store-actions";
import type { StoreId } from "../../db/eligible-orders";
import { BoardRefresh, SectionFilter } from "./controls";
import "../sign-in.css";
import "../orders/orders.css";
import "./board.css";

const phaseNames: Record<string, string> = {
  planned: "Planned",
  sent: "Sent",
  received: "Received",
  processing: "Processing",
  ready_for_return: "Ready for return",
  return_sent: "Return sent",
  returned: "Returned",
};
const localTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

export default function BoardPage(props: PageProps<"/board">) {
  return (
    <Suspense fallback={<p>Loading transfer board…</p>}>
      <Board {...props} />
    </Suspense>
  );
}

async function Board({ searchParams }: PageProps<"/board">) {
  const actor = await readSession((await cookies()).get(sessionCookie)?.value);
  if (!actor) redirect("/");
  const query = await searchParams;
  const store = query.store ?? "soho";
  if (store !== "soho" && store !== "east_village") notFound();
  if (query.batch && typeof query.batch !== "string") notFound();
  const base = "/board?store=" + store;
  return (
    <main className="eligible-orders transfer-board">
      <BoardRefresh />
      <Link href="/">Staff home</Link>
      <h1>Transfer board</h1>
      <nav aria-label="Store">
        {Object.entries(stores).map(([id, name]) => (
          <Link key={id} href={"/board?store=" + id} aria-current={store === id ? "page" : undefined}>
            {name}
          </Link>
        ))}
      </nav>
      {query.saved === "again" && <p role="status">Already saved.</p>}
      <BoardChanges key={actor.staffId + store} staffId={actor.staffId} store={store}>
        {query.batch ? (
          <BatchDetail id={query.batch} store={store} />
        ) : (
          <Sections store={store} staffId={actor.staffId} />
        )}
      </BoardChanges>
      {query.batch && <Link href={base}>Back to {stores[store]} board</Link>}
    </main>
  );
}

async function Sections({ store, staffId }: { store: keyof typeof stores; staffId: string }) {
  const [cards, visible] = await Promise.all([listBatchesForStore(store), getStaffPreferences(staffId)]);
  return (
    <>
      <div className="board-tools">
        <Link className="create" href={"/orders?store=" + store}>
          Create transfer
        </Link>
        <SectionFilter
          key={visible.join(",")}
          visible={visible}
          choices={boardSections.map((id) => ({ id, name: sectionNames[id] }))}
        />
      </div>
      {!visible.length && <p>All sections are hidden. Choose sections to show above.</p>}
      {visible.map((section) => {
        const items = cards.filter((card) => card.section === section);
        return (
          <section key={section} aria-label={sectionNames[section]}>
            <h2>{sectionNames[section]}</h2>
            {items.length ? (
              <ul>
                {items.map((card) => (
                  <li key={card.id}>
                    <Link href={`/board?store=${store}&batch=${encodeURIComponent(card.id)}`}>{card.id}</Link>
                    <span>
                      {card.total === 0 && section === "planned"
                        ? "Planned (empty)"
                        : (section === "received" && card.ready > 0) || section === "processing" || section === "ready_for_return"
                          ? `${card.ready} of ${card.total} ready`
                          : `${card.total} ${card.total === 1 ? "order" : "orders"}`}
                    </span>
                    {section === "arriving" && (
                      <StoreButton
                        label="Mark received"
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
                    {card.contentsChanged && <small>Contents changed, confirm before return</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No batches</p>
            )}
          </section>
        );
      })}
    </>
  );
}

async function BatchDetail({ id, store }: { id: string; store: keyof typeof stores }) {
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
  return (
    <section className="batch-detail">
      <h2>{id}</h2>
      <p>
        {section ? sectionNames[section] : detail.batch.cancelledAt ? "Cancelled" : "No remaining orders"} ·{" "}
        {detail.ready} of {detail.total} ready
      </p>
      {detail.contentsChanged && <p>Contents changed, confirm before return</p>}
      {section === "planned" && store === detail.origin && (
        <Link href={`/orders?store=${store}&batch=${encodeURIComponent(id)}`}>Edit planned batch</Link>
      )}
      {store === detail.destination &&
        section &&
        !["planned", "returning", "recently_returned"].includes(section) && (
          <Link href={`/orders?store=${store}&contents=${encodeURIComponent(id)}`}>Check sent contents</Link>
        )}
      {atDestination && section === "arriving" && (
        <StoreButton label="Mark received" command={{ ...command, action: "receive" }} />
      )}
      <h3>Orders</h3>
      {orders.length ? (
        <ul>
          {orders.map(({ membership, order }) => (
            <li key={membership.id}>
              <strong>#{order.orderNumber}</strong>
              <span>{phaseNames[membership.phase] ?? membership.phase}</span>
              {atDestination && membership.active && membership.phase === "received" && (
                <StoreButton
                  label="Start processing"
                  command={{
                    ...command,
                    action: "startProcessing",
                    orderKeys: [{ storeId: origin, orderNumber: order.orderNumber }],
                  }}
                />
              )}
              {atDestination && membership.active && membership.phase === "processing" && (
                <StoreButton
                  label="Mark ready"
                  command={{
                    ...command,
                    action: "markReady",
                    orderKeys: [{ storeId: origin, orderNumber: order.orderNumber }],
                  }}
                />
              )}
              {order.isPersonalDetergent && <small>Personal detergent</small>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No remaining orders.</p>
      )}
      {atDestination && waiting.length > 1 && (
        <StoreButton
          label={`Start processing ${waiting.length} received orders`}
          command={{ ...command, action: "startProcessing", orderKeys: waiting }}
        />
      )}
      {atDestination && processing.length > 0 && (
        <StoreButton
          label={`Mark ${processing.length} remaining ready`}
          command={{ ...command, action: "markReady", orderKeys: processing }}
        />
      )}
      <h3>Handoff history</h3>
      {history.length ? (
        <ol>
          {history.map(({ handoff, staffName }) => (
            <li key={handoff.id}>
              <strong>#{handoff.orderNumber}</strong>{" "}
              {handoff.action === "correctSentMembership"
                ? "Did not travel"
                : (phaseNames[handoff.toPhase] ?? handoff.toPhase)}
              <small>
                {staffName} · <time dateTime={handoff.at.toISOString()}>{localTime.format(handoff.at)}</time>
              </small>
              <small>Operation {handoff.operationId}</small>
            </li>
          ))}
        </ol>
      ) : (
        <p>No handoffs yet.</p>
      )}
    </section>
  );
}
