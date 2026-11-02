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
