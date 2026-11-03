"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "../dashboard/auth";
import { dashboardPool } from "../dashboard/db";
import { parseProfileForm } from "../dashboard/profile-form";
import { DISMISS_REASONS, requestSource, setApplied, setDismissed, setMissed, setSaved } from "../dashboard/queries";
import { nameFromKey, parseBoardUrl } from "../ingest/board-url";
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

const DismissForm = z.object({ jobId: z.string().regex(/^\d{1,18}$/), reason: z.enum([...DISMISS_REASONS, "restore"]) });

export async function dismissJob(data: FormData) {
  await requireOwner();
  const form = DismissForm.parse({ jobId: data.get("jobId"), reason: data.get("reason") });
  const pool = dashboardPool();
  const { profileId } = await ensureProfile(pool);
  await setDismissed(pool, profileId, form.jobId, form.reason === "restore" ? null : form.reason);
  revalidatePath("/", "layout");
}

const MissedForm = z.object({ jobId: z.string().regex(/^\d{1,18}$/), flagged: z.enum(["true", "false"]) });

export async function toggleMissed(data: FormData) {
  await requireOwner();
  const form = MissedForm.parse({ jobId: data.get("jobId"), flagged: data.get("flagged") });
  const pool = dashboardPool();
  const { profileId } = await ensureProfile(pool);
  await setMissed(pool, profileId, form.jobId, form.flagged === "true");
  revalidatePath("/", "layout");
}

const SourceForm = z.object({ url: z.string().max(500), company: z.string().max(80).optional() });

export async function followCompany(data: FormData) {
  await requireOwner();
  const form = SourceForm.parse({ url: data.get("url") ?? "", company: (data.get("company") as string | null)?.trim() || undefined });
  const board = parseBoardUrl(form.url);
  if (!board) redirect("/search?follow=unsupported");
  await requestSource(dashboardPool(), board, form.company ?? nameFromKey(board.providerKey));
  revalidatePath("/search");
  redirect("/search?follow=requested");
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
