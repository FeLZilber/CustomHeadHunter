"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "../dashboard/auth";
import { dashboardPool } from "../dashboard/db";
import { parseProfileForm } from "../dashboard/profile-form";
import { setApplied, setSaved } from "../dashboard/queries";
import { hashMatchingProfile } from "../profile/schema";
import { ensureProfile, saveProfile } from "../profile/store";

const SavedForm = z.object({ jobId: z.string().regex(/^\d{1,18}$/), saved: z.enum(["true", "false"]) });

export async function toggleSaved(data: FormData) {
  await requireOwner();
  const form = SavedForm.parse({ jobId: data.get("jobId"), saved: data.get("saved") });
  const pool = dashboardPool();
  const { profileId } = await ensureProfile(pool);
  await setSaved(pool, profileId, form.jobId, form.saved === "true");
  revalidatePath("/", "layout");
}

const AppliedForm = z.object({ jobId: z.string().regex(/^\d{1,18}$/), applied: z.enum(["true", "false"]) });

export async function toggleApplied(data: FormData) {
  await requireOwner();
  const form = AppliedForm.parse({ jobId: data.get("jobId"), applied: data.get("applied") });
  const pool = dashboardPool();
  const { profileId } = await ensureProfile(pool);
  await setApplied(pool, profileId, form.jobId, form.applied === "true");
  revalidatePath("/", "layout");
}

export async function updateProfile(data: FormData) {
  await requireOwner();
  const pool = dashboardPool();
  const current = await ensureProfile(pool);
  const parsed = parseProfileForm(data, current.matching);
  if (!parsed.ok) redirect(`/profile?invalid=${parsed.field}`);
  const unchanged =
    hashMatchingProfile(parsed.matching) === current.matchingHash &&
    JSON.stringify(parsed.preferences) === JSON.stringify(current.preferences);
  if (!unchanged) await saveProfile(pool, { matching: parsed.matching, preferences: parsed.preferences });
  revalidatePath("/", "layout");
  redirect("/profile?saved=1");
}
