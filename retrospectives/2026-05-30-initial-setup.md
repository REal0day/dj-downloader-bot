# Retrospective: 2026-05-30 — Initial repo setup

## Commits covered
- `560b097` Initial commit: DJ Downloader Discord bot
- `832a8fa` Move config, util, ytdlp into src/ to match index.js imports

---

## What went wrong

### 1. Missed the import/file-structure mismatch before the first commit
`index.js` clearly imports from `./src/config.js`, `./src/ytdlp.js`, and
`./src/util.js`. I read every file before committing, so I had all the
information I needed to catch this — I just didn't cross-reference import
paths against the actual directory layout. The result was a broken repo on
the first push, requiring an immediate follow-up commit.

**What to do instead:** Before the initial commit of any project, verify that
every `import`/`require` path resolves to an actual file on disk.
`grep -r "from './" <entry>` + `find . -name "*.js"` takes ten seconds and
would have caught this instantly.

---

## What went well

- Scanned all files for secrets before touching git — correct order of operations.
- `.gitignore` covered `.env` and `node_modules/` before anything was staged,
  so no sensitive data ever touched the index.
- Used `git add <explicit files>` rather than `git add .` to be deliberate
  about what was committed.

---

## Rules to carry forward

1. **Cross-reference imports before first commit.** Read the entry point,
   collect every local import path, and confirm each file exists.
2. **One clean commit beats two messy ones.** A structural fix that could have
   been caught during review should not become its own commit.
