import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const TOKENS_PATH    = path.join(process.cwd(), 'spotify_tokens.json');
const REDIRECT_URI   = 'https://localhost:8888/callback';
const SCOPES         = 'playlist-read-private playlist-read-collaborative';

let tokenCache = { token: null, expiresAt: 0 };
let refreshToken = null;

// Load saved refresh token from disk on first use.
async function loadSavedToken() {
  if (refreshToken) return;
  try {
    const data = JSON.parse(await readFile(TOKENS_PATH, 'utf8'));
    refreshToken = data.refresh_token ?? null;
  } catch {}
}

async function saveTokens(access, refresh, expiresIn) {
  refreshToken = refresh;
  tokenCache   = { token: access, expiresAt: Date.now() + expiresIn * 1000 };
  await writeFile(TOKENS_PATH, JSON.stringify({ refresh_token: refresh }, null, 2));
}

const basicAuth = () => 'Basic ' + Buffer.from(
  `${config.spotifyClientId}:${config.spotifyClientSecret}`
).toString('base64');

async function getToken() {
  await loadSavedToken();

  // Valid cached token
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 10_000) {
    return tokenCache.token;
  }

  // Refresh using saved refresh token
  if (refreshToken) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': basicAuth() },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (res.ok) {
      const data = await res.json();
      const newRefresh = data.refresh_token ?? refreshToken;
      await saveTokens(data.access_token, newRefresh, data.expires_in);
      return tokenCache.token;
    }
    // Refresh token expired — fall through to client credentials
    refreshToken = null;
  }

  // Fall back to client credentials (works for search but not playlist tracks)
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': basicAuth() },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function api(path) {
  const token = await getToken();
  const res   = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API error: HTTP ${res.status} on ${path}`);
  return res.json();
}

// ---- Auth flow ----

export function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     config.spotifyClientId,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state:         'dj-bot',
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export async function exchangeCode(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': basicAuth() },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  await saveTokens(data.access_token, data.refresh_token, data.expires_in);
}

export function isAuthed() {
  return !!refreshToken;
}

// ---- API methods ----

export async function searchPlaylists(query, limit = 10) {
  const data = await api(`/search?q=${encodeURIComponent(query)}&type=playlist&limit=${limit}`);
  return (data.playlists?.items ?? []).filter(Boolean).map((p) => ({
    id:     p.id,
    name:   p.name,
    owner:  p.owner?.display_name ?? 'Unknown',
    tracks: p.tracks?.total || '?',
    url:    p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
  }));
}

export async function getUserPlaylists(userId, limit = 20) {
  const data = await api(`/users/${encodeURIComponent(userId)}/playlists?limit=${limit}`);
  return (data.items ?? []).filter(Boolean).map((p) => ({
    id:     p.id,
    name:   p.name,
    owner:  p.owner?.display_name ?? userId,
    tracks: p.tracks?.total || '?',
    url:    p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
  }));
}

export async function getPlaylistTracks(playlistId) {
  const tracks = [];
  let   url    = `/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const data = await api(url);
    for (const item of data.items ?? []) {
      const t = item?.track;
      if (!t?.name) continue;
      const artists = (t.artists ?? []).map((a) => a.name).join(', ');
      tracks.push({
        displayTitle: `${artists} — ${t.name}`,
        searchQuery:  `${artists} - ${t.name}`,
        duration:     t.duration_ms ? formatMs(t.duration_ms) : null,
      });
    }
    url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return tracks;
}

export function resolvePlaylistId(input) {
  const m = input.match(/playlist\/([A-Za-z0-9]+)/);
  return m ? m[1] : input;
}

export function isConfigured() {
  return !!(config.spotifyClientId && config.spotifyClientSecret);
}

// Pre-load refresh token at startup.
export async function init() {
  await loadSavedToken();
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
