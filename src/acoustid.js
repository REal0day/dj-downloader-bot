import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { config } from './config.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const NodeID3 = require('node-id3');

async function fingerprint(filePath) {
  const { stdout } = await exec('fpcalc', ['-json', filePath]);
  return JSON.parse(stdout); // { duration, fingerprint }
}

export async function detectBpm(filePath) {
  try {
    const { stdout } = await exec('aubio', ['tempo', filePath]);
    // aubio tempo outputs beat timestamps then a final "X.XX bpm" line
    const match = stdout.match(/(\d+\.?\d*)\s*bpm/gi);
    if (!match) return null;
    const last = parseFloat(match[match.length - 1]);
    return last >= 40 && last <= 300 ? Math.round(last) : null;
  } catch {
    return null;
  }
}

export async function identify(filePath) {
  if (!config.acoustidKey) return null;

  let fp;
  try {
    fp = await fingerprint(filePath);
  } catch {
    return null; // fpcalc not found or failed
  }

  const params = new URLSearchParams({
    client: config.acoustidKey,
    fingerprint: fp.fingerprint,
    duration: String(Math.round(fp.duration)),
    meta: 'recordings+releasegroups',
  });

  let data;
  try {
    const res = await fetch(`https://api.acoustid.org/v2/lookup?${params}`);
    data = await res.json();
  } catch {
    return null;
  }

  if (data.status !== 'ok' || !data.results?.length) return null;

  const top = data.results[0];
  if (!top.recordings?.length) return { score: top.score, artist: null, title: null, year: null };

  const rec = top.recordings[0];
  return {
    score: top.score,
    title: rec.title ?? null,
    artist: rec.artists?.map((a) => a.name).join(', ') ?? null,
    year: rec.releasegroups?.[0]?.['first-release-date']?.slice(0, 4) ?? null,
  };
}

// Returns true if the file has already been through the verification pipeline.
export function isVerified(filePath) {
  try {
    const tags = NodeID3.read(filePath);
    return tags.userDefinedText?.some((t) => t.description === 'ACOUSTID_SCORE') ?? false;
  } catch {
    return false;
  }
}

// Returns the stored ACOUSTID_SCORE (0-100), or null if not yet processed.
export function readScore(filePath) {
  try {
    const tags = NodeID3.read(filePath);
    const entry = tags.userDefinedText?.find((t) => t.description === 'ACOUSTID_SCORE');
    if (!entry) return null;
    const n = parseInt(entry.value, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export function writeTags(filePath, match, bpm) {
  const score = match?.score ?? 0;
  const tags = {};

  // Only overwrite music metadata if confident enough
  if (score >= 0.5) {
    if (match.artist) tags.artist = match.artist;
    if (match.title)  tags.title  = match.title;
    if (match.year)   tags.year   = match.year;
  }
  if (bpm) tags.bpm = String(bpm);

  // Always stamp the score so !dlscan knows this file was processed
  tags.userDefinedText = [
    { description: 'ACOUSTID_SCORE', value: String(Math.round(score * 100)) },
  ];

  NodeID3.update(tags, filePath);
}

export function formatVerification(match, bpm) {
  const bpmStr = bpm ? `🎵 ${bpm} BPM` : null;

  if (!match) {
    return bpmStr ? bpmStr : '🔍 Fingerprint unavailable';
  }

  const pct = Math.round(match.score * 100);
  const icon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '❌';
  const parts = [
    match.artist ? `🎤 ${match.artist}` : null,
    match.year   ? `📅 ${match.year}`   : null,
    bpmStr,
    `${icon} ${pct}% match`,
  ].filter(Boolean);

  return parts.join(' · ');
}
