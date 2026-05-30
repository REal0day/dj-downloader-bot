const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchNextData(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Beatport returned HTTP ${res.status} for ${url}`);
  const html  = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find __NEXT_DATA__ in Beatport page — structure may have changed.');
  return JSON.parse(match[1]);
}

function parseQueries(root) {
  return root?.props?.pageProps?.dehydratedState?.queries ?? [];
}

function normaliseTracks(raw) {
  return raw.map((t) => ({
    title:    t.name,
    mix:      t.mix_name ?? '',
    artists:  (t.artists ?? []).map((a) => a.name).join(', '),
    label:    t.release?.label?.name ?? '',
    year:     (t.release?.date ?? '').slice(0, 4),
    duration: t.duration?.minutes != null
      ? `${t.duration.minutes}:${String(t.duration.seconds ?? 0).padStart(2, '0')}`
      : null,
  }));
}

// Find the latest monthly chart whose slug contains slugPattern on the genre charts page.
export async function fetchLatestChart(chartsPageUrl, slugPattern = 'best-new-hard-techno') {
  const root    = await fetchNextData(chartsPageUrl);
  const queries = parseQueries(root);

  let charts = null;
  for (const q of queries) {
    const results = q?.state?.data?.results;
    if (Array.isArray(results) && results[0]?.slug != null) {
      charts = results;
      break;
    }
  }
  if (!charts) throw new Error('Could not find chart list in Beatport data — structure may have changed.');

  const matching = charts.filter((c) => c.slug?.includes(slugPattern));
  if (!matching.length) throw new Error(`No chart matching "${slugPattern}" found on that page.`);

  // Sort newest first by publish_date
  matching.sort((a, b) => new Date(b.publish_date ?? 0) - new Date(a.publish_date ?? 0));
  const latest = matching[0];

  return {
    name: latest.name,
    url:  `https://www.beatport.com/chart/${latest.slug}/${latest.id}`,
  };
}

// Fetch the track list from a Beatport chart page.
export async function fetchChartTracks(chartUrl) {
  const root    = await fetchNextData(chartUrl);
  const queries = parseQueries(root);

  let raw = null;
  for (const q of queries) {
    // Chart track lists may sit under .tracks or .results
    const candidate = q?.state?.data?.tracks ?? q?.state?.data?.results;
    if (Array.isArray(candidate) && candidate[0]?.name && candidate[0]?.artists) {
      raw = candidate;
      break;
    }
  }
  if (!raw) throw new Error('Could not find tracks in chart data — structure may have changed.');

  return normaliseTracks(raw);
}

export async function fetchNewReleases(url) {
  const root    = await fetchNextData(url);
  const queries = parseQueries(root);

  let raw = null;
  for (const q of queries) {
    const results = q?.state?.data?.results;
    if (Array.isArray(results) && results[0]?.name && results[0]?.artists) {
      raw = results;
      break;
    }
  }
  if (!raw) throw new Error('Could not locate track list in Beatport data — structure may have changed.');

  return normaliseTracks(raw.slice(0, 10));
}
