import type { Provider } from "../connectors/types";

export interface BoardRef {
  provider: Provider;
  providerKey: string;
}

const HOSTS: Array<[RegExp, Provider]> = [
  [/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, "greenhouse"],
  [/^jobs(?:\.eu)?\.lever\.co$/, "lever"],
  [/^jobs\.ashbyhq\.com$/, "ashby"],
  [/^apply\.workable\.com$/, "workable"],
];

/** Workable also serves a board at {account}.workable.com; the account is the subdomain. */
const WORKABLE_SUBDOMAIN = /^([a-z0-9][a-z0-9-]{0,62})\.workable\.com$/;
const WORKABLE_RESERVED = new Set(["www", "apply", "resources", "help", "support", "api"]);

/** The public careers page of a board, which is also what the owner would paste. */
export const careerUrl = ({ provider, providerKey }: BoardRef): string => {
  const key = encodeURIComponent(providerKey);
  if (provider === "greenhouse") return `https://boards.greenhouse.io/${key}`;
  if (provider === "lever") return `https://jobs.lever.co/${key}`;
  if (provider === "workable") return `https://apply.workable.com/${key}/`;
  return `https://jobs.ashbyhq.com/${key}`;
};

/**
 * Reads the board out of a job or careers link on a supported ATS. The first path segment
 * is the company's key on all three. Anything else (a company's own site, LinkedIn) is null:
 * those pages are not read, only the three public ATS APIs are.
 */
export function parseBoardUrl(input: string): BoardRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase();
  const subdomain = WORKABLE_SUBDOMAIN.exec(hostname)?.[1];
  if (subdomain && !WORKABLE_RESERVED.has(subdomain)) return { provider: "workable", providerKey: subdomain };
  const match = HOSTS.find(([host]) => host.test(hostname));
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) return null;
  return { provider: match[1], providerKey: key };
}

/** "acme-labs" -> "Acme Labs", used only when the owner gives no company name. */
export const nameFromKey = (key: string): string =>
  key.split(/[-_.]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ") || key;
