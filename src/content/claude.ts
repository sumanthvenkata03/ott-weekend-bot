// src/content/claude.ts
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
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
 * Call Claude via the Anthropic API with explicit model choice.
 */
async function callClaudeAPI(prompt: string, model: ModelChoice): Promise<string> {
  const client = getAnthropicClient();
  const modelId = MODELS[model];
  
  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  
  const text = response.content
    .filter(block => block.type === "text")
    .map(block => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();
  
  const pricing = PRICING[model];
  const cost = (response.usage.input_tokens * pricing.input + response.usage.output_tokens * pricing.output) / 1_000_000;
  log.info(
    `Claude API [${model}]: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens ` +
    `(~$${cost.toFixed(4)})`
  );
  
  return text;
}

/**
 * Call Claude. Picks API (with chosen model) if ANTHROPIC_API_KEY is set, else falls back to CLI.
 * The `model` parameter is honored on API path; ignored on CLI path (CLI uses Max plan default).
 */
export async function callClaude(prompt: string, model: ModelChoice = "sonnet"): Promise<string> {
  if (config.ANTHROPIC_API_KEY) {
    return callClaudeAPI(prompt, model);
  }
  return callClaudeCLI(prompt);
}

/**
 * JSON variant. Same routing + model selection.
 */
export async function callClaudeJSON<T>(prompt: string, model: ModelChoice = "sonnet"): Promise<T> {
  const wrapped = `${prompt}

CRITICAL: Respond with ONLY valid JSON. No prose before or after. No markdown code fences. Just the raw JSON object.`;
  
  const raw = await callClaude(wrapped, model);
  
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    log.error("Claude returned non-JSON response", cleaned.slice(0, 500));
    throw new Error(`Failed to parse Claude JSON: ${err instanceof Error ? err.message : err}`);
  }
}