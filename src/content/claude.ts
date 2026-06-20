// src/content/claude.ts
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";

/**
 * Available models for API calls.
 * Sonnet: cheaper, faster, great for curation/listing pillars.
 * Opus: pricier, deeper editorial register, used for verdicts/spotlight/compare.
 */
export const MODELS = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

export type ModelChoice = keyof typeof MODELS;

// Approximate per-million-token pricing for cost log line
const PRICING = {
  sonnet: { input: 3, output: 15 },
  opus:   { input: 5, output: 25 },
} as const;

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY required for API mode");
    }
    anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Call Claude Code CLI in headless mode. Local dev path (Max plan).
 * Always uses whatever model Claude Code defaults to (currently Opus 4.7).
 * The model parameter is accepted but ignored — CLI doesn't expose model choice in -p mode.
 */
async function callClaudeCLI(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
    
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Optional per-call overrides. `tools` enables server-side tools (e.g. the
 * web_search tool used by grounded Verdict research) — these run ONLY on the
 * API path; the CLI path can't execute server tools, so requesting tools without
 * an API key throws rather than silently dropping them. Threaded through the one
 * existing client (we never fork a second Anthropic instance).
 */
export interface CallOptions {
  /** Server-side tools to enable (e.g. web_search). */
  tools?: Anthropic.Messages.ToolUnion[];
  /** Override max_tokens (default 4096). */
  maxTokens?: number;
}

/**
 * Call Claude via the Anthropic API with explicit model choice.
 *
 * Tools (when supplied) make the model run an agentic loop SERVER-SIDE within
 * this single request: the response.content interleaves server_tool_use +
 * web_search_tool_result + text blocks. We join only the TEXT blocks (the final
 * answer), which is exactly the same extraction used for plain calls.
 */
async function callClaudeAPI(
  prompt: string,
  model: ModelChoice,
  opts?: CallOptions
): Promise<string> {
  const client = getAnthropicClient();
  const modelId = MODELS[model];

  const response = await client.messages.create({
    model: modelId,
    max_tokens: opts?.maxTokens ?? 4096,
    messages: [{ role: "user", content: prompt }],
    ...(opts?.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
  });

  const text = response.content
    .filter(block => block.type === "text")
    .map(block => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  const pricing = PRICING[model];
  const cost = (response.usage.input_tokens * pricing.input + response.usage.output_tokens * pricing.output) / 1_000_000;
  // server_tool_use web search adds its own line-item cost, billed separately by
  // the API; this estimate covers token cost only (flagged so logs aren't read
  // as the full bill when tools are enabled).
  const toolNote = opts?.tools && opts.tools.length > 0 ? " + web_search (billed separately)" : "";
  log.info(
    `Claude API [${model}]: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens ` +
    `(~$${cost.toFixed(4)}${toolNote})`
  );

  return text;
}

/**
 * Call Claude. Picks API (with chosen model) if ANTHROPIC_API_KEY is set, else falls back to CLI.
 * The `model` parameter is honored on API path; ignored on CLI path (CLI uses Max plan default).
 * `opts.tools` is API-only — requesting tools without an API key throws.
 */
export async function callClaude(
  prompt: string,
  model: ModelChoice = "sonnet",
  opts?: CallOptions
): Promise<string> {
  if (config.ANTHROPIC_API_KEY) {
    return callClaudeAPI(prompt, model, opts);
  }
  if (opts?.tools && opts.tools.length > 0) {
    throw new Error(
      "Server-side tools (e.g. web_search) require ANTHROPIC_API_KEY — the CLI path can't run them."
    );
  }
  return callClaudeCLI(prompt);
}

/**
 * JSON variant. Same routing + model selection, PLUS runtime validation.
 *
 * The caller supplies a zod schema describing the expected shape. The raw reply
 * is fence-stripped, JSON.parsed, then schema-validated. If either step fails,
 * we re-ask ONCE with a corrective nudge (same model) so a transient bad reply
 * self-heals instead of throwing a TypeError deep inside a generator. If the
 * retry also fails we throw a descriptive Error (zod issues + a raw snippet) so
 * the job's Slack failure alert is actionable.
 */
export async function callClaudeJSON<T>(
  prompt: string,
  schema: z.ZodType<T>,
  model: ModelChoice = "sonnet"
): Promise<T> {
  const baseInstruction = `

CRITICAL: Respond with ONLY valid JSON. No prose before or after. No markdown code fences. Just the raw JSON object.`;

  // One attempt: call Claude, strip fences, JSON.parse, schema.safeParse.
  const attempt = async (
    fullPrompt: string
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string; raw: string }> => {
    const raw = await callClaude(fullPrompt, model);

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      return { ok: false, raw: cleaned, reason: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, raw: cleaned, reason: `schema validation failed: ${JSON.stringify(result.error.issues).slice(0, 300)}` };
    }
    return { ok: true, value: result.data };
  };

  // Attempt 1
  const first = await attempt(`${prompt}${baseInstruction}`);
  if (first.ok) return first.value;

  // Attempt 2 — re-ask once with a corrective nudge (same model)
  log.warn(`callClaudeJSON: invalid output, retrying once (${first.reason})`);
  const corrective = `${prompt}${baseInstruction}

Your previous reply was invalid: ${first.reason}. Respond with ONLY valid JSON matching the required structure — no prose, no code fences.`;
  const second = await attempt(corrective);
  if (second.ok) return second.value;

  throw new Error(
    `callClaudeJSON failed after one retry. ` +
    `Attempt 1: ${first.reason}. Attempt 2: ${second.reason}. ` +
    `Raw response snippet: ${second.raw.slice(0, 300)}`
  );
}