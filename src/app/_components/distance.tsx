import { HOME } from "../../normalize/location";

/** Straight-line km from home; nothing when the posting names no known city. */
export function Distance({ km }: { km: number | null }) {
  if (km === null) return null;
  return <span title={`Straight line from ${HOME.name}`}>{km} km away</span>;
}
