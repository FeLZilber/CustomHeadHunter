import { SubmitButton } from "./submit-button";
import { toggleSaved } from "../actions";

export function SaveButton({ jobId, saved }: { jobId: string; saved: boolean }) {
  return (
    <form action={toggleSaved}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="saved" value={String(!saved)} />
      <SubmitButton>
        {saved ? "Remove from saved" : "Save job"}
      </SubmitButton>
    </form>
  );
}
