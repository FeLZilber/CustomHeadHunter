import { z } from "zod";

export type OllamaErrorKind = "timeout" | "unavailable" | "http" | "malformed";

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

const ChatResponseSchema = z.object({
  model: z.string(),
  message: z.object({ role: z.string(), content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
});

const TagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string(), digest: z.string(), size: z.number() })),
});

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  format: unknown;
  options: { temperature: number; seed: number; num_ctx: number; num_predict: number };
  timeoutMs: number;
  keepAlive?: string;
}

export interface ChatResult {
  content: string;
  doneReason: string | null;
  totalMs: number;
  loadMs: number;
  promptTokens: number;
  promptMs: number;
  outputTokens: number;
  outputMs: number;
}

const nsToMs = (ns: number | undefined) => Math.round((ns ?? 0) / 1e6);

/**
 * Client for the operator-configured Ollama endpoint. It is deliberately
 * separate from the crawler's guarded HTTP client: Ollama lives on loopback,
 * which the crawler must never be allowed to reach.
 */
export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new OllamaError("timeout", `${path} exceeded ${timeoutMs}ms`);
      }
      throw new OllamaError("unavailable", `${path} failed: ${String(error)}`);
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new OllamaError("http", `${path} returned ${response.status}: ${body}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new OllamaError("malformed", `${path} returned non-JSON: ${String(error)}`);
    }
  }

  async version(timeoutMs = 5000): Promise<string> {
    const body = await this.request("/api/version", { method: "GET" }, timeoutMs);
    const parsed = z.object({ version: z.string() }).safeParse(body);
    if (!parsed.success) throw new OllamaError("malformed", "/api/version shape changed");
    return parsed.data.version;
  }

  /** Returns the full digest of an installed model, or null if it is not installed. */
  async modelDigest(model: string, timeoutMs = 5000): Promise<string | null> {
    const body = await this.request("/api/tags", { method: "GET" }, timeoutMs);
    const parsed = TagsResponseSchema.safeParse(body);
    if (!parsed.success) throw new OllamaError("malformed", "/api/tags shape changed");
    return parsed.data.models.find((entry) => entry.name === model)?.digest ?? null;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = await this.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          format: request.format,
          options: request.options,
          stream: false,
          ...(request.keepAlive ? { keep_alive: request.keepAlive } : {}),
        }),
      },
      request.timeoutMs,
    );
    const parsed = ChatResponseSchema.safeParse(body);
    if (!parsed.success) throw new OllamaError("malformed", "/api/chat shape changed");
    const data = parsed.data;
    return {
      content: data.message.content,
      doneReason: data.done_reason ?? null,
      totalMs: nsToMs(data.total_duration),
      loadMs: nsToMs(data.load_duration),
      promptTokens: data.prompt_eval_count ?? 0,
      promptMs: nsToMs(data.prompt_eval_duration),
      outputTokens: data.eval_count ?? 0,
      outputMs: nsToMs(data.eval_duration),
    };
  }
}
