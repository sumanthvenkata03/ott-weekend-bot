// scripts/movie-lookup/deploy.check.ts
// Tool-local tests for the DEPLOYMENT surface (Basic Auth + PWA manifest +
// service worker). Named *.check.ts so the repo's default `npx vitest run`
// never collects them — the main suite stays exactly 190. Run with:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Fully offline: only pure functions (auth.ts) and static files under ./public
// are exercised — no SQLite, no network.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { authEnabled, checkBasicAuth, wwwAuthenticateHeader, type AuthConfig } from "./auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const publicFile = (f: string) => readFileSync(join(HERE, "public", f), "utf8");
const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`, "utf8").toString("base64");

describe("Basic Auth — disabled (open) when unconfigured", () => {
  it("authEnabled is false when either credential is missing/empty", () => {
    expect(authEnabled({})).toBe(false);
    expect(authEnabled({ user: "a" })).toBe(false);
    expect(authEnabled({ pass: "b" })).toBe(false);
    expect(authEnabled({ user: "", pass: "" })).toBe(false);
    expect(authEnabled({ user: "a", pass: "b" })).toBe(true);
  });
  it("checkBasicAuth allows every request (even with no header) when unconfigured", () => {
    expect(checkBasicAuth(undefined, {})).toBe(true);
    expect(checkBasicAuth("garbage", {})).toBe(true);
  });
});

describe("Basic Auth — enabled: 401 on wrong creds, 200-path on right creds", () => {
  const cfg: AuthConfig = { user: "sumanth", pass: "s3cret" };
  it("rejects a missing / malformed Authorization header", () => {
    expect(checkBasicAuth(undefined, cfg)).toBe(false);
    expect(checkBasicAuth("", cfg)).toBe(false);
    expect(checkBasicAuth("Bearer xyz", cfg)).toBe(false);
    expect(checkBasicAuth("Basic !!!not-base64", cfg)).toBe(false);
    expect(checkBasicAuth("Basic " + Buffer.from("no-colon").toString("base64"), cfg)).toBe(false);
  });
  it("rejects wrong username or wrong password", () => {
    expect(checkBasicAuth(basic("sumanth", "wrong"), cfg)).toBe(false);
    expect(checkBasicAuth(basic("nope", "s3cret"), cfg)).toBe(false);
    expect(checkBasicAuth(basic("sumanth", "s3cret "), cfg)).toBe(false); // trailing space differs
  });
  it("accepts exact matching credentials (case-insensitive scheme token)", () => {
    expect(checkBasicAuth(basic("sumanth", "s3cret"), cfg)).toBe(true);
    expect(checkBasicAuth(basic("sumanth", "s3cret").replace("Basic", "basic"), cfg)).toBe(true);
  });
  it("supports a password containing ':' (only the first colon splits user:pass)", () => {
    const c2: AuthConfig = { user: "u", pass: "a:b:c" };
    expect(checkBasicAuth(basic("u", "a:b:c"), c2)).toBe(true);
  });
  it("advertises a Basic realm in the WWW-Authenticate header", () => {
    expect(wwwAuthenticateHeader()).toMatch(/^Basic realm="TBSI Movie Lookup"/);
  });
});

describe("PWA manifest — well-formed + installable", () => {
  const m = JSON.parse(publicFile("manifest.webmanifest")) as Record<string, unknown>;
  it("has the required install fields", () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
  });
  it("uses the TBSI dark (Ink) theme + background colors", () => {
    expect(m.theme_color).toBe("#1A1614");
    expect(m.background_color).toBe("#1A1614");
  });
  it("declares 192 + 512 png icons (incl. a maskable)", () => {
    const icons = (m.icons ?? []) as Array<{ sizes?: string; type?: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === "192x192" && i.type === "image/png")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.type === "image/png")).toBe(true);
    expect(icons.some((i) => (i.purpose ?? "").includes("maskable"))).toBe(true);
  });
});

describe("Service worker — versioned cache + update flow + no API caching", () => {
  const sw = publicFile("sw.js");
  it("derives a versioned cache name from CACHE_VERSION (bumpable for deploys)", () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*["']v\d+["']/);
    expect(sw).toMatch(/const CACHE\s*=\s*["']tbsi-lookup-["']\s*\+\s*CACHE_VERSION/);
  });
  it("precaches the app shell: all 3 pages + manifest + both icons", () => {
    for (const p of ["/", "/index.html", "/movie.html", "/person.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]) {
      expect(sw.includes(`"${p}"`)).toBe(true);
    }
  });
  it("uses skipWaiting + clients.claim so a new deploy takes over immediately", () => {
    expect(sw).toMatch(/self\.skipWaiting\(\)/);
    expect(sw).toMatch(/self\.clients\.claim\(\)/);
  });
  it("purges old caches on activate (no stuck stale shell)", () => {
    expect(sw).toMatch(/caches\.delete/);
    expect(sw).toMatch(/k\s*!==\s*CACHE/);
  });
  it("never caches live /api/* responses", () => {
    expect(sw).toMatch(/pathname\.startsWith\(["']\/api\/["']\)/);
  });
});

describe("HTML pages — PWA wired on every page", () => {
  for (const page of ["index.html", "movie.html", "person.html"]) {
    it(`${page} links the manifest, theme-color, and registers the service worker`, () => {
      const html = publicFile(page);
      expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
      expect(html).toMatch(/<meta name="theme-color" content="#1A1614"/);
      expect(html).toMatch(/serviceWorker\.register\("\/sw\.js"\)/);
    });
  }
});
