import { locales } from "../i18n";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true, mode: "date" } as const;

export const boardSections = [
  "planned",
  "arriving",
  "received",
  "processing",
  "ready_for_return",
  "returning",
  "recently_returned",
] as const;

const boardSectionsDefault = sql.raw(
  `ARRAY[${boardSections.map((section) => `'${section}'`).join(",")}]::text[]`,
);

export const centsRawEvents = pgTable(
  "cents_raw_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    receivedAt: timestamp("received_at", tz).notNull(),
    storeHint: text("store_hint"),
    fingerprint: text("fingerprint").notNull(),
    body: jsonb("body").notNull(),
    duplicateOf: bigint("duplicate_of", { mode: "number" }),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
  },
  (table) => [
    index("cents_raw_events_fingerprint_idx").on(table.fingerprint),
    index("cents_raw_events_received_at_idx").on(table.receivedAt),
    foreignKey({
      name: "cents_raw_events_duplicate_of_fkey",
      columns: [table.duplicateOf],
      foreignColumns: [table.id],
    }),
  ],
);

// store_id is immutable after insert. The trigger that enforces it is in
// drizzle/0001_domain_schema.sql because the Drizzle snapshot cannot express it.
export const centsOrders = pgTable(
  "cents_orders",
  {
    storeId: text("store_id").notNull(),
    orderNumber: text("order_number").notNull(),
    centsOrderId: text("cents_order_id"),
    status: text("status").notNull(),
    dueAt: timestamp("due_at", tz),
    isPersonalDetergent: boolean("is_personal_detergent"),
    customerFirstName: text("customer_first_name"),
    customerLastInitial: text("customer_last_initial"),
    source: text("source").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", tz),
    lastEventId: bigint("last_event_id", { mode: "number" }).references(
      () => centsRawEvents.id,
    ),
    createdAt: timestamp("created_at", tz).notNull(),
    updatedAt: timestamp("updated_at", tz).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.orderNumber] }),
    uniqueIndex("cents_orders_store_identity_idx").on(table.storeId, sql`cents_order_identity(${table.orderNumber})`),
  ],
);

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", tz).notNull(),
  disabledAt: timestamp("disabled_at", tz),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id),
  createdAt: timestamp("created_at", tz).notNull(),
  lastUsedAt: timestamp("last_used_at", tz).notNull(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  revokedAt: timestamp("revoked_at", tz),
});

export const otpCodes = pgTable("otp_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  createdAt: timestamp("created_at", tz).notNull(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  consumedAt: timestamp("consumed_at", tz),
  failedAttempts: integer("failed_attempts").notNull().default(0),
});

export const otpRequests = pgTable(
  "otp_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    requestedAt: timestamp("requested_at", tz).notNull(),
  },
  (table) => [
    index("otp_requests_phone_requested_at_idx").on(
      table.phone,
      table.requestedAt,
    ),
  ],
);

export const staffPreferences = pgTable("staff_preferences", {
  staffId: uuid("staff_id")
    .primaryKey()
    .references(() => staff.id),
  boardSections: text("board_sections").array().notNull().default(boardSectionsDefault),
  locale: text("locale", { enum: locales }).notNull().default("en"),
}, (table) => [check("staff_preferences_locale_valid", sql`${table.locale} in ('en', 'es')`)]);

export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staff.id),
    createdAt: timestamp("created_at", tz).notNull(),
    cancelledAt: timestamp("cancelled_at", tz),
    contentsChanged: boolean("contents_changed").notNull().default(false),
    contentsConfirmedAt: timestamp("contents_confirmed_at", tz),
    contentsConfirmedBy: uuid("contents_confirmed_by").references(() => staff.id),
    contentsConfirmedOrderKeys: jsonb("contents_confirmed_order_keys"),
    returnAcknowledgedAt: timestamp("return_acknowledged_at", tz),
  },
  (table) => [
    unique("batches_id_origin").on(table.id, table.origin),
    index("batches_return_acknowledged_at_idx").on(table.returnAcknowledgedAt),
  ],
);

export const batchCounters = pgTable("batch_counters", {
  origin: text("origin").primaryKey(),
  lastNumber: integer("last_number").notNull(),
});

export const operations = pgTable("operations", {
  operationId: uuid("operation_id").primaryKey(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id),
  kind: text("kind").notNull(),
  batchId: text("batch_id"),
  requestHash: text("request_hash").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", tz).notNull(),
});

export const batchOrders = pgTable(
  "batch_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: text("batch_id").notNull(),
    originStoreId: text("origin_store_id").notNull(),
    storeId: text("store_id").notNull(),
    orderNumber: text("order_number").notNull(),
    phase: text("phase").notNull(),
    addedAt: timestamp("added_at", tz).notNull(),
    addedByOp: uuid("added_by_op")
      .notNull()
      .references(() => operations.operationId),
    removedAt: timestamp("removed_at", tz),
    removalNote: text("removal_note"),
    removedByOp: uuid("removed_by_op").references(() => operations.operationId),
    active: boolean("active").notNull(),
  },
  (table) => [
    foreignKey({
      name: "batch_orders_order_fkey",
      columns: [table.storeId, table.orderNumber],
      foreignColumns: [centsOrders.storeId, centsOrders.orderNumber],
    }),
    foreignKey({
      name: "batch_orders_batch_origin_fkey",
      columns: [table.batchId, table.originStoreId],
      foreignColumns: [batches.id, batches.origin],
    }),
    check(
      "batch_orders_origin_matches_store",
      sql`${table.originStoreId} = ${table.storeId}`,
    ),
    uniqueIndex("batch_orders_one_active_assignment")
      .on(table.storeId, table.orderNumber)
      .where(sql`active`),
    uniqueIndex("batch_orders_one_retained_membership")
      .on(table.storeId, table.orderNumber)
      .where(sql`removed_at is null`),
  ],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.operationId),
    batchId: text("batch_id").notNull(),
    storeId: text("store_id").notNull(),
    orderNumber: text("order_number").notNull(),
    action: text("action").notNull(),
    fromPhase: text("from_phase").notNull(),
    toPhase: text("to_phase").notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    at: timestamp("at", tz).notNull(),
    corrects: uuid("corrects"),
  },
  (table) => [
    foreignKey({
      name: "handoffs_corrects_fkey",
      columns: [table.corrects],
      foreignColumns: [table.id],
    }),
  ],
);
