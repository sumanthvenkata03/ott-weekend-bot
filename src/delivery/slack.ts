// src/delivery/slack.ts
import { ofetch } from "ofetch";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { redactSecrets } from "../shared/redact.js";

/**
 * The ONE Slack webhook POST — the single source of the request shape. No-op
 * (silent) when the target webhook is unconfigured; THROWS on network error so
 * each caller keeps its own success/failure logging (byte-equivalent to the
 * three inlined POSTs it replaces).
 *
 * `webhookUrl` routes a post to a non-default channel (the News Desk uses it for
 * #tbsi-news-desk). It DEFAULTS to config.SLACK_WEBHOOK_URL, so every existing
 * call site keeps byte-identical behaviour — including the unconfigured no-op.
 *
 * NOT SCRUBBED HERE, on purpose. Redaction happens where the ERROR-DERIVED
 * strings are built (below, and in reconcile/gate.ts), not over the whole
 * serialised body. Blanket-scrubbing every block would run the pattern backstop
 * across News Desk story links and Reddit permalinks — third-party URLs that can
 * legitimately carry a `?token=` tracking parameter — and would silently corrupt
 * operator-facing links to guard content that never holds our secrets.
 */
export async function postToWebhook(
  blocks: unknown[],
  text: string,
  webhookUrl: string | undefined = config.SLACK_WEBHOOK_URL
): Promise<void> {
  if (!webhookUrl) return;
  await ofetch(webhookUrl, {
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
 *
 * REDACTION BOUNDARY. Four fields can carry a string derived from a caught
 * error and are scrubbed here, once, for all six pillars rather than at six call
 * sites: `subtitle`, `validation.metaValue`, `validation.issuesBlock` (the
 * landing/contract reasons, plus Wednesday's folded-in enforcement + copy-guard
 * audit lines) and `deckZip` (whose documented degraded form is
 * "📦 deck zip failed: <reason>"). Titles, metadata, hashtags and the image/Notion
 * URLs are structural or data-derived and are left byte-identical.
 */
export async function notifyDraftReady(payload: DraftNotification): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) {
    log.info("Slack webhook not configured — skipping notification");
    return;
  }

  const subtitle = payload.subtitle === undefined ? undefined : redactSecrets(payload.subtitle);

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
        text: `*${payload.title}*${subtitle ? `\n${subtitle}` : ""}`,
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
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: redactSecrets(payload.validation.metaValue) }],
    });
    if (payload.validation.issuesBlock) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: redactSecrets(payload.validation.issuesBlock) },
      });
    }
  }

  // IG-ready deck zip — one context line (convenience deliverable; degrades to a
  // "failed: <reason>" line when the zip step couldn't complete).
  if (payload.deckZip) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: redactSecrets(payload.deckZip) }] });
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
 * Build the job-failure payload. Extracted from notifyJobFailure so the
 * redaction is assertable in a unit test with no webhook and no network.
 *
 * THIS IS THE CLASS-D FIX. Every job's catch does
 * `notifyJobFailure(pillar, err.message)`, and for any query-string-keyed client
 * (TMDb, OMDb, MDBList) that message is ofetch's `[GET] "<url incl. key>": 401`.
 * Unscrubbed, a single expired key posted the key itself into the channel — a
 * leak to a wider audience than the log ever had.
 *
 * Redaction runs BEFORE the 1500-char clamp, so the clamp still bounds what is
 * actually emitted (and a redacted key, being shorter than the raw one, leaves
 * marginally more real diagnostic text inside the budget).
 */
export function buildJobFailureBlocks(
  jobName: string,
  errorMessage: string
): { blocks: unknown[]; text: string } {
  const text = `🚨 ${jobName} failed`;
  const safe = redactSecrets(errorMessage);
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `\`\`\`${safe.slice(0, 1500)}\`\`\`` } },
  ];
  return { blocks, text };
}

/**
 * Send a job-failure notification. Used when something goes wrong in cron.
 */
export async function notifyJobFailure(jobName: string, errorMessage: string): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) return;

  const { blocks, text } = buildJobFailureBlocks(jobName, errorMessage);
  try {
    await postToWebhook(blocks, text);
  } catch {
    // Last-resort failure — nothing we can do, the user will see the GH Actions email
  }
}
