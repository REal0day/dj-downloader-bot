/** Format seconds as M:SS or H:MM:SS. */
export function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '?:??';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Format a view count like 1.2M, 34K, 567. */
export function formatViews(views) {
  if (views == null) return 'views N/A';
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K views`;
  return `${views} views`;
}

/**
 * Serial queue: ensures only one yt-dlp download runs at a time so we don't
 * hammer the box or clobber files. Each job is an async function.
 */
export class SerialQueue {
  constructor() {
    this.chain = Promise.resolve();
    this.size = 0;
  }

  add(job) {
    this.size++;
    const run = this.chain.then(() => job()).finally(() => {
      this.size--;
    });
    // keep the chain alive even if a job rejects
    this.chain = run.catch(() => {});
    return run;
  }
}
