// src/shared/config.ts
import "dotenv/config";
import { z } from "zod";
import { registerSecrets } from "./logger.js";

// Parse a boolean-ish env string WITHOUT z.coerce.boolean (which treats any
// non-empty string — including "false" — as true). Only "true"/"1" are truthy.
const boolFromEnv = z
  .string()
  .optional()
  .default("false")
  .transform((s) => s.toLowerCase() === "true" || s === "1");

const ConfigSchema = z.object({
  // LLM — using Claude Code CLI, no API key

  // Releases
  TMDB_API_KEY: z.string().min(1, "TMDB_API_KEY missing in .env"),
  OMDB_API_KEY: z.string().min(1, "OMDB_API_KEY missing in .env"),
  // Optional richer ratings source — if unset, MDBList is skipped and OMDb
  // supplies ratings. Must NOT hard-exit when missing.
  MDBLIST_API_KEY: z.string().optional(),

  // News (later weeks, optional for now)
  YOUTUBE_API_KEY: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  // Dedicated #tbsi-news-desk channel for the Evening Edition draft. Optional:
  // when unset the desk falls back to the main webhook (with a logged notice)
  // so a draft is never silently dropped.
  SLACK_NEWS_WEBHOOK_URL: z.string().url().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),

  // Notion
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN missing in .env"),
  NOTION_RELEASES_DB_ID: z.string().min(1, "NOTION_RELEASES_DB_ID missing in .env"),
  NOTION_NEWS_DB_ID: z.string().min(1, "NOTION_NEWS_DB_ID missing in .env"),

  // R2 (Cloudflare). Creds are required at startup: every visual pillar
  // (Mon/Wed/Sat/Sun) uploads to R2, so a missing key must fail at config
  // load — not mid-run after a paid LLM call. R2_ACCOUNT_ID stays optional
  // (the S3 endpoint is configured directly via R2_S3_ENDPOINT).
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID missing in .env"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY missing in .env"),
  R2_BUCKET_NAME: z.string().default("tbsi-posts"),
  R2_PUBLIC_URL: z.string().url().default("https://pub-c0e6ecae0aba4413a1bbc7f43108546c.r2.dev"),
  R2_S3_ENDPOINT: z.string().url().default("https://f7c79f30ee2349ab15f3fd506f7b5cc0.r2.cloudflarestorage.com"),

  // Runtime config with defaults
  IMPORTANCE_THRESHOLD: z.coerce.number().default(55),
  MAX_NEWS_POSTS_PER_DAY: z.coerce.number().default(6),
  SOUTH_INDUSTRY_BOOST: z.coerce.number().default(1.3),

  // Reconciliation layer — when true, an all-🟢 Wed Drop edition may render
  // unattended; ANY 🟡/🔴 still forces the manual --approve gate. Default false:
  // the gate stops everything until a human approves the reviewed list.
  RECONCILE_AUTOPASS_GREEN: boolFromEnv,
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Hand every SECRET-BEARING value to the log sinks' redaction registry (see
 * shared/redact.ts). Called the instant the parse succeeds, before any consumer
 * can hold a key — registration is PUSHED from here precisely so the logger
 * never has to import this module.
 *
 * WHAT IS REGISTERED: bearer credentials and API keys, including
 * SLACK_WEBHOOK_URL and SLACK_NEWS_WEBHOOK_URL — for an incoming webhook the URL
 * path IS the credential, so the URL itself is the secret.
 *
 * WHAT IS DELIBERATELY NOT: R2_PUBLIC_URL / R2_BUCKET_NAME / R2_S3_ENDPOINT, and
 * the two NOTION_*_DB_ID values. None is a credential, and R2_PUBLIC_URL is the
 * prefix of every cover link the operator clicks out of Slack — registering it
 * would rewrite those links into <REDACTED:…> and break the review workflow.
 * R2_ACCOUNT_ID IS registered: it is the account identifier embedded in the S3
 * endpoint, is never a link a human follows, and belongs with the credentials.
 */
function registerConfigSecrets(c: Config): void {
  registerSecrets({
    TMDB_API_KEY: c.TMDB_API_KEY,
    OMDB_API_KEY: c.OMDB_API_KEY,
    MDBLIST_API_KEY: c.MDBLIST_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    YOUTUBE_API_KEY: c.YOUTUBE_API_KEY,
    NOTION_TOKEN: c.NOTION_TOKEN,
    SLACK_WEBHOOK_URL: c.SLACK_WEBHOOK_URL,
    SLACK_NEWS_WEBHOOK_URL: c.SLACK_NEWS_WEBHOOK_URL,
    REDDIT_CLIENT_ID: c.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: c.REDDIT_CLIENT_SECRET,
    R2_ACCOUNT_ID: c.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: c.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: c.R2_SECRET_ACCESS_KEY,
  });
}

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  registerConfigSecrets(parsed.data);
  return parsed.data;
}

export const config = loadConfig();
