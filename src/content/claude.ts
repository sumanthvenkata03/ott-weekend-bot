// src/content/claude.ts
import { spawn } from "node:child_process";
import { z } from "zod";
import { log } from "../shared/logger.js";

/**
 * Model routing. The per-pillar Sonnet/Opus split is retired — every LLM call now
 * runs on Claude Opus 4.8 through the Max-plan CLI's --model flag. Both ModelChoice
 * keys resolve to MODEL_ID so existing call sites keep compiling; swap the single
 * MODEL_ID constant to change models.
 */
export const MODEL_ID = "claude-opus-4-8";

export const MODELS = {
  sonnet: MODEL_ID,
  opus: MODEL_ID,
} as const;

export type ModelChoice = keyof typeof MODELS;

/**
 * Call Claude Code CLI in headless mode (Max plan) — the sole transport.
 * Pipes the prompt over stdin, forces the model via --model, and (when webSearch
 * is requested) pre-approves the built-in WebSearch tool via --allowedTools so the
 * headless `-p` run grounds its answer without blocking on a permission prompt.
 */
async function callClaudeCLI(
  prompt: string,
  model: ModelChoice,
  opts?: CallOptions
): Promise<string> {
  const modelId = MODELS[model];
  const args = ["-p", "--model", modelId];
  if (opts?.webSearch) {
    // Pre-approve WebSearch (find reviews) AND WebFetch (open the review page to
    // read the outlet's printed rating — most ratings sit in an on-page box the
    // search snippet drops). Comma-joined single token: the CLI accepts a "comma
    // or space-separated list" and one token avoids shell word-splitting.
    args.push("--allowedTools", "WebSearch,WebFetch");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
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
 * Optional per-call overrides. `webSearch` turns on the Max-plan CLI's built-in
 * WebSearch tool (used by grounded Verdict research) for this one invocation — it
 * is pre-approved via --allowedTools so the headless `-p` run never blocks on a
 * permission prompt.
 */
export interface CallOptions {
  /** Enable the CLI's built-in WebSearch tool for this call. */
  webSearch?: boolean;
}

/**
 * Call Claude over the sole transport (Max-plan Claude Code CLI) with explicit
 * model choice. `opts.webSearch` enables grounded research via the CLI's built-in
 * WebSearch tool. There is no API-key path — the pipeline never needs ANTHROPIC_API_KEY.
 */
export async function callClaude(
  prompt: string,
  model: ModelChoice = "opus",
  opts?: CallOptions
): Promise<string> {
  return callClaudeCLI(prompt, model, opts);
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
  model: ModelChoice = "opus"
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