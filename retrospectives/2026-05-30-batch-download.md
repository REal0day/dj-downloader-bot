# Retrospective: 2026-05-30 — Batch download feature

## Commit covered
- `4217b86` Add !dlbatch command for downloading multiple tracks at once

---

## What went well

- Clarified design upfront (auto top result, genre once) before writing any code,
  which avoided a rewrite mid-implementation.
- Live status message with per-song icons (⏳ → 🔎 → ⬇️ → ✅/❌) gives the user
  clear visibility without spamming the channel.
- Reused the existing SerialQueue so batch jobs interleave safely with single !dl
  jobs — no extra concurrency logic needed.
- `.catch(() => {})` on status edits prevents a failed Discord edit (e.g. message
  deleted) from crashing the whole batch.

---

## What could be better

### 1. No Discord message length guard
Discord caps messages at 2000 characters. A large batch (20+ tracks with long
titles) could hit this and cause the status edit to silently fail or error.
Should truncate titles and add a hard cap on visible tracks, or split into
multiple messages.

### 2. Genre matching is case-sensitive-insensitive but not typo-tolerant
`toLowerCase()` comparison is fine for exact matches, but "hard techno" vs
"Hard  Techno" (double space) would fail. Could trim internal whitespace or
use fuzzy matching.

### 3. No per-song timeout
If yt-dlp hangs on one track, the entire batch stalls indefinitely. The single
`!dl` flow has the same problem, but it's more painful in a batch. Should add a
per-job timeout (e.g. 5 minutes) to the SerialQueue or download call.

---

## Rules to carry forward

1. **Clarify interaction model before implementing any Discord UI feature.**
   The auto-vs-manual and genre-once-vs-per-song questions took 30 seconds to
   ask and saved a potential full rewrite.
2. **Always guard Discord message edits with `.catch()`** — the message could
   be deleted between scheduling and execution.
3. **Check Discord's 2000-char message limit** whenever building dynamic
   content that scales with user input.
