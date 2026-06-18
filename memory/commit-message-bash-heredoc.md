---
name: commit-message-bash-heredoc
description: In the Bash tool, pass multi-line commit messages via heredoc, not PowerShell here-strings
metadata:
  type: feedback
---

The Bash tool runs Git Bash (POSIX sh), so PowerShell here-string syntax (`@'...'@`) does NOT work there — the literal `@'` leaks into the commit subject.

**Why:** Hit this committing the swipe-affordances change; the subject became `@ feat(...)` and needed an `--amend`.

**How to apply:** For multi-line commit messages in the Bash tool use a heredoc: `git commit -F - <<'EOF' ... EOF`. The `@'...'@` form is only for the PowerShell tool. Related: [[push-directly-to-main]].
