// src/content/weekend/_shared.ts
// Tiny helpers shared across pillar content generators. Keep this thin —
// pillar-specific logic stays in each pillar's file.

import type { Release } from "../../shared/types.js";

/**
 * Phase 5.5 — LLM prompt block giving the model a baseline list of notable
 * Indian film composers + the rule for setting isMusicDirectorNotable.
 *
 * Used by all 4 pillar generators so the notability judgment is consistent.
 * Setting "true" is meant to be the exception — only when a composer's name
 * is a genuine watch-decision factor for an OTT-savvy viewer.
 */
export function notableComposersBlock(): string {
  return `
NOTABLE INDIAN FILM COMPOSERS (reference list — not exhaustive):
- Hindi: A.R. Rahman, Pritam, Shankar-Ehsaan-Loy, Amit Trivedi, Vishal-Shekhar, Sachin-Jigar, Sneha Khanwalkar
- Tamil: A.R. Rahman, Ilaiyaraaja, Anirudh Ravichander, Yuvan Shankar Raja, Santhosh Narayanan, G.V. Prakash Kumar, Harris Jayaraj, Sam C.S.
- Telugu: Devi Sri Prasad, Thaman S., M.M. Keeravani, Anirudh Ravichander, Hesham Abdul Wahab, Vivek Sagar
- Malayalam: Sushin Shyam, Justin Varghese, Jakes Bejoy, Rex Vijayan, Bijibal, Gopi Sundar, Rahul Raj
- Kannada: Ajaneesh Loknath, Charan Raj, V. Harikrishna
- Bengali: Anupam Roy, Shantanu Moitra
- Marathi: Ajay-Atul

For each film, the music director name is given in the input data (or "—" if
unknown). Set isMusicDirectorNotable=true ONLY when the composer is genuinely
well-known in their language industry — someone whose name an OTT-savvy viewer
would recognize and find meaningful as a watch-decision factor. Use the list
above as a baseline; also use your judgment for composers not listed who have
built strong reputations (e.g., a Sushin Shyam first score in two years is
notable; an indie film by an unknown is not).

Default to false. Setting true is the exception, not the rule.`.trim();
}

/**
 * Phase 5.5 — render the music-director + lead-cast lines into a prompt block
 * that the LLM sees per film. Skips missing fields cleanly.
 */
export function enrichmentBlock(r: Release): string {
  const lines: string[] = [];
  if (r.leadCast && r.leadCast.length > 0) {
    lines.push(`  Lead cast (top-billed): ${r.leadCast.join(", ")}`);
  }
  if (r.musicDirector) {
    lines.push(`  Music director: ${r.musicDirector}`);
  }
  return lines.length > 0 ? lines.join("\n") : "";
}
