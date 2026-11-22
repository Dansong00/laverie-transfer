import { sentBatchesAt, contentsHistory } from "../../transfer/contents";
import { plannedBatches, plannedMembers } from "../../transfer/planned";
import { Planner } from "./planner";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { listEligibleOrders, stores } from "../../db/eligible-orders";
import { readSession, sessionCookie } from "../../staff/session";
import "../sign-in.css";
import "./orders.css";

const formatDue = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "medium",
  timeStyle: "short",
});

export default function Orders(props: PageProps<"/orders">) {
  return (
    <Suspense fallback={<p>Loading eligible orders…</p>}>
      <EligibleOrders {...props} />
    </Suspense>
  );
}

async function EligibleOrders({ searchParams }: PageProps<"/orders">) {
  const actor = await readSession((await cookies()).get(sessionCookie)?.value);
  if (!actor) redirect("/");
  const query = await searchParams;
  const store = query.store ?? "soho";
  if (store !== "soho" && store !== "east_village") notFound();
  const [orders, plans, trips] = await Promise.all([
    listEligibleOrders(store),
    plannedBatches(store),
    sentBatchesAt(store),
  ]);
  const listedTrips = trips.filter((t) => !t.confirmedEmpty);
  const trip = trips.find((t) => t.id === query.contents);
  if (query.contents && !trip) notFound();
  const history = trip ? await contentsHistory(trip.id) : undefined;
  const plan = plans.find((batch) => batch.id === query.batch);
  if (query.batch && !plan) redirect("/orders?store=" + store);
  const members = plan ? await plannedMembers(plan.id) : [];

  return (
    <main className="eligible-orders">
      <Link href="/">Staff home</Link>
      {" · "}
      <Link href={"/board?store=" + store}>Transfer board</Link>
      <h1>Eligible orders</h1>
      <nav aria-label="Store">
        {Object.entries(stores).map(([id, name]) => (
          <Link key={id} href={`/orders?store=${id}`} aria-current={id === store ? "page" : undefined}>
            {name}
          </Link>
        ))}
      </nav>
      {typeof query.sent === "string" && <p role="status">Marked {query.sent} sent.</p>}
      {query.saved === "again" && <p role="status">Already saved.</p>}
      <Planner
        key={JSON.stringify([store, plan?.id, plan?.version, trip?.id, trip?.version])}
        trip={
          trip && history
            ? { ...trip, origin: trip.origin === "soho" ? "soho" : "east_village", ...history }
            : undefined
        }
        admin={actor.role === "admin"}
        staffId={actor.staffId}
        origin={store}
        plan={plan}
        members={members.map((member) => member.orderNumber)}
      >
        <h2>Eligible at {stores[store]}</h2>
        {orders.length === 0 ? (
          <p>No eligible orders at {stores[store]}.</p>
        ) : (
          <ul>
            {orders.map((order) => (
              <li key={order.orderNumber}>
                <label>
                  <input type="checkbox" name="add" value={order.orderNumber} />{" "}
                  <strong>#{order.orderNumber}</strong>
                </label>
                <span>
                  {[order.customerFirstName, order.customerLastInitial && order.customerLastInitial + "."]
                    .filter(Boolean)
                    .join(" ")}
                </span>
                <small>
                  {order.dueAt ? (
                    <time dateTime={order.dueAt.toISOString()}>Due {formatDue.format(order.dueAt)}</time>
                  ) : (
                    "No due date"
                  )}
                </small>
                {order.isPersonalDetergent && <small>Personal detergent</small>}
              </li>
            ))}
          </ul>
        )}
      </Planner>
      {listedTrips.length > 0 && (
        <section>
          <h2>Sent to {stores[store]}</h2>
          <ul>
            {listedTrips.map((t) => (
              <li key={t.id}>
                <Link href={`/orders?store=${store}&contents=${t.id}`}>{t.id}</Link>
                {t.changed && " · Contents changed, confirm before return"}
              </li>
            ))}
          </ul>
        </section>
      )}
      {trip && <Link href={`/orders?store=${store}`}>Back to eligible orders</Link>}
      {plans.length > 0 && (
        <section>
          <h2>Planned batches</h2>
          <ul>
            {plans.map((batch) => (
              <li key={batch.id}>
                <Link href={`/orders?store=${store}&batch=${batch.id}`}>{batch.id}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan && <Link href={`/orders?store=${store}`}>Plan another batch</Link>}
    </main>
  );
}
