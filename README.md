# DJ Downloader Bot

A personal Discord bot that searches YouTube from a chat command, shows you the
top results (title, views, duration, channel), lets you pick one with a button,
downloads it as a 320 kbps MP3, and drops it into a folder Rekordbox watches.

Built to run in **WSL2 (Ubuntu)** on Windows while **Rekordbox runs on Windows**.

```
You type:  !dl rammstein sonne hard techno remix
Bot shows: 1. Sonne (Hard Techno Remix)  3:42 · 1.2M views · SomeChannel
           2. ...
You click: [1]  →  [Hard Techno]
Bot:       ✅ Sonne (Hard Techno Remix).mp3 → Hard Techno (320K MP3)
```

---

## 1. Prerequisites (inside WSL2 / Ubuntu)

```bash
# Node.js 18+ (check with: node -v)
# ffmpeg — required for MP3 conversion + cover art
sudo apt update && sudo apt install -y ffmpeg

# yt-dlp — grab the latest build (the apt version is usually stale)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

> Keep yt-dlp updated (`yt-dlp -U`). YouTube changes break old versions often.

---

## 2. Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Add Bot** → copy the **Token**.
3. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**.
4. **OAuth2 → URL Generator**: scopes `bot`, permissions
   *Send Messages*, *Read Message History*, *Embed Links*. Open the generated
   URL to invite the bot to your server.
5. Get **your own** user ID: enable Developer Mode in Discord
   (Settings → Advanced), right-click your name → Copy User ID.

---

## 3. Configure

```bash
cd dj-downloader
npm install
cp .env.example .env
```

Edit `.env`:

- `DISCORD_TOKEN` — the bot token from step 2.
- `ALLOWED_USER_ID` — your user ID (locks the bot to just you).
- `OUTPUT_DIR` — the **Rekordbox watch folder**, as a WSL path into Windows.
  Example for a Windows user named `Chris`:
  ```
  OUTPUT_DIR=/mnt/c/Users/Chris/Music/DJ-Downloads
  ```
- `GENRES` — the subfolder buttons you want (created automatically).

---

## 4. Point Rekordbox at the same folder

In Rekordbox: **Preferences → Advanced → Database → Watch Folders** (naming
varies slightly by version; some builds call it "Auto-import" under the
Collection sidebar). Add the **Windows** equivalent of your `OUTPUT_DIR`, e.g.:

```
C:\Users\Chris\Music\DJ-Downloads
```

Rekordbox will import + analyze new files (BPM, key, waveform) as they appear.
The bot embeds metadata and cover art, so tags and artwork come through.

> WSL writes to `/mnt/c/Users/Chris/...`; Rekordbox reads `C:\Users\Chris\...`.
> Same folder, two ways of naming it.

---

## 5. Run

```bash
npm start
```

You should see the bot log in, report the yt-dlp version, and start listening.
In your server: `!dl <song name>`.

To keep it running 24/7, use `pm2`:

```bash
npm install -g pm2
pm2 start index.js --name dj-bot
pm2 save
```

---

## How it works

- `src/ytdlp.js` — spawns `yt-dlp` for a flat search (fast, returns view counts)
  and for the download (`-x --audio-format mp3 --audio-quality 320K
  --embed-metadata --embed-thumbnail --windows-filenames`).
- `index.js` — Discord layer: search → numbered buttons → genre buttons →
  queued download. Only the user who issued the command can press the buttons.
- `src/util.js` — a serial queue so two requests never download at once.

## Notes & limits

- **One download at a time** by design (the queue). Multiple requests stack up
  and report their queue position.
- YouTube audio is typically AAC ~128–256 kbps; transcoding to 320 MP3 gives you
  a standard-format file, not extra fidelity beyond the source.
- YouTube titles are messy. The bot embeds whatever metadata yt-dlp extracts;
  you may still want to tidy Artist/Title tags in Rekordbox for clean browsing.
- If search suddenly returns nothing, run `yt-dlp -U` — YouTube changed something.
- Buttons time out after 60 seconds of no response.
```
