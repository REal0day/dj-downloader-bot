# Retrospective: 2026-05-30 — Beatport genre ID fix

## Commit covered
- `f61abb2` Fix Beatport Hard Techno genre ID from 147 to 2

---

## What went wrong

Guessed Beatport's Hard Techno genre ID (147) instead of verifying it.
The correct ID is 2. The user hit a 404 on first use.

**What to do instead:** Any time a hardcoded ID or URL is used for an
external service, verify it before shipping — fetch the URL in a test,
or tell the user to paste the working URL rather than providing a guess.

---

## Rules to carry forward

1. **Never guess external service IDs.** Verify them or make the user
   provide the correct URL from the start. Guessing wastes a round trip
   and erodes trust.
2. **The .env.example default should be a known-good value**, not a
   placeholder guess. If unsure, leave it blank with a comment explaining
   how to find the right value.
