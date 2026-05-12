# The Big Screen Index — Design System v1.0

A complete brand and visual system for an Indo-modern editorial Indian OTT + film Instagram page. Locked May 12, 2026.

---

## Brand identity

**Name:** The Big Screen Index
**Handle (target):** `@thebigscreenindex`
**Tagline:** *"The film paper of record."*
**Position:** A film periodical, not a fan page. Every post is a numbered Issue (Vol. 01 / Issue №042).
**Voice:** Decisive, opinionated, conversational. Light Hinglish where natural. Never hedges.
**Visual register:** Indo-modern editorial — Raja Ravi Varma + 1970s Bollywood matchbox + Filmfare 1972 + Indian Express 1985, contemporary execution.

---

## Color palette

The system uses 5 named colors. Every element on every post pulls from this palette only.

| Token | Hex | Role |
|---|---|---|
| **Ink Black** | `#1A1614` | Primary text, dark backgrounds, masthead bars, brand stamp |
| **Paper Cream** | `#F4ECDC` | Primary light background — the "paper" the system prints on |
| **Vermillion** | `#A33223` | Brand accent · verdict stamps · poster frames · "MUST WATCH" red |
| **Brass Gold** | `#C49A3F` | Editorial highlights · ticket-stub body · gold rules · "WORTH A TRY" tags |
| **Bottle Green** | `#2E5742` | Sunday Spotlight accent · regional film highlights · subtle elegance |

### Color usage rules

- **Two colors maximum** per visual element. Ink Black + Paper Cream is the foundation. Add ONE accent (vermillion, gold, or green) for emphasis.
- **Vermillion is the signature.** It appears on every post in some form — even if just on the masthead rule. It's what makes a TBSI post recognizable.
- **Bottle Green is for Sunday only.** Reserves it as Spotlight pillar's identity.
- **Never mix gold + vermillion on the same element.** Use them as alternatives, not partners.
- **Never use pure black (#000) or pure white (#FFF).** Always Ink Black `#1A1614` and Paper Cream `#F4ECDC` — pure values feel digital, the off-shades feel like print.

### Dark variants (for Theatrical mode posts)

When the post is dark-background (full-bleed portraits), invert the relationship:

| Light theme | Dark theme |
|---|---|
| Paper Cream bg + Ink Black text | Ink Black bg + Paper Cream text |
| Vermillion accent | Brass Gold accent |
| Gold rules | Gold rules (unchanged) |

---

## Typography

Three typefaces, all free Google Fonts. Each has one role and never crosses lanes.

### Display — Playfair Display

```html
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;0,800;1,400;1,700&display=swap" rel="stylesheet">
```

Used for: headlines, masthead, verdict marks, big numbers, film titles. Weight range: 400 (italic byline) to 800 (display headlines).

### Body — Inter

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Used for: captions, metadata, hashtags, platform names, UI labels. Weight range: 400 (body) to 700 (emphasis).

### Mono — JetBrains Mono

```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

Used for: issue numbers, dates, timecodes, runtime, all numerical metadata. Weight range: 400-500.

### Type hierarchy (at 1080×1350 Instagram post)

| Element | Font | Weight | Size | Color |
|---|---|---|---|---|
| Big headline (e.g., "8 films.") | Playfair | 700 | 84px | Ink Black |
| Verdict callout (e.g., "Aakhri Sawal") | Playfair | 700 | 64px | Ink Black or Paper Cream |
| Body italic ("Your weekend, sorted.") | Playfair italic | 400 | 48px | Vermillion |
| Section label ("★ THE VERDICT ★") | Playfair | 500 | 26px | Vermillion / Gold |
| Cast/director lines | Inter | 700 | 32px | Ink Black |
| Body metadata | Inter | 500 | 26px | Ink Black |
| Issue number | JetBrains Mono | 700 | 26px | Ink Black |
| Date | JetBrains Mono | 400 | 22px | Ink Black |

### Type rules

- **Letter-spacing on display:** 0 to -0.5 (tighter for big headlines, normal for verdicts)
- **Letter-spacing on labels:** 2-6 (generous, like an old book cover)
- **Italic for emphasis only,** never decorative
- **All-caps reserved for masthead labels and verdict stamps** — never on body copy
- **No font weights below 400.** Light weights disappear on Instagram compression.

---

## Aspect ratios

Three formats, picked per use case:

| Format | Pixels | Used for |
|---|---|---|
| **4:5 portrait** | 1080 × 1350 | All pillar cover slides (max feed real estate) |
| **1:1 square** | 1080 × 1080 | Body slides, swipe content, verdict cards |
| **9:16 vertical** | 1080 × 1920 | Stories, Reel covers |

### The grid safe zone

The 1:1 center crop appears in your profile grid. ALL critical content (headline, stamp, face, key metadata) must live inside the central 1080×1080 area of any 4:5 post. The top and bottom 135px are trim margins — decorative chrome only (perforations, brand strips, "swipe → more").

---

## The three image modes

Each post belongs to one of three modes. Picked per pillar based on content needs.

### Mode 1 · Ticket Stub

**Layout:** Brass-gold ticket body with perforation line. Poster image in vermillion-framed window on left third. Type metadata on right.

**Image source:** Real TMDb poster cropped to vertical 2:3 aspect.

**Pillar use:** Sat Verdict cards (one ticket per film in the carousel).

**Why it works:** Retro physical-object cue that triggers nostalgia + functional layout that conveys verdict + film + platform in 2 seconds.

### Mode 2 · Theatrical

**Layout:** Full-bleed image fills entire canvas. Dark gradient overlay covers bottom 40%. Type block lives on the gradient. Corner stamp with issue number tilted at -8°.

**Image source:** AI-generated atmospheric portrait via Replicate Flux (~$0.003/image). Style prompt: "moody Indian cinematography, warm grain, single subject portrait, 35mm film aesthetic."

**Pillar use:** Sun Spotlight covers, Thu Compare covers (face vs face), Sat Verdict cover (carousel slide 1).

**Why it works:** Face fills 90% of the post — strongest scroll-stop in your system. Editorial cover register.

### Mode 3 · Newspaper Grid

**Layout:** Paper Cream canvas with newspaper-rule top and bottom. Big serif headline. 2×2 or 4-wide poster grid with vermillion frames. Real platform stamps inset on each poster corner.

**Image source:** 4-8 real TMDb posters tiled.

**Pillar use:** Wed Drop cover, Mon Movement cover.

**Why it works:** Pure information design. "At a glance, here's the week."

---

## Per-pillar specification

### 🎬 Wednesday Drop · "The Pulse"

- **Cover format:** 4:5 portrait, Mode 3 · Newspaper Grid
- **Body slides:** 1:1 squares, Mode 1 · Ticket Stub (one per film, 8 total)
- **Headline:** "8 films. 5 languages. Your weekend, sorted."
- **Color accent:** Vermillion italic on the closing line
- **LLM model:** Sonnet 4.6 (curation work)

### ⚔️ Thursday Compare · "The Face-Off"

- **Cover format:** 4:5 portrait, Mode 2 · Theatrical (split screen — left half film A, right half film B)
- **Body slides:** 1:1 squares with side-by-side metadata
- **Headline:** "X vs Y. Pick your Friday."
- **Color accent:** Vermillion on the deciding-line verdict
- **LLM model:** Opus 4.7 (editorial work)

### ⚖️ Saturday Verdict · "The Ruling"

- **Cover format:** 4:5 portrait, Mode 2 · Theatrical (hero portrait of the Must Watch film)
- **Body slides:** 1:1 squares, Mode 1 · Ticket Stub (one per verdict, with overlay stamp: MUST WATCH / WORTH A TRY / SKIP)
- **Headline:** "X films. Here's the call."
- **Color accent:** Vermillion stamps for MUST WATCH and SKIP. Brass Gold for WORTH A TRY.
- **LLM model:** Opus 4.7 (verdicts + hot take)

### 🎞 Sunday Spotlight · "The Champion"

- **Cover format:** 4:5 portrait, Mode 2 · Theatrical (single hero AI portrait)
- **Body slides:** 1:1 squares — reasons-to-watch + reply template + craft details
- **Headline:** Single film title in 84px Playfair display
- **Color accent:** Bottle Green for SPOTLIGHT stamp (Sunday-exclusive)
- **LLM model:** Opus 4.7 (championing work)

### 📰 Monday Movement · "On Record"

- **Cover format:** 4:5 portrait, Mode 3 · Newspaper Grid
- **Body slides:** 1:1 squares — arrivals grid, gem-of-the-week card, week headline
- **Headline:** Pattern-recognition claim about the week (e.g., "Telugu OTT is eating the action-thriller lane")
- **Color accent:** Brass Gold NEW ARRIVAL stamps
- **LLM model:** Sonnet 4.6 (summary work)

---

## Platform logo system

18 verified logo SVGs in `/platform-logos/`. The bot maps the `platform[]` field from each Release object to one or more SVG filenames at render time.

### Display rules

- **Logo size:** 64-80px width on a 1080-wide canvas (≈ 6-7% of post width)
- **Background:** Ink Black tile with 1.5px Brass Gold border (gives consistency across logos with different aspect ratios)
- **Multiple platforms:** Stack horizontally with 8px gaps. Cap at 3 visible; add "+2" overflow if more.
- **Position:** Bottom-right of body slides, integrated into ticket stub layout for Sat Verdict
- **Never resize a logo to fill the tile.** Always fit-with-margin so the brand color and shape stay recognizable.

### Platform name → filename mapping

The bot reads platforms from TMDb. TMDb's strings don't always match our filenames. This mapping handles all known variants:

```
Netflix                       → netflix.svg
Amazon Prime Video / Prime    → prime-video.svg
Disney+ / Disney Plus         → disney-plus.svg
Hulu                          → hulu.svg
Max / HBO Max                 → max.svg
Apple TV+ / Apple TV Plus     → apple-tv-plus.svg
Peacock                       → peacock.svg
Paramount+ / Paramount Plus   → paramount-plus.svg
YouTube TV                    → youtube-tv.svg
ESPN+                         → espn-plus.svg
Crunchyroll                   → crunchyroll.svg
Discovery+ / discovery+       → discovery-plus.svg
JioHotstar / Disney+ Hotstar  → jiohotstar.svg
SonyLIV / Sony LIV            → sony-liv.svg
ZEE5                          → zee5.svg
aha / Aha                     → aha.svg
Sun NXT                       → sun-nxt.svg
ETV Win                       → etv-win.svg
THEATRES / In Cinemas         → (fallback: render text-only with vermillion fill)
```

---

## File structure (for the bot's rendering pipeline)

```
ott-weekend-bot/
└── src/
    └── assets/
        ├── brand/
        │   ├── wordmark.svg
        │   ├── wordmark-compact.svg
        │   ├── stamp-seal.svg
        │   ├── stamp-must-watch.svg
        │   ├── stamp-worth-a-try.svg
        │   ├── stamp-skip.svg
        │   ├── stamp-spotlight.svg
        │   └── stamp-new-arrival.svg
        ├── platform-logos/
        │   └── (18 SVG files)
        └── design-system.md  ← this file
```

---

## What goes where, per element

A practical cheat sheet for the rendering templates.

### The masthead (top of every Mode 3 post)

```
★ VOL. 01 · ISSUE 042 · WED DROP                 13·05·26
═══════════════════════════════════════════════════════════
═══════════════════════════════════════════════════════════
```

- Section label: Playfair 500, 22px, Ink Black, letter-spacing 2.5px
- Date (right): JetBrains Mono 400, 22px, Ink Black
- Double rule: 2 horizontal lines, 2px and 0.4px, 4px apart

### The brand stamp (top of Mode 2 covers)

A small circular seal version of `stamp-seal.svg` at 80×80px, top-right corner, slightly tilted (-8°), inside the safe zone.

### Per-card verdict stamps

The 5 verdict overlay SVGs (`stamp-must-watch.svg` etc) sit at -6° rotation on the bottom-right of ticket stub cards. ~60% of the card width.

### Footer mark (bottom of every post)

```
═══════════════════════════════════════════════════════════
★ THE BIG SCREEN INDEX · MUMBAI · ON RECORD ★
═══════════════════════════════════════════════════════════
```

- Centered, Playfair 500, 18px, Ink Black, letter-spacing 4px
- Lives in the trim margin (gets cropped in grid view — that's fine)

---

## Production rules

1. **No emoji on posts.** Brand stays editorial. ★ ✦ → are allowed as typographic ornaments. 🎬 🔥 ⭐ etc are forbidden.
2. **No drop shadows.** Flat colors only. Print-mimicking system.
3. **No gradients except the Mode 2 dark overlay** (the only sanctioned gradient: linear, bottom 40% of post, Ink Black at 0% → 65% opacity).
4. **No 3D effects, no glows, no neon.** This is paper, not glass.
5. **Posters always get a 2.5px vermillion frame.** Universal rule across all modes.
6. **Numbers always in JetBrains Mono.** Dates, runtimes, issue numbers, IMDb ratings — every numeric value.
7. **The vermillion stamp tilt is always -6° (verdicts) or -8° (corner marks).** Consistent angle = "stamped by the same hand" feel.

---

## Next-step build plan

1. **Puppeteer rendering pipeline** — HTML templates per pillar that consume the bot's existing `Release` type, embed the right logos, render to 1080×1350 / 1080×1080 / 1080×1920 PNG
2. **Replicate Flux integration** — Sun Spotlight + Sat Verdict covers call Flux Schnell to generate the hero portrait (~$0.003/image, ~$3/month total)
3. **Output to /assets/posts/** — drafts get linked from Notion + Slack so review-and-post flow is unchanged
4. **9-post grid simulator** — a tool that previews how the next 9 generated posts will look as an Instagram profile grid

End of design system v1.0.
