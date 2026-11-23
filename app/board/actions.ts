"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateStaffPreferences } from "../../staff/preferences";
import { sessionCookie } from "../../staff/session";
import { BatchError } from "../../transfer/commands";

type SectionStatus = "boardInvalidSections" | "boardSectionsSaveError" | "boardSectionsSaved";

export async function saveSections(_: SectionStatus | null, data: FormData): Promise<SectionStatus> {
  try {
    await updateStaffPreferences((await cookies()).get(sessionCookie)?.value, data.getAll("section"));
  } catch (error) {
    if (error instanceof BatchError && error.status === 401) redirect("/");
    return error instanceof BatchError && error.status === 400 ? "boardInvalidSections" : "boardSectionsSaveError";
  }
  revalidatePath("/board");
  return "boardSectionsSaved";
}
