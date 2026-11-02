import { withTransaction, type Pool, type Queryable } from "../db/pool";
import {
  hashMatchingProfile,
  MatchingProfileSchema,
  PreferencesSchema,
  type MatchingProfile,
  type Preferences,
  type Profile,
} from "./schema";
import { SEED_MATCH_PROFILE } from "./seed";

export const OWNER_KEY = "owner";

function toProfile(row: Record<string, any>): Profile {
  return {
    profileId: row.profile_id,
    revisionId: row.id,
    revision: row.revision,
    matching: MatchingProfileSchema.parse(row.matching),
    matchingHash: row.matching_hash,
    preferences: PreferencesSchema.parse(row.preferences),
  };
}

async function currentRevision(db: Queryable, ownerKey: string): Promise<Profile | null> {
  const { rows } = await db.query(
    `SELECT r.* FROM profiles p JOIN profile_revisions r ON r.id = p.current_revision_id WHERE p.owner_key = $1`,
    [ownerKey],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

async function appendRevision(
  db: Queryable,
  profileId: string,
  matching: MatchingProfile,
  preferences: Preferences,
): Promise<Profile> {
  const { rows } = await db.query(
    `INSERT INTO profile_revisions (profile_id, revision, matching, matching_hash, preferences)
     SELECT $1, coalesce(max(revision), 0) + 1, $2, $3, $4 FROM profile_revisions WHERE profile_id = $1
     RETURNING *`,
    [profileId, JSON.stringify(matching), hashMatchingProfile(matching), JSON.stringify(preferences)],
  );
  await db.query(`UPDATE profiles SET current_revision_id = $2 WHERE id = $1`, [profileId, rows[0].id]);
  return toProfile(rows[0]);
}

/** Returns the current revision, creating the first one from the seed on a new database. */
export function ensureProfile(pool: Pool, ownerKey = OWNER_KEY): Promise<Profile> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO profiles (owner_key) VALUES ($1)
       ON CONFLICT (owner_key) DO UPDATE SET owner_key = EXCLUDED.owner_key RETURNING id`,
      [ownerKey],
    );
    await client.query(`SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE`, [rows[0].id]);
    return (
      (await currentRevision(client, ownerKey)) ??
      appendRevision(client, rows[0].id, MatchingProfileSchema.parse(SEED_MATCH_PROFILE), PreferencesSchema.parse({}))
    );
  });
}

export interface ProfileUpdate {
  matching?: unknown;
  preferences?: unknown;
}

/** Appends a revision. Earlier revisions stay, because stored results refer to them. */
export function saveProfile(pool: Pool, update: ProfileUpdate, ownerKey = OWNER_KEY): Promise<Profile> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT id FROM profiles WHERE owner_key = $1 FOR UPDATE`, [ownerKey]);
    if (!rows[0]) throw new Error("Profile does not exist");
    const current = await currentRevision(client, ownerKey);
    if (!current) throw new Error("Profile has no revision");
    return appendRevision(
      client,
      rows[0].id,
      update.matching === undefined ? current.matching : MatchingProfileSchema.parse(update.matching),
      update.preferences === undefined ? current.preferences : PreferencesSchema.parse(update.preferences),
    );
  });
}
