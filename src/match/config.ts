import { createHash } from "node:crypto";
import modelLock from "../../ollama/model-lock.json";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./prompt";
import { RESPONSE_SCHEMA_VERSION } from "./schema";

/** Everything besides the job and the profile that can change a model answer. */
export interface MatchConfig {
  model: string;
  modelDigest: string;
  promptVersion: string;
  responseSchemaVersion: string;
  rubricVersion: string;
  options: { temperature: number; seed: number; num_ctx: number; num_predict: number };
  maxJobInputTokens: number;
}

export interface MatchConfigEnv {
  OLLAMA_MODEL?: string;
  OLLAMA_MODEL_DIGEST?: string;
  OLLAMA_NUM_CTX: number;
  MAX_OUTPUT_TOKENS: number;
  MAX_JOB_INPUT_TOKENS: number;
}

/** Instructions, candidate profile and validation feedback, measured at about 450 tokens. */
const PROMPT_OVERHEAD_TOKENS = 600;

export function buildMatchConfig(env: MatchConfigEnv): MatchConfig {
  const model = env.OLLAMA_MODEL ?? modelLock.model;
  const modelDigest = env.OLLAMA_MODEL_DIGEST ?? (model === modelLock.model ? modelLock.modelDigest : undefined);
  if (!modelDigest) throw new Error(`OLLAMA_MODEL_DIGEST is required for ${model}, which is not the locked model`);
  // Ollama silently drops the start of an overflowing prompt, which holds the instructions.
  if (env.MAX_JOB_INPUT_TOKENS + PROMPT_OVERHEAD_TOKENS + env.MAX_OUTPUT_TOKENS > env.OLLAMA_NUM_CTX) {
    throw new Error("OLLAMA_NUM_CTX is too small for MAX_JOB_INPUT_TOKENS plus MAX_OUTPUT_TOKENS");
  }
  return {
    model,
    modelDigest,
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    rubricVersion: RUBRIC_VERSION,
    options: { temperature: 0, seed: 42, num_ctx: env.OLLAMA_NUM_CTX, num_predict: env.MAX_OUTPUT_TOKENS },
    maxJobInputTokens: env.MAX_JOB_INPUT_TOKENS,
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const hashMatchConfig = (config: MatchConfig): string => sha256(JSON.stringify(config));

/**
 * Identifies one model question. The filter version is left out on purpose: the
 * filter decides whether to ask, not what is asked, so a filter release can
 * reuse every answer whose input did not change.
 */
export const buildInputKey = (contentHash: string, profileHash: string, configHash: string): string =>
  sha256(`${contentHash}:${profileHash}:${configHash}`);
