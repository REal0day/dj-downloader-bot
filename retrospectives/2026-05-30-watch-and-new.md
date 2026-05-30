# Retrospective: 2026-05-30 — !dlwatch and !dlnew

## Commit covered
- `ab1e5f9` Add !dlwatch and !dlnew commands for music discovery

---

## What went well

- Asking design questions before coding (URL vs name, channel vs DM, poll
  interval) took 30 seconds and prevented at least two potential rewrites.
- yt-dlp's universal platform support made the watcher trivially extend to
  YouTube, SoundCloud, Mixcloud, Bandcamp, and Twitch with zero extra code.
- !dlnew reuses the entire existing download flow (YouTube search → genre
  buttons → download + verify) by delegating after the Beatport pick. No
  duplicated download logic.
- The 1-minute startup delay before the first watch poll prevents alert
  spam on rapid bot restarts.

---

## What could be better

### 1. Beatport scraping is fragile
Parsing `__NEXT_DATA__` from a Next.js page works until Beatport changes their
structure. No tests, no fallback. If it breaks the user gets a raw error.
A more stable alternative would be the Beatport public API or Spotify's
new-releases endpoint.

### 2. watchlist.json lives in the project root (process.cwd())
If the bot is run from a different working directory, the file lands in the
wrong place. Should use `path.dirname(import.meta.url)` or a configurable path.

### 3. Watch poll fires even if bot just started and nothing changed
The 1-minute initial delay is a workaround, not a fix. A proper solution
would be to record a `lastCheckedAt` timestamp and skip the check if it's
been less than the interval since the last successful poll.

### 4. No per-platform error visibility
If one watched URL fails (e.g. SoundCloud is down), it's silently skipped.
Should log per-entry failures so the user knows something is broken.

---

## Rules to carry forward

1. **Prefer stable APIs over HTML scraping.** Beatport's __NEXT_DATA__ will
   break. Add a Spotify new-releases fallback.
2. **Store file paths relative to the module, not process.cwd().**
   Use `new URL('../file.json', import.meta.url)` for reliable paths.
3. **Log per-item errors in polling loops** — silent skips hide real problems.
