# Retrospective: 2026-05-30 — AcoustID verification + BPM + tag writing

## Commit covered
- `d41563b` Add AcoustID fingerprint verification with BPM detection and tag writing

---

## What went well

- Clarified what "high effort" meant before building — user didn't care about
  bot processing time, only about their own effort. Reframing the cost correctly
  led to building the right thing instead of a simpler but less useful version.
- All three steps (fingerprint, BPM, AcoustID lookup) run with Promise.all so
  they don't add unnecessary serial latency.
- Graceful fallbacks everywhere: if fpcalc/aubio aren't installed, or AcoustID
  returns nothing, the download still succeeds and reports what it can.
- Used createRequire for node-id3 (CJS module) in an ESM project — correct
  pattern, avoids the "require is not defined" ESM pitfall.

---

## What could be better

### 1. Package name confusion cost a round trip
`libchromaprint-utils` doesn't exist on this Ubuntu version — it's
`libchromaprint-tools`. Should have checked `apt-cache search chromaprint`
first instead of guessing the package name.

**Rule:** Before telling a user to `apt install <package>`, verify the name
with `apt-cache search <keyword>` or check the distro's package search.

### 2. aubio output format not tested before implementation
Wrote the BPM parser based on documented behavior without having a real MP3
to test against. The regex `/(\d+\.?\d*)\s*bpm/gi` is robust but untested
until the user actually runs the bot.

### 3. No confidence threshold communicated to the user
The 50% threshold for writing tags and 80% for showing ✅ vs ⚠️ were chosen
arbitrarily. User wasn't told what these mean or how to adjust them.
Should expose them as .env config values.

---

## Rules to carry forward

1. **Verify apt package names before instructing the user.** Use
   `apt-cache search` — never guess.
2. **Test parsers against real output before shipping.** If no test file is
   available, at minimum log the raw output on first run so bugs are obvious.
3. **Make magic numbers configurable.** Confidence thresholds belong in .env,
   not hardcoded.
