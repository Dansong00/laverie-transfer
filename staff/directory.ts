import { createHash } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { operations, otpCodes, sessions, staff } from "../db/schema";
import { directoryErrors } from "../i18n/directory-errors";
import { getProfile, hasValidSessionToken } from "./session";
import { normalizePhone } from "./settings";

export class DirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: keyof typeof directoryErrors,
  ) {
    super(directoryErrors[code].en);
  }
}

type Transaction = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;
type Role = "staff" | "admin";
export type StaffChange =
  | { kind: "addStaff"; name: string; phone: string; role: Role }
  | { kind: "disableStaff"; targetStaffId: string }
  | { kind: "enableStaff"; targetStaffId: string }
  | { kind: "updateStaffRole"; targetStaffId: string; role: Role };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const summary = { id: staff.id, name: staff.name, role: staff.role, active: staff.active };
export type DirectoryMember = Pick<typeof staff.$inferSelect, "id" | "name" | "role" | "active" | "phone">;
type Member = Pick<typeof staff.$inferSelect, keyof typeof summary>;

function validRole(role: unknown): Role {
  if (role !== "admin" && role !== "staff") throw new DirectoryError(400, "DIRECTORY_INVALID_ROLE");
  return role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseChange(input: unknown): { operationId: string; change: StaffChange } {
  if (!isRecord(input) || typeof input.operationId !== "string" || !uuid.test(input.operationId)) {
    throw new DirectoryError(400, "DIRECTORY_INVALID_CHANGE");
  }
  const operationId = input.operationId.toLowerCase();
  if (input.kind === "addStaff") {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const phone = normalizePhone(input.phone);
    if (!name || name.length > 120 || !phone)
      throw new DirectoryError(400, "DIRECTORY_INVALID_CONTACT");
    return { operationId, change: { kind: input.kind, name, phone, role: validRole(input.role) } };
  }
  if (typeof input.targetStaffId !== "string" || !uuid.test(input.targetStaffId)) {
    throw new DirectoryError(400, "DIRECTORY_MEMBER_REQUIRED");
  }
  const targetStaffId = input.targetStaffId.toLowerCase();
  if (input.kind === "disableStaff" || input.kind === "enableStaff")
    return { operationId, change: { kind: input.kind, targetStaffId } };
  if (input.kind === "updateStaffRole") {
    return { operationId, change: { kind: input.kind, targetStaffId, role: validRole(input.role) } };
  }
  throw new DirectoryError(400, "DIRECTORY_UNKNOWN_CHANGE");
}

async function requireAdmin(token: string | undefined, tx: Transaction) {
  const actor = await getProfile(token, tx);
  if (!actor) throw new DirectoryError(401, "DIRECTORY_SIGN_IN_REQUIRED");
  if (actor.role !== "admin") throw new DirectoryError(403, "DIRECTORY_ADMIN_REQUIRED");
  return actor.staffId;
}

export async function readDirectory(token: string | undefined) {
  if (!hasValidSessionToken(token)) throw new DirectoryError(401, "DIRECTORY_SIGN_IN_REQUIRED");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`lock table staff in share mode`);
    const actorId = await requireAdmin(token, tx);
    const members = await tx
      .select({ ...summary, phone: staff.phone })
      .from(staff)
      .orderBy(asc(staff.name), asc(staff.id));
    return { actorId, members };
  });
}

export async function listStaff(token: string | undefined) {
  return (await readDirectory(token)).members;
}

async function addStaff(tx: Transaction, change: Extract<StaffChange, { kind: "addStaff" }>) {
  const [member] = await tx
    .insert(staff)
    .values({
      name: change.name,
      phone: change.phone,
      role: change.role,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: staff.phone })
    .returning(summary);
  if (!member) throw new DirectoryError(409, "DIRECTORY_PHONE_ALREADY_REGISTERED");
  return member;
}

async function setStaffAccess(tx: Transaction, id: string, phone: string, active: boolean) {
  const now = new Date();
  const [member] = await tx
    .update(staff)
    .set({ active, disabledAt: active ? null : now })
    .where(eq(staff.id, id))
    .returning(summary);
  await tx
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.staffId, id), isNull(sessions.revokedAt)));
  await tx.update(otpCodes).set({ consumedAt: now })
    .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)));
  return member;
}

async function updateStaffRole(tx: Transaction, id: string, role: Role) {
  const [member] = await tx.update(staff).set({ role }).where(eq(staff.id, id)).returning(summary);
  return member;
}

async function applyChange(tx: Transaction, change: StaffChange) {
  if (change.kind === "addStaff") return addStaff(tx, change);
  const [person] = await tx.select({ ...summary, phone: staff.phone }).from(staff).where(eq(staff.id, change.targetStaffId));
  if (!person) throw new DirectoryError(404, "DIRECTORY_MEMBER_NOT_FOUND");
  if (change.kind === "enableStaff") {
    if (person.active) throw new DirectoryError(409, "DIRECTORY_MEMBER_ALREADY_ACTIVE");
    return setStaffAccess(tx, person.id, person.phone, true);
  }
  if (!person.active) throw new DirectoryError(409, "DIRECTORY_MEMBER_DISABLED");
  if (person.role === "admin" && (change.kind === "disableStaff" || change.role === "staff")) {
    const [other] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          ne(staff.id, person.id),
          eq(staff.active, true),
          isNull(staff.disabledAt),
          eq(staff.role, "admin"),
        ),
      )
      .limit(1);
    if (!other) throw new DirectoryError(409, "DIRECTORY_LAST_ACTIVE_ADMIN");
  }
  if (change.kind === "disableStaff") return setStaffAccess(tx, person.id, person.phone, false);
  return updateStaffRole(tx, person.id, change.role);
}

export async function saveStaffChange(token: string | undefined, input: unknown) {
  if (!hasValidSessionToken(token)) throw new DirectoryError(401, "DIRECTORY_SIGN_IN_REQUIRED");
  return getDb().transaction(async (tx) => {
    // Shared with first-admin bootstrap. Serialize directory edits before checking
    // the actor, counting other admins, or changing staff and session rows.
    await tx.execute(sql`lock table staff in share row exclusive mode`);
    const staffId = await requireAdmin(token, tx);
    const { operationId, change } = parseChange(input);
    const requestHash = createHash("sha256").update(JSON.stringify(change)).digest("hex");
    const [previous] = await tx.select().from(operations).where(eq(operations.operationId, operationId));
    if (previous) {
      if (
        previous.staffId !== staffId ||
        previous.kind !== change.kind ||
        previous.requestHash !== requestHash
      ) {
        throw new DirectoryError(409, "DIRECTORY_OPERATION_ID_CONFLICT");
      }
      return { member: previous.result as Member, replayed: true };
    }
    const member = await applyChange(tx, change);
    const saved = await tx
      .insert(operations)
      .values({
        operationId,
        staffId,
        kind: change.kind,
        requestHash,
        result: member,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: operations.operationId });
    if (!saved.length) throw new DirectoryError(409, "DIRECTORY_OPERATION_ID_CONFLICT");
    return { member, replayed: false };
  });
}
