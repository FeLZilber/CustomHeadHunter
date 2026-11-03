import { SubmitButton } from "./submit-button";
import { dismissJob } from "../actions";
import { DISMISS_REASONS, type DismissReason } from "../../dashboard/queries";
import { humanize } from "./format";

const LABELS: Record<DismissReason, string> = {
  wrong_role: "Wrong role",
  wrong_seniority: "Wrong seniority",
  wrong_location: "Wrong location",
  wrong_company: "Not this company",
  other: "Other",
};

export function DismissButton({ jobId, reason }: { jobId: string; reason: DismissReason | null }) {
  if (reason) {
    return (
      <form action={dismissJob}>
        <input type="hidden" name="jobId" value={jobId} />
        <input type="hidden" name="reason" value="restore" />
        <SubmitButton>
          Dismissed ({LABELS[reason] ?? humanize(reason)}), restore
        </SubmitButton>
      </form>
    );
  }
  return (
    <form action={dismissJob} className="dismiss">
      <input type="hidden" name="jobId" value={jobId} />
      <select name="reason" aria-label="Why is this not relevant?" defaultValue="wrong_role">
        {DISMISS_REASONS.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
      <SubmitButton>
        Not relevant
      </SubmitButton>
    </form>
  );
}
