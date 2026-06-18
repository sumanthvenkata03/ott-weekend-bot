---
name: autonomous-tool-approval
description: Sumanth pre-approves all tool calls; operate autonomously, don't pause for routine confirmation
metadata:
  type: feedback
---

Sumanth approves every tool permission prompt — bash, git, grep, npm, file edits, all of it. He's the solo repo owner and wants frictionless, autonomous operation: work straight through a multi-step task and present the final verified result, rather than stopping to confirm routine/safe commands.

**Why:** He observed he always clicks Yes; the prompts are pure friction and slow the loop.

**How to apply:** Proceed autonomously through reads/searches/builds/renders/git without asking. The memory alone does NOT suppress the harness permission dialogs — those are governed by `settings.json` permissions, which were configured with a broad allowlist on 2026-06-18 to actually stop the prompts. Still STOP only for genuinely destructive/irreversible actions (e.g. history rewrites, force-push, mass deletes) or real product decisions. Related: [[push-directly-to-main]].
