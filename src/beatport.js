import { spawn } from 'node:child_process';
import { config } from './config.js';

// Use yt-dlp to pull a flat playlist from any Beatport URL.
// Returns array of { title, searchQuery } — title is what yt-dlp gives us,
// searchQuery strips the Beatport label suffix for a cleaner YouTube hit.
export async function fetchChartTracks(chartUrl) {
  const items = await runYtdlpFlat(chartUrl);
  if (!items.length) throw new Error('yt-dlp returned no tracks. The chart URL may require a Beatport login.');
  return items;
}

function runYtdlpFlat(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytdlpPath, [
      url,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
    ]);

    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (!stdout.trim() && code !== 0) {
        return reject(new Error(`yt-dlp exited ${code} with no output`));
      }
      const items = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const title = obj.title ?? 'Unknown';
          items.push({
            title,
            // yt-dlp Beatport titles are "Artist - Track (Mix)" — use as-is for YouTube
            searchQuery: title,
            duration: obj.duration ? formatSecs(obj.duration) : null,
            url: obj.url ?? obj.webpage_url ?? null,
          });
        } catch {}
      }
      resolve(items);
    });
  });
}

function formatSecs(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// New releases via yt-dlp too — avoids Cloudflare on the /tracks page.
export async function fetchNewReleases(tracksUrl) {
  const items = await runYtdlpFlat(tracksUrl);
  if (!items.length) throw new Error('yt-dlp returned no tracks from that Beatport URL.');
  return items.slice(0, 10);
}
