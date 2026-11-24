import { AppHeader } from "../ui/app-header";
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
    <Suspense fallback={<p>{t(locale, "ordersLoading")}</p>}>
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

  return (
    <>
      <AppHeader actor={actor} locale={locale} store={store} />
      <main className="eligible-orders">
        <h1>{t(locale, "orders")}</h1>
        <nav aria-label={t(locale, "store")}>
          {Object.entries(stores).map(([id, name]) => (
            <Link key={id} href={`/orders?store=${id}`} aria-current={id === store ? "page" : undefined}>
              {name}
            </Link>
          ))}
        </nav>
        {typeof query.sent === "string" && (
          <p role="status">{t(locale, "ordersSentStatus", { batch: query.sent })}</p>
        )}
        {query.saved === "again" && <p role="status">{t(locale, "alreadySaved")}</p>}
        <Planner
          key={JSON.stringify([store, plan?.id, plan?.version, trip?.id, trip?.version])}
          locale={locale}
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
          <h2>{t(locale, "ordersEligibleAt", { store: stores[store] })}</h2>
          {orders.length === 0 ? (
            <p>{t(locale, "ordersNoneEligible", { store: stores[store] })}</p>
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
                      <time dateTime={order.dueAt.toISOString()}>
                        {t(locale, "ordersDue", {
                          date: formatLocalDate(locale, order.dueAt),
                        })}
                      </time>
                    ) : (
                      t(locale, "ordersNoDueDate")
                    )}
                  </small>
                  {order.isPersonalDetergent && <small>{t(locale, "personalDetergent")}</small>}
                </li>
              ))}
            </ul>
          )}
        </Planner>
        {listedTrips.length > 0 && (
          <section>
            <h2>{t(locale, "ordersSentTo", { store: stores[store] })}</h2>
            <ul>
              {listedTrips.map((trip) => (
                <li key={trip.id}>
                  <Link href={`/orders?store=${store}&contents=${trip.id}`}>{trip.id}</Link>
                  {trip.changed && <> · {t(locale, "contentsChanged")}</>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {trip && <Link href={`/orders?store=${store}`}>{t(locale, "ordersBackToEligible")}</Link>}
        {plans.length > 0 && (
          <section>
            <h2>{t(locale, "ordersPlannedBatches")}</h2>
            <ul>
              {plans.map((batch) => (
                <li key={batch.id}>
                  <Link href={`/orders?store=${store}&batch=${batch.id}`}>{batch.id}</Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {plan && <Link href={`/orders?store=${store}`}>{t(locale, "ordersPlanAnother")}</Link>}
      </main>
    </>
  );
}
