import { SubmitButton } from "./submit-button";
import { toggleApplied } from "../actions";
import { formatDate } from "./format";

export function ApplyButton({ jobId, appliedAt }: { jobId: string; appliedAt: Date | null }) {
  return (
    <form action={toggleApplied}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="applied" value={String(!appliedAt)} />
      <SubmitButton>
        {appliedAt ? `Applied ${formatDate(appliedAt)}, undo` : "Mark as applied"}
      </SubmitButton>
    </form>
  );
}
