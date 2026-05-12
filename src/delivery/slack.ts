// src/delivery/slack.ts
import { ofetch } from "ofetch";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";

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
  
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open in Notion", emoji: true },
        url: payload.notionUrl,
        style: "primary",
      },
    ],
  });
  
  try {
    await ofetch(config.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { blocks, text: `${payload.emoji} ${payload.pillar} draft is ready` },
    });
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
  
  try {
    await ofetch(config.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        text: `🚨 ${jobName} failed`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `🚨 ${jobName} failed`, emoji: true },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `\`\`\`${errorMessage.slice(0, 1500)}\`\`\`` },
          },
        ],
      },
    });
  } catch {
    // Last-resort failure — nothing we can do, the user will see the GH Actions email
  }
}