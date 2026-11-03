export const formatDate = (value: Date) =>
  value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jerusalem" });

export const formatDateTime = (value: Date | null | undefined) =>
  value
    ? value.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jerusalem" })
    : "Never";

/** A posting's link is untrusted, so only web links may reach an href. */
export function safeHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export const humanize = (value: string) => value.replaceAll("_", " ");

/** "today", "3 days ago", "2 months ago": quicker to scan than a date. The exact date goes in a tooltip. */
export function formatAgo(value: Date, now = Date.now()): string {
  const days = Math.floor((now - value.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} ${months === 1 ? "month" : "months"} ago` : formatDate(value);
}
