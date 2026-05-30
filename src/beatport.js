import { spawn } from 'node:child_process';
import { config } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Extract the numeric chart ID from a Beatport chart URL.
function extractChartId(url) {
  const m = url.match(/\/(\d+)\/?(?:\?.*)?$/);
  if (!m) throw new Error('Could not extract chart ID from URL. Expected: beatport.com/chart/slug/ID');
  return m[1];
}

function formatSecs(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function normaliseApiTracks(results) {
  return results.map((t) => {
    const artists = (t.artists ?? []).map((a) => a.name).join(', ');
    const mix     = t.mix_name ? ` (${t.mix_name})` : '';
    const title   = `${t.name}${mix}`;
    return {
      displayTitle: `${artists} — ${title}`,
      searchQuery:  `${artists} - ${t.name}${mix}`,
      duration: t.duration?.minutes != null
        ? `${t.duration.minutes}:${String(t.duration.seconds ?? 0).padStart(2, '0')}`
        : (t.length_ms ? formatSecs(t.length_ms / 1000) : null),
    };
  });
}

// Fetch tracks from a Beatport chart URL via the v4 API.
export async function fetchChartTracks(chartUrl) {
  const id     = extractChartId(chartUrl);
  const apiUrl = `https://api.beatport.com/v4/catalog/charts/${id}/tracks/?per_page=100`;

  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Accept':     'application/json',
      'Origin':     'https://www.beatport.com',
      'Referer':    chartUrl,
    },
  });

  if (!res.ok) throw new Error(`Beatport API returned HTTP ${res.status}. The chart may require a Beatport login.`);

  const data    = await res.json();
  const results = data.results ?? data.tracks ?? [];
  if (!results.length) throw new Error('Beatport API returned an empty track list.');

  return normaliseApiTracks(results);
}

// Fetch new releases via yt-dlp (handles Cloudflare on genre pages).
export async function fetchNewReleases(tracksUrl) {
  const items = await runYtdlpFlat(tracksUrl);
  if (!items.length) throw new Error('yt-dlp returned no tracks from that Beatport URL.');
  return items.slice(0, 10);
}

function runYtdlpFlat(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytdlpPath, [
      url, '--flat-playlist', '--dump-json', '--no-warnings', '--ignore-errors',
    ]);
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (!stdout.trim() && code !== 0) return reject(new Error(`yt-dlp exited ${code} with no output`));
      const items = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const title = obj.title ?? 'Unknown';
          items.push({ displayTitle: title, searchQuery: title, duration: obj.duration ? formatSecs(obj.duration) : null });
        } catch {}
      }
      resolve(items);
    });
  });
}
