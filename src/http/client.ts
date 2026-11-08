import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { assertAllowedUrl, BlockedDestinationError, createGuardedLookup } from "./guard";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from "./robots";

const PRODUCT_TOKEN = "headhunter-personal-job-search";
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_CRAWL_DELAY_MS = 10_000;

/** Identifies the crawler and, when configured, how to reach whoever runs it. */
export function userAgentFor(contact: string | undefined): string {
  return contact ? `${PRODUCT_TOKEN}/0.2 (+${contact})` : `${PRODUCT_TOKEN}/0.2`;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (
  url: URL,
  headers: Record<string, string>,
  options: { timeoutMs: number; maxBytes: number },
) => Promise<TransportResponse>;

export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

const guardedLookup = createGuardedLookup();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Production transport. Redirects are handled by HttpClient so each hop is revalidated. */
export const guardedTransport: Transport = (url, headers, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { method: "GET", headers, lookup: guardedLookup as never, timeout: timeoutMs },
      (response) => {
        const encoding = firstHeader(response.headers["content-encoding"]);
        const stream =
          encoding === "gzip"
            ? response.pipe(createGunzip())
            : encoding === "br"
              ? response.pipe(createBrotliDecompress())
              : encoding === "deflate"
                ? response.pipe(createInflate())
                : response;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new ResponseTooLargeError(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            const single = firstHeader(value);
            if (single !== undefined) flat[name.toLowerCase()] = single;
          }
          resolve({ status: response.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    request.on("timeout", () => request.destroy(new Error(`Socket idle for ${timeoutMs}ms`)));
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
    request.end();
  });

export interface HttpClientOptions {
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  userAgent?: string;
  /** Honor robots.txt. Defaults to on, except when a custom transport is injected (tests). */
  robots?: boolean;
  /** The user-agent token matched against robots.txt groups. */
  productToken?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRetries?: number;
  maxRedirects?: number;
  maxRetryAfterMs?: number;
  /** Minimum milliseconds between requests per host; `default` covers unlisted hosts. */
  hostIntervalMs?: Record<string, number>;
}

export type FetchResult =
  | { kind: "ok"; status: number; body: string; etag: string | null }
  | { kind: "not_modified"; status: 304 }
  | { kind: "blocked"; status: number; error: string }
  | { kind: "failed"; status: number | null; error: string };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BLOCKED_STATUS = new Set([401, 403, 451]);

/** Bounded GET client for crawling: revalidated redirects, per-host pacing, and capped retries. */
export class HttpClient {
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly options: Required<Pick<HttpClientOptions,
    "userAgent" | "timeoutMs" | "maxBytes" | "maxRetries" | "maxRedirects" | "maxRetryAfterMs" | "hostIntervalMs">>;
  private readonly nextSlot = new Map<string, number>();
  private readonly robotsEnabled: boolean;
  private readonly productToken: string;
  private readonly robotsByOrigin = new Map<string, Promise<RobotsRules>>();
  private readonly crawlDelayMs = new Map<string, number>();

  constructor(options: HttpClientOptions = {}) {
    this.transport = options.transport ?? guardedTransport;
    this.robotsEnabled = options.robots ?? options.transport === undefined;
    this.productToken = options.productToken ?? PRODUCT_TOKEN;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.options = {
      userAgent: options.userAgent ?? userAgentFor(process.env.CRAWLER_CONTACT),
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 48 * 1024 * 1024,
      maxRetries: options.maxRetries ?? 3,
      maxRedirects: options.maxRedirects ?? 5,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 60_000,
      hostIntervalMs: options.hostIntervalMs ?? {
        default: 250,
        "api.lever.co": 1000, // Crawl-delay: 1 in its robots.txt.
      },
    };
  }

  private async pace(host: string): Promise<void> {
    const configured = this.options.hostIntervalMs[host] ?? this.options.hostIntervalMs.default ?? 0;
    const interval = Math.max(configured, this.crawlDelayMs.get(host) ?? 0);
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + interval);
    if (slot > now) await this.sleep(slot - now);
  }

  private retryDelayMs(attempt: number, retryAfter: string | undefined): number | null {
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.now();
      if (Number.isNaN(requested)) return 1000;
      return requested > this.options.maxRetryAfterMs ? null : Math.max(0, requested);
    }
    return this.random() * 500 * 2 ** attempt;
  }

  /** Rules for a URL's origin, fetched once per client and shared by concurrent callers. */
  private rulesFor(url: URL): Promise<RobotsRules> {
    let rules = this.robotsByOrigin.get(url.origin);
    if (!rules) {
      rules = this.fetchRobots(url.origin);
      this.robotsByOrigin.set(url.origin, rules);
    }
    return rules;
  }

  private async fetchRobots(origin: string): Promise<RobotsRules> {
    // Two tries at most: a failing robots.txt must not turn into a retry storm.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.tryFetchRobots(origin);
      if (outcome !== "retry") return outcome;
    }
    return DISALLOW_ALL;
  }

  private async tryFetchRobots(origin: string): Promise<RobotsRules | "retry"> {
    let url = new URL("/robots.txt", origin);
    for (let hop = 0; hop <= this.options.maxRedirects; hop += 1) {
      try {
        assertAllowedUrl(url);
        await this.pace(url.host);
        const response = await this.transport(
          url,
          { "user-agent": this.options.userAgent, accept: "text/plain", "accept-encoding": "gzip, br" },
          { timeoutMs: this.options.timeoutMs, maxBytes: MAX_ROBOTS_BYTES },
        );
        const { status } = response;
        if (status >= 300 && status < 400 && response.headers.location) {
          url = new URL(response.headers.location, url);
          continue;
        }
        if (status >= 200 && status < 300) {
          const rules = parseRobots(response.body, this.productToken);
          if (rules.crawlDelaySeconds) {
            const delayMs = Math.min(rules.crawlDelaySeconds * 1000, MAX_CRAWL_DELAY_MS);
            this.crawlDelayMs.set(new URL(origin).host, delayMs);
          }
          return rules;
        }
        if (status >= 400 && status < 500) return ALLOW_ALL; // RFC 9309: no robots.txt, no restrictions.
        return "retry";
      } catch (error) {
        if (error instanceof BlockedDestinationError || error instanceof ResponseTooLargeError) return DISALLOW_ALL;
        return "retry";
      }
    }
    return DISALLOW_ALL; // Redirect loop.
  }

  async get(input: string, conditional: { etag?: string | null; accept?: string } = {}): Promise<FetchResult> {
    let url = new URL(input);
    let redirects = 0;
    let lastStatus: number | null = null;
    let lastError = "no attempt made";

    for (let attempt = 0; attempt <= this.options.maxRetries; ) {
      try {
        assertAllowedUrl(url);
      } catch (error) {
        return { kind: "blocked", status: 0, error: String(error) };
      }
      if (this.robotsEnabled) {
        const rules = await this.rulesFor(url);
        if (!rules.allows(url.pathname + url.search)) {
          return { kind: "blocked", status: 0, error: "Disallowed by robots.txt" };
        }
      }
      await this.pace(url.host);
      let response: TransportResponse;
      try {
        response = await this.transport(
          url,
          {
            "user-agent": this.options.userAgent,
            accept: conditional.accept ?? "application/json",
            "accept-encoding": "gzip, br",
            ...(conditional.etag ? { "if-none-match": conditional.etag } : {}),
          },
          { timeoutMs: this.options.timeoutMs, maxBytes: this.options.maxBytes },
        );
      } catch (error) {
        if (error instanceof BlockedDestinationError) return { kind: "blocked", status: 0, error: String(error) };
        if (error instanceof ResponseTooLargeError) return { kind: "failed", status: null, error: String(error) };
        lastError = String(error);
        lastStatus = null;
        attempt += 1;
        if (attempt <= this.options.maxRetries) await this.sleep(this.random() * 500 * 2 ** attempt);
        continue;
      }

      const { status } = response;
      lastStatus = status;
      if (status >= 300 && status < 400 && status !== 304) {
        const location = response.headers.location;
        if (!location) return { kind: "failed", status, error: "Redirect without a location" };
        redirects += 1;
        if (redirects > this.options.maxRedirects) return { kind: "failed", status, error: "Too many redirects" };
        url = new URL(location, url);
        continue;
      }
      if (status === 304) return { kind: "not_modified", status };
      if (status >= 200 && status < 300) {
        return { kind: "ok", status, body: response.body, etag: response.headers.etag ?? null };
      }
      if (BLOCKED_STATUS.has(status)) return { kind: "blocked", status, error: `HTTP ${status}` };
      if (!RETRYABLE_STATUS.has(status)) return { kind: "failed", status, error: `HTTP ${status}` };

      lastError = `HTTP ${status}`;
      attempt += 1;
      if (attempt > this.options.maxRetries) break;
      const delay = this.retryDelayMs(attempt, response.headers["retry-after"]);
      if (delay === null) return { kind: "failed", status, error: "Retry-After exceeds the wait limit" };
      await this.sleep(delay);
    }
    return { kind: "failed", status: lastStatus, error: lastError };
  }
}
