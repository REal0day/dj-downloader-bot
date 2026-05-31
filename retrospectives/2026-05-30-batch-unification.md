# Retrospective: 2026-05-30 — Batch download unification

## Commit covered
- `2a01c5f` Unify batch download logic across !dlbatch, !dlplaylist, !dlchart

---

## What went wrong

The download loop was written three separate times across handleBatch,
handlePlaylist, and handleChart. Each had slightly different error handling,
status update logic, and edge cases — making bugs in one not get fixed in
the others. This was pointed out by the user when the playlist download
failed in a way the batch download didn't.

**Rule:** Any logic written twice should have been a shared function from
the start. The moment handleChart was added with the same loop as handleBatch,
it should have been extracted.

---

## What went well

- Extracting to queueBatchDownload + selectGenreViaButtons reduced index.js
  by ~100 lines while making all three commands more consistent.
- The searchWithFallback (try full query, fall back to title-only) fixes
  the "no results" failure for tracks with long artist names or special
  characters that confuse YouTube's ytsearch.
- Making genre optional in !dlbatch (show buttons if omitted) is strictly
  better UX — the old requirement to know exact genre spelling upfront
  was friction with no benefit.

---

## Rules to carry forward

1. **Extract shared logic before writing it a second time.** The download
   loop pattern was obvious from the first batch command — it should have
   been a helper from the start.
2. **Always add a fallback for external searches.** yt-dlp's ytsearch can
   return empty for valid queries — any search should have a simpler
   fallback query.
3. **User friction (required parameters, exact spelling) should always have
   a button/picker alternative.** If the user can type it wrong, offer buttons.
