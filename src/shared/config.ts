// src/shared/config.ts
import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  // LLM — using Claude Code CLI, no API key
  
  // Releases
  TMDB_API_KEY: z.string().min(1, "TMDB_API_KEY missing in .env"),
  OMDB_API_KEY: z.string().min(1, "OMDB_API_KEY missing in .env"),
  
  // News (later weeks, optional for now)
  YOUTUBE_API_KEY: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),
  
  // Notion
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN missing in .env"),
  NOTION_RELEASES_DB_ID: z.string().min(1, "NOTION_RELEASES_DB_ID missing in .env"),
  NOTION_NEWS_DB_ID: z.string().min(1, "NOTION_NEWS_DB_ID missing in .env"),
  
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