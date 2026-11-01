import { redact } from "../logger";

const API_ROOT = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 30_000;

/** Failures raised before any request bytes could reach Telegram. */
const NEVER_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * What one send attempt proved. Telegram has no idempotency parameter, so
 * `ambiguous` is a real state: the message may be in the chat and nothing can
 * confirm it. Only `not_delivered` and `rate_limited` are safe to resend.
 */
export type SendOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "rate_limited"; retryAfterSeconds: number; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "misconfigured"; detail: string }
  | { kind: "not_delivered"; detail: string }
  | { kind: "ambiguous"; detail: string };

export interface MessageSender {
  send(html: string): Promise<SendOutcome>;
}

interface BotApiReply {
  ok?: unknown;
  result?: { message_id?: unknown };
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

function parseReply(body: string): BotApiReply | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as BotApiReply) : null;
  } catch {
    return null;
  }
}

function transportCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : null;
}

/** Sends through the Bot API. The token sits in the URL, so errors never carry the request or its URL. */
export class TelegramClient implements MessageSender {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(html: string): Promise<SendOutcome> {
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(`${API_ROOT}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        body: JSON.stringify({
          chat_id: this.chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      });
      body = await response.text();
    } catch (error) {
      const code = transportCode(error);
      if (code && NEVER_SENT_CODES.has(code)) return { kind: "not_delivered", detail: code };
      return { kind: "ambiguous", detail: code ?? (error instanceof Error ? error.name : "transport failure") };
    }
    return classify(response.status, parseReply(body));
  }
}

function classify(status: number, reply: BotApiReply | null): SendOutcome {
  const description = typeof reply?.description === "string" ? redact(reply.description).slice(0, 300) : "";
  const detail = `HTTP ${status}${description ? `: ${description}` : ""}`;
  if (reply?.ok === true) {
    const id = reply.result?.message_id;
    return typeof id === "number" ? { kind: "sent", messageId: String(id) } : { kind: "ambiguous", detail: "Success without a message id" };
  }
  // No Bot API verdict, for example a gateway error page, so the request may still have been processed.
  if (reply?.ok !== false) return { kind: "ambiguous", detail: `HTTP ${status} without a Bot API reply` };

  if (status === 429) {
    const retryAfter = reply.parameters?.retry_after;
    return { kind: "rate_limited", retryAfterSeconds: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 30, detail };
  }
  if (status === 401 || status === 403 || status === 404 || /chat not found/i.test(description)) {
    return { kind: "misconfigured", detail };
  }
  if (status >= 500) return { kind: "not_delivered", detail };
  return { kind: "rejected", detail };
}
