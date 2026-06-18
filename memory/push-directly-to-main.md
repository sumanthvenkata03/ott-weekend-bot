---
name: push-directly-to-main
description: Sumanth wants commits pushed directly to main, no feature branch
metadata:
  type: feedback
---

When Sumanth says to push, commit and push directly to `main` — do NOT create a separate feature branch or open a PR.

**Why:** It's his solo repo; the branch+PR ceremony is unwanted overhead. (He confirmed this after the mon-cover-swipe-affordances PR flow.)

**How to apply:** Only push after the change is verified (per CLAUDE.md self-verification). Still never commit unless explicitly told to in-session. Keep commit conventions from CLAUDE.md: no co-author/attribution trailers, no JIRA prefixes. See [[commit-message-bash-heredoc]] for the message-passing gotcha.
