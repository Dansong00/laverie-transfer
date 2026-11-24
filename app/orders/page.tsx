import { AppHeader } from "../ui/app-header";
import { BackButton } from "../ui/back-button";
import { Toast } from "../ui/toast";
import { sentBatchesAt, contentsHistory } from "../../transfer/contents";
import { plannedBatches, plannedMembers } from "../../transfer/planned";
import { Planner } from "./planner";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { listEligibleOrders, stores } from "../../db/eligible-orders";
import { formatLocalDate } from "../../i18n/dates";
import { t, type Locale } from "../../i18n";
import { requestLocale, requestProfile } from "../../staff/request-profile";

export default async function Orders(props: PageProps<"/orders">) {
  const locale = await requestLocale();
  return (
    <Suspense fallback={<p className="e2e-body flow-sub">{t(locale, "ordersLoading")}</p>}>
      <EligibleOrders {...props} locale={locale} />
    </Suspense>
  );
}

async function EligibleOrders({ searchParams, locale }: PageProps<"/orders"> & { locale: Locale }) {
  const actor = await requestProfile();
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

  const origin = trip ? (trip.origin === "east_village" ? "east_village" : "soho") : store;
  const count = trip ? history?.members.filter(member => !member.removedAt).length : plan ? members.length : undefined;
  const sentMessage = typeof query.sent === "string" ? t(locale, "ordersSentStatus", { batch: query.sent }) : "";

  return (
    <>
      <AppHeader actor={actor} locale={locale} store={store} />
      <div className={store === "soho" ? "store-soho" : "store-ev"}>
        <div className="store-band" />
        <main className="e2e-body orders-screen">
          <div className="back-row">
            <BackButton href={`/board?store=${store}${trip ? "&batch=" + encodeURIComponent(trip.id) : ""}`}
              label={t(locale, "batchStoreBoard", { store: stores[store] })} />
          </div>
          <h1 className="flow-title">{trip?.id ?? plan?.id ?? t(locale, "boardCreateTransfer")}</h1>
          <p className="flow-sub">
            {stores[origin]} → {stores[origin === "soho" ? "east_village" : "soho"]}
            {count !== undefined && <> · {t(locale, count === 1 ? "boardOneOrder" : "boardManyOrders", { count })}</>}
            {plan && <> · {t(locale, "phasePlanned")}</>}
          </p>
          <Toast message={sentMessage || (query.saved === "again" ? t(locale, "alreadySaved") : "")}
            detail={sentMessage && query.saved === "again" ? t(locale, "alreadySaved") : undefined} />
          <Planner
            key={JSON.stringify([store, plan?.id, plan?.version, trip?.id, trip?.version])}
            locale={locale}
            trip={
              trip && history
                ? { ...trip, origin, ...history }
                : undefined
            }
            admin={actor.role === "admin"}
            staffId={actor.staffId}
            origin={store}
            storeName={stores[store]}
            plan={plan}
            members={members.map((member) => member.orderNumber)}
          >
            <section className="card orders-card">
              <h2 className="group-label">{t(locale, "ordersEligibleAt", { store: stores[store] })}</h2>
              {orders.length === 0 ? (
                <p className="empty-group">{t(locale, "ordersNoneEligible", { store: stores[store] })}</p>
              ) : (
                <ul>
                  {orders.map((order) => (
                    <li key={order.orderNumber}>
                      <label className="order-row selectable">
                        <input aria-label={"#" + order.orderNumber} className="check" type="checkbox" name="add" value={order.orderNumber} />
                        <strong className="onum">#{order.orderNumber}</strong>
                        <span className="customer-name">
                          {[order.customerFirstName, order.customerLastInitial && order.customerLastInitial + "."].filter(Boolean).join(" ")}
                        </span>
                        {order.isPersonalDetergent && <span className="badge badge-hold">{t(locale, "personalDetergent")}</span>}
                        <small className="due">
                          {order.dueAt ? (
                            <time dateTime={order.dueAt.toISOString()}>{t(locale, "ordersDue", { date: formatLocalDate(locale, order.dueAt) })}</time>
                          ) : t(locale, "ordersNoDueDate")}
                        </small>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Planner>
          {listedTrips.length > 0 && (
            <section className="card orders-card">
              <h2 className="group-label">{t(locale, "ordersSentTo", { store: stores[store] })}</h2>
              <ul>
                {listedTrips.map((trip) => (
                  <li key={trip.id}>
                    <Link className="orders-link" href={`/orders?store=${store}&contents=${trip.id}`}>{trip.id}</Link>
                    {trip.changed && <> · {t(locale, "contentsChanged")}</>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {trip && <Link className="orders-link" href={`/orders?store=${store}`}>{t(locale, "ordersBackToEligible")}</Link>}
          {plans.length > 0 && (
            <section className="card orders-card">
              <h2 className="group-label">{t(locale, "ordersPlannedBatches")}</h2>
              <ul>
                {plans.map((batch) => (
                  <li key={batch.id}>
                    <Link className="orders-link" href={`/orders?store=${store}&batch=${batch.id}`}>{batch.id}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan && <Link className="orders-link" href={`/orders?store=${store}`}>{t(locale, "ordersPlanAnother")}</Link>}
          <nav className="switch" aria-label={t(locale, "store")}>
            {Object.entries(stores).map(([id, name]) => (
              <Link key={id} href={`/orders?store=${id}`} aria-current={id === store ? "page" : undefined}>{name}</Link>
            ))}
          </nav>
        </main>
      </div>
    </>
  );
}
