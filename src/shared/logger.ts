// src/shared/logger.ts
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function ts() {
  return new Date().toISOString().split("T")[1].slice(0, 8);
}

export const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.cyan}ℹ${colors.reset} ${msg}`, data ?? ""),
  success: (msg: string, data?: unknown) =>
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.green}✓${colors.reset} ${msg}`, data ?? ""),
  warn: (msg: string, data?: unknown) =>
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.yellow}⚠${colors.reset} ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`${colors.gray}${ts()}${colors.reset} ${colors.red}✗${colors.reset} ${msg}`, err ?? ""),
};