# CLAUDE.md — Working Agreement for the TBSI Codebase

This file defines how Claude Code should work in this repository. Read 
it fully at the start of every session.

## Project context

TBSI (The Big Screen Index, @thebigscreenindex) is an editorial 
automation platform that generates Instagram carousel posts and reels 
for Indian OTT content across 7 languages. TypeScript + Puppeteer 
(headless render) + Anthropic Claude API (editorial copy) + Cloudflare 
R2 + Notion + Slack, delivered via GitHub Actions cron.

Five weekly pillars: Mon Movement, Wed Drop, Sat Verdict, Sun Spotlight, 
Thu Compare (reel-only, deferred).

Launch: June 16, 2026 = Issue #001.

## Golden rules

1. **Never commit unless explicitly told to in this session.** Prototype 
   and review work stays uncommitted. If asked to "fix" or "try" 
   something, that is NOT permission to commit.

2. **Two render modes, two cost profiles:**
   - `render:*` scripts use sample data and make NO API calls. Use these 
     for all design/layout work.
   - `job:*` scripts run the FULL pipeline including live Anthropic API 
     calls that cost real money. Only run these when explicitly asked to 
     test live generation.
   - `claude:test` calls the API. Costs money. Don't run casually.

3. **Anthropic API calls cost credits regardless of where code runs.** 
   "Local" does not mean free. Never add or trigger API calls without 
   flagging the cost implication.

## Pre-flight before any change

Before editing templates or rendering code:
1. Read the target template AND the orchestrator/renderer that supplies 
   its data. Confirm variable names match — mismatches are a common bug.
2. Read the relevant design tokens file for CSS variable names (note: 
   tokens use `--bottle` not `--bottle-green`, `longDate`/`shortDate` 
   filters exist in renderer.ts).
3. State your understanding of the current state before changing it.

## Self-verification after any change (REQUIRED)

Do not report "done" until you have verified. For rendering changes:

1. Type-check: `npx tsc --noEmit` must pass.
2. Re-render via the appropriate `render:*` script (sample data, no cost).
3. Open the generated PNGs and inspect at NATIVE RESOLUTION. Chat-preview 
   compression hides real layout bugs — crop the actual output PNG at 1:1 
   and look.
4. Verify against explicit criteria. Checks must confirm:
   - Content is not clipped (measure DOM width vs cell width if unsure)
   - **Elements do NOT overlap each other** (visibility ≠ non-overlap — 
     a "fully visible" stamp can still sit on top of body text)
   - Nothing exceeds card bounds
   - Variant logic (NEW ARRIVAL vs HIDDEN GEM colors/borders) is correct
5. Report a structured audit: what you changed, per-criterion pass/fail, 
   and any residual risk. Include measurements, not just "looks fine."

## Engineering judgment

- **When 2 rounds of parameter-tuning (font size, grid ratios, padding) 
  don't converge, STOP and change the layout structure instead.** Don't 
  tune a third time. (Example: the info-bar languages-clipping problem 
  was solved by restructuring 3-equal-cells → 2-rows, after 4 failed 
  rounds of ratio tuning.)
- Prefer structural fixes (normal document flow) over magic-number 
  positioning (absolute offsets) — they survive content changes.
- If a fix requires a product decision, STOP and ask. Don't guess.

## Code conventions (Sumanth's standing preferences)

- Tabs, not spaces.
- CRLF line endings.
- Commit messages: no attribution/co-author trailers.
- Copy-paste-ready answers; minimal preamble.
- Branch names without JIRA prefixes.

## What to never do

- Never commit secrets. `.env` is gitignored; keep it that way.
- Never hardcode API keys, tokens, or credentials in source.
- Never let sample/test data leak into the `job:*` production path.
- Never apply a prototype change to all pillars before the reference 
  pillar (Mon Movement) is reviewed and approved.