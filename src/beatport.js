import { spawn } from 'node:child_process';
import { config } from './config.js';

function formatSecs(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Run yt-dlp --flat-playlist with optional extra args (e.g. cookie flags).
function runYtdlpFlat(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [url, '--flat-playlist', '--dump-json', '--no-warnings', '--ignore-errors', ...extraArgs];
    const proc = spawn(config.ytdlpPath, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const items = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const title = obj.title ?? 'Unknown';
          items.push({
            displayTitle: title,
            searchQuery:  title,
            duration: obj.duration ? formatSecs(obj.duration) : null,
          });
        } catch {}
      }
      resolve({ items, code, stderr });
    });
  });
}

// Fetch tracks from a Beatport chart URL.
// Tries Chrome cookies automatically (yt-dlp reads Windows Chrome from WSL),
// then falls back to a cookies.txt file if BEATPORT_COOKIES_FILE is set.
export async function fetchChartTracks(chartUrl) {
  // Attempt 1: borrow cookies from Chrome (user must be logged into Beatport there)
  const { items: chromeItems } = await runYtdlpFlat(chartUrl, ['--cookies-from-browser', 'chrome']);
  if (chromeItems.length) return chromeItems;

  // Attempt 2: explicit cookies file
  if (config.beatportCookiesFile) {
    const { items: cookieItems } = await runYtdlpFlat(chartUrl, ['--cookies', config.beatportCookiesFile]);
    if (cookieItems.length) return cookieItems;
  }

  throw new Error(
    'Beatport chart requires a login.\n\n' +
    '**Fix — one-time setup:**\n' +
    '1. Log into beatport.com in Chrome\n' +
    '2. Install the "Get cookies.txt LOCALLY" Chrome extension\n' +
    '3. On any Beatport page, click the extension → Export\n' +
    '4. Save the file as `cookies.txt` in your bot folder (`~/git/dj-downloader-bot/`)\n' +
    '5. Add `BEATPORT_COOKIES_FILE=cookies.txt` to your `.env`\n' +
    '6. Restart the bot and try again'
  );
}

// Fetch new releases via yt-dlp with the same cookie strategy.
export async function fetchNewReleases(tracksUrl) {
  const { items: chromeItems } = await runYtdlpFlat(tracksUrl, ['--cookies-from-browser', 'chrome']);
  if (chromeItems.length) return chromeItems.slice(0, 10);

  if (config.beatportCookiesFile) {
    const { items: cookieItems } = await runYtdlpFlat(tracksUrl, ['--cookies', config.beatportCookiesFile]);
    if (cookieItems.length) return cookieItems.slice(0, 10);
  }

  throw new Error('yt-dlp returned no tracks. Try setting up Beatport cookies (see !dlchart for instructions).');
}
