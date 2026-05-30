# Retrospective: 2026-05-30 — Button row overflow fix

## Commit covered
- `5baa86c` Fix: split cancel button into its own row to stay within Discord's 5-button limit

---

## What went wrong

### 1. Discord's 5-button-per-row limit was not accounted for at write time
`buildTrackRow` put `SEARCH_RESULTS` (up to 5) numbered buttons plus a cancel
button in a single ActionRow — up to 6 components. Discord's API hard-caps
an ActionRow at 5 components and returns a 400 immediately.

This was a knowable constraint: the discord.js docs and Discord API docs both
state the limit. It should have been caught during initial authoring, not at
first real use.

**What to do instead:** When building any Discord UI component, verify the
component limits (buttons per row: 5, rows per message: 5) against the maximum
realistic input. Here: `max(SEARCH_RESULTS) + 1 cancel = 6 > 5` — the overflow
is obvious if you check.

### 2. The bug only surfaced at runtime, not during any pre-push check
There are no tests. A simple static check — "does the max button count exceed
5?" — would have caught this before the user ever ran the bot.

---

## What went well

- Error message was clear (`BASE_TYPE_BAD_LENGTH`, component index 0) and
  pointed straight to the cause.
- Fix was minimal and correct: one extra row for cancel, call site updated to
  spread the array rather than wrap it.

---

## Rules to carry forward

1. **Check Discord API component limits before writing UI code.** ActionRow:
   max 5 components. Message: max 5 rows. Button label: max 80 chars.
   Custom ID: max 100 chars.
2. **Trace the max-case path through any dynamic component builder.**
   If count is at its ceiling, does the result stay within API limits?
