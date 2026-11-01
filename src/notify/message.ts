/** Telegram's limit is 4096 characters after entity parsing. Counted in UTF-16 units, which never undercounts. */
export const MAX_MESSAGE_CHARS = 4096;

const MAX_TECHNOLOGIES = 8;
const MAX_GAPS = 4;

export interface JobCard {
  title: string;
  company: string;
  location: string | null;
  score: number;
  technologies: string[];
  gaps: string[];
  /** Gaps the model reported whose quote is not in the posting, so they stay unconfirmed. */
  unconfirmedGaps: number;
  explanation: string;
  discoveredAt: Date;
  url: string | null;
}

export type AlertEvent = "discovered" | "changed" | "reopened";

export const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cut(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const link = (url: string | null, label: string) => {
  const safe = safeUrl(url);
  return safe ? `<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>` : escapeHtml(label);
};

const place = (card: JobCard) => escapeHtml(cut(card.location ?? "Location not stated", 120));
const techLine = (card: JobCard) =>
  card.technologies.length ? [`Technologies: ${escapeHtml(cut(card.technologies.slice(0, MAX_TECHNOLOGIES).join(", "), 200))}`] : [];
const gapLine = (card: JobCard) => {
  const gaps = card.gaps.slice(0, MAX_GAPS).map((gap) => cut(gap, 80));
  return [
    ...(gaps.length ? [`Confirmed gaps: ${escapeHtml(gaps.join("; "))}`] : []),
    ...(card.unconfirmedGaps ? [`Unconfirmed gaps: ${card.unconfirmedGaps}`] : []),
  ];
};

const HEADINGS: Record<AlertEvent, string> = {
  discovered: "New match",
  changed: "Matching job changed",
  reopened: "Matching job reopened",
};

export function renderAlert(event: AlertEvent, card: JobCard): string {
  return [
    `<b>${HEADINGS[event]}: ${card.score}/100</b>`,
    `<b>${escapeHtml(cut(card.title, 200))}</b>`,
    `${escapeHtml(cut(card.company, 100))}, ${place(card)}`,
    ...techLine(card),
    ...gapLine(card),
    escapeHtml(cut(card.explanation, 400)),
    `Discovered ${card.discoveredAt.toISOString().slice(0, 10)}`,
    link(card.url, "Open application"),
  ].join("\n");
}

function digestEntry(position: number, card: JobCard): string {
  return [
    `${position}. <b>${card.score}/100</b> ${link(card.url, cut(card.title, 120))}`,
    `${escapeHtml(cut(card.company, 80))}, ${place(card)}, discovered ${card.discoveredAt.toISOString().slice(0, 10)}`,
    ...techLine(card),
    ...gapLine(card),
    escapeHtml(cut(card.explanation, 160)),
  ].join("\n");
}

/** Text length as Telegram counts it: tags removed, entities decoded. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot);/g, "x").length;
}

/** Later entries are dropped rather than cut, so every entry shown keeps its link. */
export function renderDigest(heading: string, cards: JobCard[], moreCount: number): string {
  let shown = cards.length;
  while (shown > 0) {
    const hidden = moreCount + cards.length - shown;
    const html = [
      `<b>${escapeHtml(cut(heading, 200))}</b>`,
      ...cards.slice(0, shown).map((card, index) => digestEntry(index + 1, card)),
      ...(hidden ? [`${hidden} more on the dashboard.`] : []),
    ].join("\n\n");
    if (visibleLength(html) <= MAX_MESSAGE_CHARS) return html;
    shown -= 1;
  }
  throw new Error("A digest entry cannot fit in one message");
}
