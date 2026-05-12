// src/content/claude.ts
import { spawn } from "node:child_process";
import { log } from "../shared/logger.js";

/**
 * Call Claude Code in headless mode.
 * Uses spawn (not execSync) so we can pipe long prompts via stdin
 * without hitting Windows command-line length limits.
 */
export async function callClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // On Windows the binary is claude.cmd — shell:true handles resolution.
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
        reject(new Error(`Claude exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
    
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Ask Claude for a structured JSON response.
 * Wraps the prompt to enforce JSON-only output, strips code fences, parses.
 */
export async function callClaudeJSON<T>(prompt: string): Promise<T> {
  const wrapped = `${prompt}

CRITICAL: Respond with ONLY valid JSON. No prose before or after. No markdown code fences. Just the raw JSON object.`;
  
  const raw = await callClaude(wrapped);
  
  // Strip code fences if Claude added them anyway
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