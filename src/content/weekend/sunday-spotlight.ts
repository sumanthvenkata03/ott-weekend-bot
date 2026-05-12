// src/content/weekend/sunday-spotlight.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { SundaySpotlightDraft } from "../../delivery/notion.js";

interface LLMOutput {
  caption: string;
  hashtags: string[];
  reelScript: {
    hook: string;
    whyItWorks: string;
    watchNote: string;
    cta: string;
    onScreenText: string[];
    visualDirection: string;
  };
  caseAgainstSkepticism: string;
}

export async function generateSundaySpotlight(
  film: Release,
  weekendStart: string,
  weekendEnd: string
): Promise<SundaySpotlightDraft> {
  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  log.info(`Generating Sunday Spotlight: ${film.title} (${film.language})`);
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. Sunday is REGIONAL SPOTLIGHT day.

PAGE IDENTITY:
- We don't just list films. We make CASES for them.
- Sunday Spotlight is THE pillar where we champion underserved-language Indian cinema (Malayalam, Kannada, Marathi, Bengali, Punjabi) for a Pan-Indian audience that defaults to Hindi.
- Tone: confident, conversational, light Hinglish, opinionated. Like a friend who watches everything telling you what you're missing out on.

CRITICAL TONE RULES:
- Never hedge. Never "this might be interesting." Always: "this is the film. Here's why."
- Subtitle fatigue is real — acknowledge it but defeat it.
- Don't be defensive about regional cinema. Be evangelical.
- Cite specific craft elements (a shot, a structural choice, a casting decision) not generic praise.
- NEVER use AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "elevates".

TASK: Convince a non-${film.language} audience to watch this ONE film. The reel and caption must work for someone who has NEVER watched a ${film.language} film.

THE FILM:
Title: ${film.title}
Language: ${film.language}
Original title: ${film.originalTitle ?? "(same)"}
Release date: ${film.releaseDate}
Genres: ${film.genre.join(", ") || "—"}
Platform: ${film.platform.length ? film.platform.join(", ") : "TBA"}
Director: ${film.director ?? "—"}
Cast: ${film.cast.slice(0, 5).join(", ") || "—"}
Runtime: ${film.runtime ? `${film.runtime} min` : "—"}
${film.imdbRating ? `IMDb: ${film.imdbRating} (${film.imdbVotes ?? 0} votes)` : "IMDb: not yet rated"}
Synopsis: ${film.synopsis}

DELIVERABLES (respond as JSON):

{
  "caption": "Under 130 words. Make a case for ${film.language} cinema, not just this film. Open with a bold claim that breaks the language barrier. End with 'Subs are great. Excuses are over.' or similar uncompromising CTA.",
  "hashtags": ["array of 12 hashtags, heavy on regional cinema tags — #${film.language}Cinema, #IndianCinema, plus specific film tags"],
  "reelScript": {
    "hook": "0–3 sec voiceover. ONE bold claim that breaks the language barrier. e.g., 'This Malayalam thriller on Prime is better than 90% of Hindi releases this year. Here's why.'",
    "whyItWorks": "3–15 sec voiceover. THREE specific reasons. NOT generic praise. NAME craft elements — a director's style choice, a writing structure, a performance technique. Example: 'One — the structure withholds the inciting incident until the 40-minute mark, betting on character first. Two — every supporting actor reads like they walked off a real street. Three — the cinematographer treats interior light like a 1970s Italian film.'",
    "watchNote": "15–22 sec voiceover. Subtitle quality call-out, dub availability mention, who'll love it, who might struggle. Be honest about pacing or runtime.",
    "cta": "22–30 sec voiceover. Direct, no hedging. End with 'Save this.' or 'Subs are great. Excuses are over.'",
    "onScreenText": ["4 frames of bold text overlays, max 6 words each. e.g., 'PRIME VIDEO — NOW STREAMING', 'BETTER THAN BOLLYWOOD THIS YEAR', etc."],
    "visualDirection": "Shot list for the editor — what to show on screen during each beat. Use generic B-roll suggestions (Pexels-friendly): 'wide shot of city night skyline, cut to close-up of laptop with subtitles visible, ambient cafe shot, etc.' AVOID suggesting copyrighted film clips."
  },
  "caseAgainstSkepticism": "Under 200 words. Reply template for IG comments like 'I don't watch ${film.language} films.' Acknowledge the skepticism, then defeat it with one specific film comparison (a ${film.language} film that broke through to Pan-Indian audiences) and one structural argument (subs are easy now, the algorithm rewards taste, etc.)."
}

The film's language is ${film.language}. The audience you're persuading defaults to Hindi/English content. The CTA must feel like a dare, not a request.`;
  
  const output = await callClaudeJSON<LLMOutput>(prompt);
  
  return {
    pillar: "Sun Spotlight",
    weekendDates,
    film,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    reelScript: output.reelScript,
    caseAgainstSkepticism: output.caseAgainstSkepticism,
  };
}