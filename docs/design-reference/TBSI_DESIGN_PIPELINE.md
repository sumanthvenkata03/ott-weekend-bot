# TBSI DESIGN PIPELINE — Master Spec for Automation
### @thebigscreenindex · News-to-Design system · extracted from production sessions (July 2026)

This document is the complete record of how TBSI cards, carousels, reels, and seals
are produced: the brand system, the approved final formats, the build recipes,
the editorial verification laws, and a master prompt for an autonomous agent.
Everything here shipped to a real Instagram editorial page and was approved by the editor.

---

## 1. BRAND SYSTEM (constants — never improvise)

### Canvas
| Asset | Size | Notes |
|---|---|---|
| Feed card / carousel slide | 2160×2700 (4:5) | Built at 2×, preview at 1080×1350 |
| Reel / story video | 1080×1920 (9:16) | Overlays sized for 720×1280 sources too |
| Status sticker card | 2160×3840 (9:16) | |
| Round seal | 1440×1440 master + 1080 | Transparent PNG, hollow interior |

### Palette (RGB)
- Ink `(26,22,20)` / deep ink `(15,12,10)` — dark canvas
- Cream `(244,236,220)` / ticket `(251,243,228)` / warm `(255,237,223)` — light canvas + card fills
- Oxblood `(104,45,37)` — brand structural color (pill fill, chips, rings on light)
- Maroon `(88,31,22)` — tree lines, deep accents
- Brass `(196,154,63)` — hairlines, keylines on light theme
- Gold `(242,212,138)` — text gold on dark theme
- Champagne foil ramp: `(247,231,184)→(232,197,106)→(184,137,59)→(140,100,32)` — awards/premium numerals
- Red foil ramp (light theme headlines): `(139,62,47)→(104,45,37)→(88,31,22)→(56,17,12)`
- Fire ramp (hype): `(252,224,154)→(242,184,88)→(216,92,28)→(138,28,16)` + rim `(74,14,6)` + glow `(240,120,32)`

Two-reds rule: vermillion and oxblood never compete in one lockup.

### Type (variable TTFs, set weight via `set_variation_by_axes([w])`)
- **Playfair Display** — display serif. Titles 800, numerals/foil 900. Film names in Title Case.
- **JetBrains Mono** — all labels/eyebrows/credits. Tracked (track 4–10). Weights 500–700.
- Per-character rendering with manual tracking (loop chars, advance by glyph width + track).
- Autoshrink law: every text call takes `maxw`; loop `px -= 1..2` until it fits. Nothing ever overflows.

### Logo
- Handle pill (`handle_pill_2x.png`): always top-center. Feed cards h=100 @2x, reels h=66 @720w,
  stickers h=110. On full-bleed photo grounds add soft dark blur shadow behind the pill.

---

## 2. APPROVED FINAL FORMATS (the design library)

### 2.1 "Jana Nayagan skin" — poster-led announcement (highest-reach format)
Reference: single-film announcement card. Recipe:
1. Full-bleed poster, cover-cropped **face-anchored** (see §4.2), darkened ~0.30–0.36.
2. Film grain: gaussian noise σ≈6–7 added; radial vignette ~0.2–0.3 at edges.
3. Text stack, centered: cream tracked-mono eyebrow → cream Playfair Title-Case title →
   **giant gold Playfair numeral** (the date/count — the hero element) → cream mono fact strip
   (dots `·` between facts) → cream serif sentence statement → brass hairline + mono credits footer.
4. Gold is reserved for the numeral + small accents. Body text is cream. (Editor's rule.)

### 2.2 Full-bleed quadrant register (news lists / award roundups) — FINAL approved v3
The flagship multi-item format. **Zero gutters — posters ARE the layout.**
- 2×2 quadrants of 1080×1350 each, butted edge to edge. No background visible anywhere.
- Each quadrant: poster cover-crop face-anchored → **bottom scrim** (gradient to ~0.90 black over
  bottom 40%) → **top-right corner veil** (elliptical gradient, ~0.62 at corner).
- Bottom of quadrant: **gold mono award lines only** (29px @2x, autoshrink), one line per award,
  format `CATEGORY · WINNER NAME`. No serif at bottom (it collides with posters' own title art).
- Top-right: round **×N seal** (two gold rings, `×N` Playfair 900, tiny AWARDS mono inside) —
  **only when the film won 2+**; singles get no seal. Film name in cream serif right-aligned
  under the seal (wrap ≤2 lines, autoshrink, maxw≈470).
- Films with no available art → typographic quadrant: maroon gradient `(64,22,16)→(28,10,7)` +
  grain, film name in huge cream serif, awards below.
- Overflow winners → one "Also honoured." list quadrant (same maroon ground).
- Club by FILM, not category: each quadrant = one film with ALL its wins stacked.
- Cover: mosaic of all posters (4×4 tiles 540×675, face-anchored) at ~0.30 brightness + center
  band scrim + grain; then pill, mono eyebrow, giant gold numeral, cream serif title 2 lines,
  gold fact line, cream `SWIPE FOR THE FULL LIST →`.

### 2.3 Light editorial theme (family trees, deep dives)
- Cream gradient bg `(251,243,228)→(244,236,220)`.
- Circular photo nodes: brass ring 4px + outer hairline 2px (+ oxblood third ring for the "debut" node).
- Maroon connector elbows with diamond terminals; labels get bg-colored backing rects that mask
  lines passing beneath (label-on-branch pattern).
- Relationship chips: rounded warm-fill rects, oxblood outline, mono caps (`FIRST WIFE`, `MARRIED`).
  Chips live on rails between nodes or float on side-ticks — never on label text.
- Filmography cards: warm fill, brass border, brass mono header (`KNOWN FOR` / `DIRECTED` /
  `DISTRIBUTED`), stacked film lines ≥26px @2x (28px preferred — readability floor).
- Question-hook cover pattern: poster panel (double brass keyline) → red-foil serif question →
  **ghost preview** of the inside content (actual tree render, oxblood-tinted, alpha≈0.24,
  fading to zero mid-content) → cue chip → **3D swipe button** bottom-right (sphere-shaded warm
  disc, oxblood+brass bevel rims, embossed red-foil double chevron, ghost chevron trail,
  drop shadow).

### 2.4 Round seals (status stickers) — hollow architecture
- 1440 master, fully transparent background AND interior ("hollow": no core disc).
- Ring band r 596–664 filled with a foil/fire ramp; gold hairline circles at r 560 and 694.
- Arc text top (event/hook) and bottom (`THE BIG SCREEN INDEX`), r≈470.
  **Arc law:** characters must lay left→right monotonically (assert x-positions increasing);
  bottom arc flipped. Every arc glyph gets an 8-direction dark rim `(40,24,10)` for
  legibility on any background.
- Core content: giant foil numeral (e.g. `72`, `9`) or a circular photo crop in a gold ring.
- Side diamonds at r≈410. Verify: interior sample points alpha==0, corners alpha==0.
- News-stamp variant (approved): top arc = event name, core = edition numeral,
  `WINNERS ANNOUNCED` + `FOR THE YEAR 2024` beneath. No editorial angle on the seal.

### 2.5 Status card (9:16 hype sticker)
Ink gradient + vignette → pill → mono eyebrow → tilted (−6°) rounded photo card with box
shadow → fire-ramp Playfair hook (2 lines) → gold/cream payoff couplet → gold outline cue chip →
emotive mono line → footer. Hook-writing rule: the line must work for outsiders AND insiders
("THE MEME GOT ITS ENDING.").

### 2.6 Reel wrapper (found-footage emotional edits)
- **Preserve the original video** — all additions are overlays; re-encode crf 17 veryfast only.
- Pill overlay full-duration (transparent 720×1280 PNG, pill top-center).
- Reaction-card PiP: rounded corners (r 26 @240px), **no border**, floating box shadow
  (blurred dark, offset down), positioned lower-third side. Delayed entry (e.g. at 5s), and
  content **switches on a scene-cut beat** (smile→tears at the meeting cut) — the card feels
  the video with the viewer.
- Audio law: original audio 1.0 + music bed 0.5, `amix=inputs=2:duration=first:normalize=0`.
  Bed prep: head-cut per spec (e.g. −10s), tail-fit to video duration, fade-in 0.25s,
  fade-out ~1.3s.
- Analysis before design: ffprobe; scene cuts via frame-diff (mean |Δ| > 28 on 90×160 grays);
  face count/size at sampled timestamps; whisper ASR attempt (accept failure on noisy Telugu —
  ask the editor for the beats instead of hallucinating).

---

## 3. EDITORIAL VERIFICATION LAWS (the moat — automation must enforce these)

1. **Verify before print.** Every factual claim on a card comes from a verifiable source
   (wire services, official PIB slides, the subject's own posts, major trades). Fan pages and
   screenshots are LEADS, not sources.
2. **Exact category wording.** Award/官方 names print verbatim. Case study: "Best Feature Film
   Providing Wholesome Entertainment" (wire garble) vs official "Best **Popular** Film Providing
   Wholesome Entertainment". A fan card's "Best Feature Film — Captain Miller" was actually
   "Best Film Promoting National, Social and Environmental Values". Shorthand creates
   misinformation; the register prints the real name.
3. **Recount when new data lands.** Telugu tally went 8→9 when Committee Kurrollu's Make Up win
   surfaced. Any published number gets a pinned correction if superseded.
4. **Hold the unverifiable.** Dhanush's Special Mention stayed OFF cards until the official list
   confirmed it (it turned out true — the process still was right). The Suriya×Rajamouli
   "Suriya 50" poster had zero trade backing and contradicted the reported lineup → killed, and
   the truthful alternative ("Road to 50" slate card) offered instead.
5. **Live events: wait for the official list.** During a live announcement, post only
   double-confirmed categories with an honest "ANNOUNCEMENT IN PROGRESS" chip, or wait.
6. **Faces are never guessed.** See §4.2. Every face on a card is identity-verified against
   reference images (image search) or is official poster art. Group photos: extract the correct
   person by verified position; state who's who.
7. **No tick, no tag.** Every @handle ships in a "badge-check list" for the editor's manual
   verification. Unverifiable handles print as plain names. X handles are never used on IG.
8. **Hedge or cut.** "Reportedly", "per Tamil media", trade figures marked estimates.
   If confidence is low and hedging would bury the point — cut the line.
9. **Credit found footage.** Reels of others' videos carry a source-credit line; placeholder
   blocks publishing until filled.
10. **One deliverable at a time; editor picks from options; blunt trade-off notes.**

---

## 4. BUILD & QA TECHNIQUES (PIL/ffmpeg recipes)

### 4.1 Text engine
Per-character draw with manual tracking; autoshrink to maxw; shadows on photo grounds
(offset dark ghost layer). Foil/fire fills: draw text to L-mask → vertical ramp mapped over the
mask bbox → paste ramp through mask; fire adds MaxFilter rim + gaussian glow; foil adds soft
drop shadow + top highlight.

### 4.2 Face-anchored cropping (used EVERYWHERE)
```python
faces = haar.detectMultiScale(gray, 1.06, 4, minSize=(50,50))
scale = max(tw/img.w, th/img.h); resize
face_row = min(face_center_ys) * scale        # topmost face
y0 = clip(face_row - th*face_frac, 0, H-th)   # face_frac ≈ 0.28–0.36
```
Tile law for portrait nodes: detect → crop 1.8× face → re-detect on tile →
assert center ≈ (0.50, 0.50). Group photos: sort detections by x, take the verified position
(e.g. leftmost), never "the biggest face" blindly.

### 4.3 Verification-by-metric (no human eyes needed until the editor's pass)
- **Edge check:** count brand-colored pixels in outer 26–30px bands == 0 (bounded layouts).
- **Full-bleed check:** seam lines (x=1080, y=1350) and all four edges must read image content,
  not background color.
- **Face audit:** detected faces mapped to expected node coordinates; count matches; oversized
  detections (>400px) flagged as haar scale-echoes, not people.
- **Pairwise collision assertions:** every chip/card/strip rect vs every label backing rect vs
  every node circle (circle-accurate: nearest-point-in-rect to center < radius). Overlaps == NONE
  is a shipping gate. (Born from a real shipped-overlap bug.)
- **Element presence:** per-zone pixel counts for each color system (foil px, gold ring px,
  card fill px, poster red-title px). Write the expectation into the check.
- **Seal checks:** arc monotonicity, interior/corner alpha==0, core content px.
- **Video checks:** duration exact; overlay presence via zone darkness/content diff at sampled
  t; boundary proof via frame-diff across the switch time; audio via volumedetect math
  (mix dB vs bed-only dB proves original track presence).
- Naive checks get decoded, not trusted: a "cream px" count that matches the background is a
  bad metric — replace with targeted zones.

### 4.4 Ops
- Copy uploads to local workdir immediately (upload mounts rotate).
- Ship: 2× PNGs + 1080 previews + zip; `zip -q -o` refreshes in place so filenames stay stable.
- Fonts: variable TTFs require `set_variation_by_axes` before every use.

---

## 5. WORKED CASE (sample test data): 72nd National Film Awards, July 18 2026

**Input:** fan-page screenshot claiming (1) Best Actor Special Mention — Captain Miller,
(2) Best Tamil Film — Raayan, (3) Best Feature Film — Captain Miller.

**Pipeline run:**
1. Search 1 → announcement is LIVE today; top categories confirmed (shared Best Actor:
   Mammootty + Kartik Aaryan; Best Actress Yami Gautam; Kalki wholesome-entertainment win).
   Claim (3) contradicts nothing but smells like a garble; (1),(2) unverifiable → **HOLD**.
2. Interim card (optional): only double-confirmed winners + "ANNOUNCEMENT IN PROGRESS" chip.
   Category printed in FULL; later corrected wire wording Feature→**Popular** via official slide.
3. Official PIB slides arrive (editor screenshots) + full syndicated list fetched →
   complete reconciliation: claims (1) and (2) TRUE; claim (3) = garble of
   "Best Film Promoting National, Social & Environmental Values". New finds: CK Make Up win
   (Telugu 8→9), Amaran editing, Feminichi Fathima, supporting actress shared, 5 child artists.
4. Design iterations (all real editor feedback): category-card register (rejected: small fonts,
   gaps) → full-bleed category quadrants (approved direction) → **film-clubbed quadrants** with
   ×N seals top-right + names moved off the posters' own titles + collage cover (FINAL).
5. Output package: 5-slide zip, caption (bold-unicode headline, tally lines, CTA), 30 hashtags,
   15-mention version with badge-check board, pinned-comment text, story funnel
   (hollow news seal → cover → link), corrections ledger for superseded posts.

**Other approved builds in the library:** Kimchikaram teaser reel + covers (fire/announcement
system); Ayyagaru fan-meet reel (reaction-card wrapper + meme-arc caption + status card +
hollow fire seal); SMG "Bloodlines" family-tree carousel (light theme, question-hook cover,
3D swipe button); Jana Nayagan release announcement (the skin itself).

---

## 6. MASTER PROMPT (drop into the automation agent)

```
You are the TBSI design agent for @thebigscreenindex, a Telugu/Tamil-first Indian cinema
editorial page whose brand is ACCURACY. Given a news lead (headline, screenshot, or URL):

1) VERIFY. Search wires/trades/official sources. Extract claims; confirm each independently.
   Print official names verbatim. Mark anything single-sourced. If a claim cannot be
   confirmed, HOLD it and say so. If the story is a live event, either wait for the official
   list or ship only double-confirmed items with an "in progress" chip. If the lead is false,
   output the debunk and propose the truthful adjacent story instead.
2) CHOOSE FORMAT by story shape:
   - single film/date announcement → Jana Nayagan skin
   - multi-item list (awards, rankings, slates) → full-bleed quadrant register, clubbed by
     film, ×N seals for multi-winners, collage cover
   - relationship/explainer → light-theme tree/deep-dive with question-hook cover
   - found-footage moment → reel wrapper (preserve original; overlay + audio-mix laws)
   - status push → hollow round seal (+ optional 9:16 hype card)
3) BUILD with the TBSI system: palette, Playfair+JetBrains variable fonts, per-char tracking,
   autoshrink everywhere, face-anchored crops, pill top-center, grain+vignette on photo grounds.
   Gold only for numerals/accents; cream body. Zero gutters on full-bleed formats.
4) SELF-VERIFY with metrics before presenting: edges/seams, face audits vs expected positions,
   pairwise collision assertions == NONE, element-presence pixel counts, seal alpha+arc checks,
   video duration/overlay/audio-dB proofs. Fix and re-verify until green.
5) PACKAGE: 2× assets + 1080 previews + zip; caption with unicode-bold headline, verified facts
   only, CTA question; hashtags to platform max; mentions ONLY as a badge-check list for the
   human (no tick, no tag); pinned-comment text; story funnel; corrections ledger for any
   superseded posts.
6) Never fabricate faces, quotes, figures, or wins. Hedge or cut. One deliverable per cycle;
   present options with blunt trade-offs; the human editor approves before anything posts.
```

---

*Companion files: `build_fullbleed.py` (register v1 reference), `build_register.py`
(card-grid reference), `build_nfa_carousel.py` (JN-skin multi-slide reference). The FINAL
register (v3: seals + top-right names) extends build_fullbleed with the badge/veil functions
documented in §2.2.*
