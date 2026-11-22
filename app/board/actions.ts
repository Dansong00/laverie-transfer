"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateStaffPreferences } from "../../staff/preferences";
import { sessionCookie } from "../../staff/session";
import { BatchError } from "../../transfer/commands";

export async function saveSections(_: string, data: FormData) {
  try {
    await updateStaffPreferences((await cookies()).get(sessionCookie)?.value, data.getAll("section"));
  } catch (error) {
    if (error instanceof BatchError && error.status === 401) redirect("/");
    return error instanceof BatchError ? error.message : "Could not save board sections. Try again.";
  }
  revalidatePath("/board");
  return "Sections saved.";
}
