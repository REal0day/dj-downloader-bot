import 'dotenv/config';

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const config = {
  token: process.env.DISCORD_TOKEN,
  allowedUserId: process.env.ALLOWED_USER_ID?.trim() || null,
  allowedChannelId: process.env.ALLOWED_CHANNEL_ID?.trim() || null,
  prefix: process.env.PREFIX?.trim() || '!dl',
  outputDir: process.env.OUTPUT_DIR?.trim() || './downloads',
  genres: (process.env.GENRES || 'Uncategorized')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 24),
  searchResults: clampInt(process.env.SEARCH_RESULTS, 1, 5, 5),
  audioBitrate: process.env.AUDIO_BITRATE?.trim() || '320K',
  ytdlpPath: process.env.YTDLP_PATH?.trim() || 'yt-dlp',
  acoustidKey: process.env.ACOUSTID_API_KEY?.trim() || '',
};

export function validateConfig() {
  const errors = [];
  if (!config.token || config.token === 'your_bot_token_here') {
    errors.push('DISCORD_TOKEN is not set.');
  }
  if (config.genres.length === 0) {
    errors.push('GENRES resolved to an empty list.');
  }
  return errors;
}
