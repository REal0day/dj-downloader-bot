import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';

const WATCHLIST_PATH = path.join(process.cwd(), 'watchlist.json');

export async function loadWatchlist() {
  try {
    return JSON.parse(await readFile(WATCHLIST_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function saveWatchlist(list) {
  await writeFile(WATCHLIST_PATH, JSON.stringify(list, null, 2));
}

export function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url))  return 'YouTube';
  if (/soundcloud\.com/.test(url))          return 'SoundCloud';
  if (/mixcloud\.com/.test(url))            return 'Mixcloud';
  if (/bandcamp\.com/.test(url))            return 'Bandcamp';
  if (/twitch\.tv/.test(url))               return 'Twitch';
  return 'Web';
}

function runYtdlpFlat(url, count) {
  return new Promise((resolve) => {
    const args = [
      url,
      '--flat-playlist',
      '--playlist-end', String(count),
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
    ];
    const proc = spawn(config.ytdlpPath, args);
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const items = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          items.push({
            id:    obj.id,
            title: obj.title ?? 'Unknown',
            url:   obj.url ?? obj.webpage_url ?? null,
          });
        } catch {}
      }
      resolve(items);
    });
  });
}

export async function addWatch(url, label) {
  const list = await loadWatchlist();

  if (list.find((e) => e.url === url)) {
    return { ok: false, reason: 'Already watching that URL.' };
  }

  const platform = detectPlatform(url);
  const items    = await runYtdlpFlat(url, 1);
  const lastSeenId     = items[0]?.id ?? null;
  const resolvedLabel  = label || items[0]?.title?.split(' - ')[0] || url;

  const entry = {
    id: Date.now().toString(),
    label: resolvedLabel,
    url,
    platform,
    lastSeenId,
    addedAt: new Date().toISOString(),
  };

  list.push(entry);
  await saveWatchlist(list);
  return { ok: true, entry };
}

export async function removeWatch(query) {
  const list = await loadWatchlist();
  const idx  = parseInt(query, 10);
  let removeIdx = -1;

  if (!Number.isNaN(idx) && idx >= 1 && idx <= list.length) {
    removeIdx = idx - 1;
  } else {
    removeIdx = list.findIndex((e) =>
      e.label.toLowerCase().includes(query.toLowerCase()) ||
      e.url.toLowerCase().includes(query.toLowerCase())
    );
  }

  if (removeIdx === -1) return null;
  const [removed] = list.splice(removeIdx, 1);
  await saveWatchlist(list);
  return removed;
}

// Returns array of { entry, newItems: [{id, title, url}] }
export async function checkAll() {
  const list    = await loadWatchlist();
  const results = [];

  for (const entry of list) {
    try {
      const items = await runYtdlpFlat(entry.url, 5);
      if (!items.length) continue;

      const newItems = [];
      for (const item of items) {
        if (item.id === entry.lastSeenId) break;
        newItems.push(item);
      }

      if (newItems.length) {
        entry.lastSeenId = items[0].id;
        results.push({ entry, newItems });
      }
    } catch {
      // skip — don't let one bad entry break the whole poll
    }
  }

  if (results.length) await saveWatchlist(list);
  return results;
}
