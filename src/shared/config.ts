// src/shared/config.ts
import "dotenv/config";
import { z } from "zod";

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
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();