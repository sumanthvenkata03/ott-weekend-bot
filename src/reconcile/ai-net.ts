// src/reconcile/ai-net.ts
// The AI-search net was lifted into the SHARED discovery OTT source
// (src/discovery/sources/ottSearch.ts) so discovery and reconcile run ONE
// implementation — no clone of the Tavily transport, the Claude extraction
// prompt, or the title→TMDb resolve. This file is a thin RE-EXPORT that keeps
// reconcile's import paths stable (run.ts imports runAiNet from here).
export { runAiNet, buildQueries } from "../discovery/sources/ottSearch.js";
