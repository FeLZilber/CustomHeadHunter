import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { FIELD_LABELS, type ListField } from "../../dashboard/profile-form";
import { ensureProfile } from "../../profile/store";
import { updateProfile } from "../actions";

const LISTS: Array<[ListField, string]> = [
  ["titles", "Target titles"],
  ["seniorities", "Seniority"],
  ["requiredSkills", "Required skills"],
  ["preferredSkills", "Preferred skills"],
  ["preferredLocations", "Preferred locations"],
  ["workArrangements", "Work arrangements"],
  ["preferredIndustries", "Preferred industries"],
  ["exclusions", "Exclusions"],
];

type Params = Promise<{ saved?: string; invalid?: string }>;

export default async function ProfilePage({ searchParams }: { searchParams: Params }) {
  await requireOwner();
  const { saved, invalid } = await searchParams;
  const { matching, preferences, revision } = await ensureProfile(dashboardPool());
  const invalidLabel = invalid ? FIELD_LABELS[invalid] : undefined;
  return (
    <>
      <h1>Profile</h1>
      <p className="meta">Revision {revision}. Separate list items with commas or new lines.</p>
      {saved ? <p className="notice" role="status">Profile saved. Changes to matching fields apply to jobs on the next worker run.</p> : null}
      {invalidLabel ? <p className="notice notice-error" role="alert">Check this field: {invalidLabel}.</p> : null}
      <form className="profile" action={updateProfile}>
        {LISTS.map(([name, label]) => (
          <label key={name}>
            {label}
            <textarea name={name} rows={2} dir="auto" defaultValue={matching[name].join("\n")} />
          </label>
        ))}
        <label>
          Excluded title terms
          <textarea name="excludedTitleTerms" rows={2} dir="auto" defaultValue={matching.hardRules.excludedTitleTerms.join("\n")} />
        </label>
        <div className="row">
          <label>
            Experience from (years)
            <input name="experienceMin" type="number" min={0} defaultValue={matching.candidateExperienceYears?.min} />
          </label>
          <label>
            Experience to (years)
            <input name="experienceMax" type="number" min={0} defaultValue={matching.candidateExperienceYears?.max} />
          </label>
        </div>
        <div className="row">
          <label>
            Minimum salary
            <input name="salaryMin" type="number" min={1} defaultValue={matching.salaryExpectation?.min} />
          </label>
          <label>
            Currency
            <input name="salaryCurrency" defaultValue={matching.salaryExpectation?.currency ?? "ILS"} />
          </label>
          <label>
            Period
            <input name="salaryPeriod" defaultValue={matching.salaryExpectation?.period ?? "month"} />
          </label>
        </div>
        <label>
          Notification threshold (0 to 100)
          <input name="notificationThreshold" type="number" min={0} max={100} required defaultValue={preferences.notificationThreshold} />
        </label>
        <button type="submit" className="button">
          Save profile
        </button>
      </form>
    </>
  );
}
