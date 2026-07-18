// src/delivery/slack.ts
import { ofetch } from "ofetch";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";

/**
 * The ONE Slack webhook POST — the single source of the request shape. No-op
 * (silent) when SLACK_WEBHOOK_URL is unconfigured; THROWS on network error so
 * each caller keeps its own success/failure logging (byte-equivalent to the
 * three inlined POSTs it replaces).
 */
export async function postToWebhook(blocks: unknown[], text: string): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;
  await ofetch(config.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { blocks, text },
  });
}

/**
 * Payload for a "draft ready" notification.
 */
export interface DraftNotification {
  pillar: string;                    // "Wed Drop", "Sat Verdict", etc.
  emoji: string;                      // "🎬", "⚖️", etc. — fits the pillar
  title: string;                      // headline shown in Slack
  subtitle?: string;                  // a one-line tease (caption opener, hot take, etc.)
  notionUrl: string;
  metadata?: Record<string, string>;  // extra context fields, shown as a list
  coverImageUrl?: string;             // primary cover image — inline preview
  bodyCardImageUrls?: string[];       // body card images — link buttons
  hashtags?: string;                  // space-separated #tags — rendered copy-paste-ready
  validation?: { metaValue: string; issuesBlock?: string };  // landing-verifier summary + flagged rows
  deckZip?: string;                   // one-line IG-deck-zip cue, e.g. "📦 IG-ready deck (11 slides, 2.3 MB): <url>" (or a degraded "📦 deck zip failed: …")
  primaryButtonLabel?: string;        // primary action button label — defaults to "Open in Notion"; a Notion-less pillar (Archives) passes its own (e.g. "Open cover")
}

/**
 * Send a richly formatted notification to the Slack channel.
 * No-op if SLACK_WEBHOOK_URL isn't set — Slack is optional.
 */
export async function notifyDraftReady(payload: DraftNotification): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) {
    log.info("Slack webhook not configured — skipping notification");
    return;
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${payload.emoji} ${payload.pillar} draft is ready`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${payload.title}*${payload.subtitle ? `\n${payload.subtitle}` : ""}`,
      },
    },
  ];

  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    blocks.push({
      type: "section",
      fields: Object.entries(payload.metadata).map(([k, v]) => ({
        type: "mrkdwn",
        text: `*${k}:*\n${v}`,
      })),
    });
  }

  if (payload.validation) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: payload.validation.metaValue }] });
    if (payload.validation.issuesBlock) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: payload.validation.issuesBlock } });
    }
  }

  // IG-ready deck zip — one context line (convenience deliverable; degrades to a
  // "failed: <reason>" line when the zip step couldn't complete).
  if (payload.deckZip) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: payload.deckZip }] });
  }

  if (payload.coverImageUrl) {
    blocks.push({
      type: "image",
      image_url: payload.coverImageUrl,
      alt_text: `${payload.pillar} cover preview`,
    });
  }

  if (payload.bodyCardImageUrls && payload.bodyCardImageUrls.length > 0) {
    blocks.push({
      type: "actions",
      elements: payload.bodyCardImageUrls.map((url, i) => ({
        type: "button",
        text: { type: "plain_text", text: `Card ${i + 1}`, emoji: true },
        url,
      })),
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: payload.primaryButtonLabel ?? "Open in Notion", emoji: true },
        url: payload.notionUrl,
        style: "primary",
      },
    ],
  });

  // Hashtags in a triple-backtick code block — one-tap copyable on mobile + desktop.
  if (payload.hashtags && payload.hashtags.trim().length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Hashtags*\n\`\`\`${payload.hashtags.trim()}\`\`\``,
      },
    });
  }

  try {
    await postToWebhook(blocks, `${payload.emoji} ${payload.pillar} draft is ready`);
    log.success("Slack notification sent");
  } catch (err) {
    // Notification failure shouldn't abort the job — log and continue
    log.warn("Slack notification failed", err instanceof Error ? err.message : err);
  }
}

/**
 * Send a job-failure notification. Used when something goes wrong in cron.
 */
export async function notifyJobFailure(jobName: string, errorMessage: string): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;

  const text = `🚨 ${jobName} failed`;
  const blocks = [
    { type: "header", text: { type: "plain_text", text, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `\`\`\`${errorMessage.slice(0, 1500)}\`\`\`` } },
  ];
  try {
    await postToWebhook(blocks, text);
  } catch {
    // Last-resort failure — nothing we can do, the user will see the GH Actions email
  }
}
