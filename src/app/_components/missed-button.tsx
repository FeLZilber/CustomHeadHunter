import { toggleMissed } from "../actions";

/** For a job the rule filter removed: says the filter was wrong, so the miss can be studied. */
export function MissedButton({ jobId, flagged }: { jobId: string; flagged: boolean }) {
  return (
    <form action={toggleMissed}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="flagged" value={String(!flagged)} />
      <button type="submit" className="button">
        {flagged ? "Flagged as missed, undo" : "Should have matched"}
      </button>
    </form>
  );
}
