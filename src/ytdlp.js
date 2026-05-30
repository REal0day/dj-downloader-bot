import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Run a yt-dlp command and collect stdout/stderr.
 * Returns { code, stdout, stderr }.
 */
function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytdlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      // e.g. yt-dlp not found on PATH
      reject(err);
    });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Search YouTube and return up to `count` results.
 * Uses a flat search dump for speed — gives id, title, duration, view_count, channel.
 */
export async function searchYouTube(query, count = 5) {
  const args = [
    `ytsearch${count}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
  ];

  const { code, stdout, stderr } = await runYtdlp(args);
  if (!stdout.trim()) {
    throw new Error(
      `yt-dlp returned no results (exit ${code}). ${stderr.slice(0, 300)}`
    );
  }

  const results = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      results.push({
        id: obj.id,
        title: obj.title || 'Unknown title',
        url: obj.url || (obj.id ? `https://www.youtube.com/watch?v=${obj.id}` : null),
        duration: obj.duration ?? null, // seconds
        viewCount: obj.view_count ?? null,
        channel: obj.channel || obj.uploader || 'Unknown channel',
      });
    } catch {
      // skip malformed lines
    }
  }

  return results.filter((r) => r.url).slice(0, count);
}

/**
 * Download a single video's audio as an MP3 into `destDir`.
 * Embeds metadata + thumbnail (cover art) so Rekordbox reads tags/artwork.
 * Returns the final absolute file path (after conversion/move).
 */
export async function downloadAudio(url, destDir) {
  const outputTemplate = `${destDir}/%(title)s.%(ext)s`;

  const args = [
    url,
    '-f', 'bestaudio/best',
    '-x', // extract audio
    '--audio-format', 'mp3',
    '--audio-quality', config.audioBitrate, // e.g. 320K
    '--embed-metadata',
    '--embed-thumbnail',
    '--add-metadata',
    '--windows-filenames', // destination is an NTFS drive via /mnt/c
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '-o', outputTemplate,
    // Print the final path AFTER conversion and move so we know what landed:
    '--print', 'after_move:filepath',
    '--no-simulate',
  ];

  const { code, stdout, stderr } = await runYtdlp(args);

  if (code !== 0) {
    throw new Error(`Download failed (exit ${code}). ${stderr.slice(0, 400)}`);
  }

  // after_move:filepath prints the final file path on its own line
  const finalPath = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();

  if (!finalPath) {
    throw new Error('Download completed but no output path was reported.');
  }

  return finalPath;
}

/** Quick check that yt-dlp is callable. */
export async function checkYtdlp() {
  try {
    const { code, stdout } = await runYtdlp(['--version']);
    return code === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}
