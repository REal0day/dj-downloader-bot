const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function fetchNewReleases(url) {
  const res  = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Beatport returned HTTP ${res.status}`);

  const html  = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find __NEXT_DATA__ in Beatport page. The page structure may have changed.');

  const root = JSON.parse(match[1]);

  // Walk dehydratedState queries to find track results
  const queries = root?.props?.pageProps?.dehydratedState?.queries ?? [];
  let tracks = null;

  for (const q of queries) {
    const results = q?.state?.data?.results;
    if (Array.isArray(results) && results[0]?.name && results[0]?.artists) {
      tracks = results;
      break;
    }
  }

  if (!tracks) throw new Error('Could not locate track list in Beatport data. Structure may have changed.');

  return tracks.slice(0, 10).map((t) => ({
    title:    t.name,
    mix:      t.mix_name ?? '',
    artists:  (t.artists ?? []).map((a) => a.name).join(', '),
    label:    t.release?.label?.name ?? '',
    year:     (t.release?.date ?? '').slice(0, 4),
    duration: t.duration?.minutes
      ? `${t.duration.minutes}:${String(t.duration.seconds ?? 0).padStart(2, '0')}`
      : null,
  }));
}
