import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { config, validateConfig } from './src/config.js';
import { searchYouTube, downloadAudio, checkYtdlp } from './src/ytdlp.js';
import { formatDuration, formatViews, SerialQueue } from './src/util.js';
import { identify, detectBpm, writeTags, formatVerification, isVerified, readScore } from './src/acoustid.js';
import { loadWatchlist, addWatch, removeWatch, checkAll, detectPlatform } from './src/watcher.js';
import { fetchNewReleases, fetchChartTracks } from './src/beatport.js';

// ---- startup validation ----
const errors = validateConfig();
if (errors.length) {
  console.error('Configuration errors:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const downloadQueue = new SerialQueue();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal
  ],
});

client.once('clientReady', async (c) => {
  const version = await checkYtdlp();
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`yt-dlp: ${version ? 'v' + version : 'NOT FOUND on PATH — fix YTDLP_PATH'}`);
  console.log(`Output dir: ${config.outputDir}`);
  console.log(`Genres: ${config.genres.join(', ')}`);
  console.log(`Listening for: "${config.prefix} <song name>"`);

  if (config.watchChannelId) {
    // Wait 1 min before first check so the bot fully settles after restart
    setTimeout(() => runWatchPoll(c), 60_000);
    setInterval(() => runWatchPoll(c), config.watchIntervalMs);
    console.log(`Watch polling: every ${config.watchIntervalMs / 3_600_000}h → channel ${config.watchChannelId}`);
  } else {
    console.log('Watch polling disabled — set WATCH_CHANNEL_ID to enable.');
  }
});

async function runWatchPoll(discordClient) {
  try {
    const updates = await checkAll();
    if (!updates.length) return;

    const channel = await discordClient.channels.fetch(config.watchChannelId).catch(() => null);
    if (!channel) return;

    for (const { entry, newItems } of updates) {
      const lines = newItems.map((item, i) =>
        `**${i + 1}.** [${item.title}](${item.url})`
      );
      const plural = newItems.length > 1 ? `${newItems.length} new uploads` : '1 new upload';
      await channel.send(
        `🆕 **${entry.label}** — ${plural} (${entry.platform})\n` +
        lines.join('\n') +
        `\n\nUse \`${config.prefix} <title>\` to download any of these.`
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Watch poll error:', err.message);
  }
}

// Build rows of genre buttons (max 5 per row, max 5 rows).
function buildGenreRows() {
  const rows = [];
  let current = new ActionRowBuilder();
  config.genres.forEach((genre, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(current);
      current = new ActionRowBuilder();
    }
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`genre:${i}`)
        .setLabel(genre.length > 20 ? genre.slice(0, 19) + '…' : genre)
        .setStyle(ButtonStyle.Secondary)
    );
  });
  if (current.components.length) rows.push(current);
  return rows.slice(0, 5);
}

// Build rows of numbered track-pick buttons + a cancel row.
// Cancel gets its own row so the track buttons row never exceeds 5.
function buildTrackRow(count) {
  const trackRow = new ActionRowBuilder();
  for (let i = 0; i < count; i++) {
    trackRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`pick:${i}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary)
    );
  }
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cancel')
      .setLabel('✕ Cancel')
      .setStyle(ButtonStyle.Danger)
  );
  return [trackRow, cancelRow];
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  // access control
  if (config.allowedUserId && message.author.id !== config.allowedUserId) return;
  if (config.allowedChannelId && message.channelId !== config.allowedChannelId) return;

  // ---- watch command: !dlwatch add/list/remove/check ----
  const watchPrefix = config.prefix + 'watch';
  if (message.content.startsWith(watchPrefix)) {
    await handleWatch(message, watchPrefix);
    return;
  }

  // ---- new releases command: !dlnew ----
  const newPrefix = config.prefix + 'new';
  if (message.content.startsWith(newPrefix)) {
    await handleNew(message);
    return;
  }

  // ---- monthly chart command: !dlchart [genre] ----
  const chartPrefix = config.prefix + 'chart';
  if (message.content.startsWith(chartPrefix)) {
    await handleChart(message, chartPrefix);
    return;
  }

  // ---- report command: !dlreport [genre] ----
  const reportPrefix = config.prefix + 'report';
  if (message.content.startsWith(reportPrefix)) {
    await handleReport(message, reportPrefix);
    return;
  }

  // ---- scan command: !dlscan [genre] ----
  const scanPrefix = config.prefix + 'scan';
  if (message.content.startsWith(scanPrefix)) {
    await handleScan(message, scanPrefix);
    return;
  }

  // ---- batch command: !dlbatch <genre>\nsong1\nsong2\n... ----
  const batchPrefix = config.prefix + 'batch';
  if (message.content.startsWith(batchPrefix)) {
    await handleBatch(message, batchPrefix);
    return;
  }

  const query = message.content.slice(config.prefix.length).trim();
  if (!query) {
    await message.reply(
      `Usage:\n` +
      `• Single: \`${config.prefix} artist - track\`\n` +
      `• Batch:  \`${batchPrefix} <genre>\\n<song1>\\n<song2>\\n...\``
    );
    return;
  }

  // ---- 1. search ----
  const searching = await message.reply(`🔎 Searching YouTube for **${query}**…`);

  let results;
  try {
    results = await searchYouTube(query, config.searchResults);
  } catch (err) {
    await searching.edit(`❌ Search failed: ${err.message}`);
    return;
  }

  if (!results.length) {
    await searching.edit(`No results found for **${query}**.`);
    return;
  }

  const listEmbed = new EmbedBuilder()
    .setTitle(`Results for "${query}"`)
    .setColor(0x1db954)
    .setDescription(
      results
        .map(
          (r, i) =>
            `**${i + 1}.** [${r.title}](${r.url})\n` +
            `   ⏱ ${formatDuration(r.duration)} · 👁 ${formatViews(r.viewCount)} · ${r.channel}`
        )
        .join('\n\n')
    )
    .setFooter({ text: 'Pick a number to download, or ✕ to cancel.' });

  await searching.edit({
    content: null,
    embeds: [listEmbed],
    components: buildTrackRow(results.length),
  });

  // only the requester can press buttons
  const filter = (i) => i.user.id === message.author.id;

  // ---- 2. wait for track pick ----
  let pickInteraction;
  try {
    pickInteraction = await searching.awaitMessageComponent({
      filter,
      componentType: ComponentType.Button,
      time: 60_000,
    });
  } catch {
    await searching.edit({ content: '⏳ Timed out — no track selected.', embeds: [], components: [] });
    return;
  }

  if (pickInteraction.customId === 'cancel') {
    await pickInteraction.update({ content: 'Cancelled.', embeds: [], components: [] });
    return;
  }

  const trackIndex = parseInt(pickInteraction.customId.split(':')[1], 10);
  const chosen = results[trackIndex];

  // ---- 3. ask for genre folder ----
  await pickInteraction.update({
    content: `Selected: **${chosen.title}**\nWhich folder?`,
    embeds: [],
    components: buildGenreRows(),
  });

  let genreInteraction;
  try {
    genreInteraction = await searching.awaitMessageComponent({
      filter,
      componentType: ComponentType.Button,
      time: 60_000,
    });
  } catch {
    await searching.edit({ content: '⏳ Timed out — no folder selected.', components: [] });
    return;
  }

  const genreIndex = parseInt(genreInteraction.customId.split(':')[1], 10);
  const genre = config.genres[genreIndex];
  const destDir = path.join(config.outputDir, genre);

  const position = downloadQueue.size; // jobs ahead of this one
  await genreInteraction.update({
    content:
      `⬇️ Queued **${chosen.title}** → \`${genre}\`` +
      (position > 0 ? ` (${position} ahead in queue)` : '') +
      `\nDownloading…`,
    components: [],
  });

  // ---- 4. download (serialized) ----
  downloadQueue.add(async () => {
    try {
      await mkdir(destDir, { recursive: true });
      const finalPath = await downloadAudio(chosen.url, destDir);
      const filename = path.basename(finalPath);

      const [match, bpm] = await Promise.all([identify(finalPath), detectBpm(finalPath)]);
      writeTags(finalPath, match, bpm);
      const verification = formatVerification(match, bpm);

      await searching.edit(
        `✅ **${filename}**\n` +
        `→ \`${genre}\` (${config.audioBitrate} MP3)\n` +
        `${verification}`
      );
    } catch (err) {
      await searching.edit(`❌ Download failed for **${chosen.title}**: ${err.message}`);
    }
  });
});

async function handleWatch(message, watchPrefix) {
  const args = message.content.slice(watchPrefix.length).trim().split(/\s+/);
  const sub  = args[0]?.toLowerCase();

  if (sub === 'add') {
    const url   = args[1];
    const label = args.slice(2).join(' ') || null;
    if (!url) {
      await message.reply(`Usage: \`${watchPrefix} add <url> [label]\``);
      return;
    }
    const status = await message.reply(`⏳ Fetching latest from ${detectPlatform(url)}…`);
    const result = await addWatch(url, label);
    if (!result.ok) {
      await status.edit(`❌ ${result.reason}`);
    } else {
      await status.edit(
        `✅ Watching **${result.entry.label}** (${result.entry.platform})\n` +
        `Alerts → <#${config.watchChannelId ?? 'no channel set'}> every 6h.`
      );
    }
    return;
  }

  if (sub === 'list') {
    const list = await loadWatchlist();
    if (!list.length) {
      await message.reply('No artists being watched. Use `!dlwatch add <url>` to start.');
      return;
    }
    const lines = list.map((e, i) =>
      `**${i + 1}.** ${e.label} (${e.platform}) — ${e.url}`
    );
    await message.reply(`**Watchlist (${list.length})**\n${lines.join('\n')}`);
    return;
  }

  if (sub === 'remove') {
    const query = args.slice(1).join(' ');
    if (!query) {
      await message.reply(`Usage: \`${watchPrefix} remove <name or number>\``);
      return;
    }
    const removed = await removeWatch(query);
    if (!removed) {
      await message.reply(`❌ No match for **${query}**. Use \`${watchPrefix} list\` to see entries.`);
    } else {
      await message.reply(`🗑️ Removed **${removed.label}** (${removed.platform}).`);
    }
    return;
  }

  if (sub === 'check') {
    const status = await message.reply('🔍 Checking all watched channels now…');
    const updates = await checkAll();
    if (!updates.length) {
      await status.edit('✅ No new content found.');
    } else {
      const lines = updates.map((u) =>
        `**${u.entry.label}** (${u.entry.platform}): ${u.newItems.length} new`
      );
      await status.edit(`🆕 Found updates:\n${lines.join('\n')}\nPosting to watch channel…`);
      await runWatchPoll(message.client);
    }
    return;
  }

  await message.reply(
    `**${watchPrefix} commands**\n` +
    `• \`${watchPrefix} add <url> [label]\` — watch a YouTube/SoundCloud/Mixcloud/Bandcamp channel\n` +
    `• \`${watchPrefix} list\` — show all watched channels\n` +
    `• \`${watchPrefix} remove <name or #>\` — stop watching\n` +
    `• \`${watchPrefix} check\` — manually trigger a check now`
  );
}

async function handleChart(message, chartPrefix) {
  const args     = message.content.slice(chartPrefix.length).trim().split(/\s+/);
  const chartUrl = args[0]?.startsWith('http') ? args[0] : null;
  const genreArg = chartUrl ? args.slice(1).join(' ') : args.join(' ');

  if (!chartUrl) {
    await message.reply(
      `Paste the Beatport chart URL:\n\`${chartPrefix} <beatport-chart-url> [genre]\`\n\n` +
      `Example:\n\`${chartPrefix} https://www.beatport.com/chart/best-new-hard-techno-june-2026/891416 Hard Techno\``
    );
    return;
  }

  const genre = genreArg
    ? config.genres.find((g) => g.toLowerCase() === genreArg.toLowerCase())
    : null;

  if (genreArg && !genre) {
    await message.reply(`Unknown genre **${genreArg}**.\nAvailable: ${config.genres.join(', ')}`);
    return;
  }

  const status = await message.reply('⏳ Fetching chart from Beatport via yt-dlp…');

  let tracks;
  try {
    tracks = await fetchChartTracks(chartUrl);
  } catch (err) {
    await status.edit(`❌ Beatport error: ${err.message}`);
    return;
  }

  const chart = { name: 'Beatport Chart', url: chartUrl };

  if (!tracks.length) {
    await status.edit('No tracks found in that chart.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${chart.name}`)
    .setURL(chart.url)
    .setColor(0x01ff95)
    .setDescription(
      tracks.map((t, i) =>
        `**${i + 1}.** ${t.displayTitle}${t.duration ? ` · ${t.duration}` : ''}`
      ).join('\n')
    )
    .setFooter({ text: `${tracks.length} tracks · click Download All or pick a number` });

  // Build button rows: numbered picks + Download All + Cancel
  const rows = [];
  let current = new ActionRowBuilder();
  tracks.forEach((_, i) => {
    if (i > 0 && i % 5 === 0) { rows.push(current); current = new ActionRowBuilder(); }
    current.addComponents(
      new ButtonBuilder().setCustomId(`chart:${i}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Primary)
    );
  });
  if (current.components.length) rows.push(current);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('chart:all').setLabel('⬇️ Download All').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel').setLabel('✕ Cancel').setStyle(ButtonStyle.Danger)
    )
  );

  await status.edit({ content: null, embeds: [embed], components: rows.slice(0, 5) });

  const filter = (i) => i.user.id === message.author.id;
  let pick;
  try {
    pick = await status.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 90_000 });
  } catch {
    await status.edit({ content: '⏳ Timed out.', embeds: [], components: [] });
    return;
  }

  if (pick.customId === 'cancel') {
    await pick.update({ content: 'Cancelled.', embeds: [], components: [] });
    return;
  }

  // Resolve destination genre — ask if not provided
  let destGenre = genre;
  if (!destGenre) {
    await pick.update({ content: `Which folder should these go into?`, embeds: [], components: buildGenreRows() });
    let genrePick;
    try {
      genrePick = await status.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 60_000 });
    } catch {
      await status.edit({ content: '⏳ Timed out.', components: [] });
      return;
    }
    destGenre = config.genres[parseInt(genrePick.customId.split(':')[1], 10)];
    await genrePick.update({ content: `⬇️ Queueing downloads → \`${destGenre}\`…`, components: [] });
  } else {
    await pick.update({ content: `⬇️ Queueing downloads → \`${destGenre}\`…`, embeds: [], components: [] });
  }

  // Determine which tracks to download
  const toDownload = pick.customId === 'chart:all'
    ? tracks
    : [tracks[parseInt(pick.customId.split(':')[1], 10)]];

  const destDir  = path.join(config.outputDir, destGenre);
  await mkdir(destDir, { recursive: true });

  const statuses = toDownload.map((t) => ({ label: t.displayTitle, icon: '⏳' }));
  const renderStatus = () =>
    `⬇️ Chart download → \`${destGenre}\` (${toDownload.length} tracks)\n` +
    statuses.map((s, i) => `**${i + 1}.** ${s.icon} ${s.label}`).join('\n');

  await status.edit({ content: renderStatus(), embeds: [], components: [] });

  toDownload.forEach((track, i) => {
    downloadQueue.add(async () => {
      statuses[i].icon = '🔎';
      await status.edit(renderStatus()).catch(() => {});

      const query = track.searchQuery;
      let results;
      try {
        results = await searchYouTube(query, 1);
      } catch {
        statuses[i].icon = '❌'; statuses[i].label += ' — search failed';
        await status.edit(renderStatus()).catch(() => {});
        return;
      }
      if (!results.length) {
        statuses[i].icon = '❌'; statuses[i].label += ' — no results';
        await status.edit(renderStatus()).catch(() => {});
        return;
      }

      statuses[i].icon = '⬇️'; statuses[i].label = results[0].title;
      await status.edit(renderStatus()).catch(() => {});

      try {
        const finalPath    = await downloadAudio(results[0].url, destDir);
        const [match, bpm] = await Promise.all([identify(finalPath), detectBpm(finalPath)]);
        writeTags(finalPath, match, bpm);
        const pct = match ? `${Math.round(match.score * 100)}%` : null;
        statuses[i].icon  = match && match.score >= 0.8 ? '✅' : '⚠️';
        statuses[i].label = [path.basename(finalPath), match?.artist, match?.year, bpm ? `${bpm} BPM` : null, pct]
          .filter(Boolean).join(' · ');
      } catch (err) {
        statuses[i].icon = '❌'; statuses[i].label += ` — ${err.message.slice(0, 60)}`;
      }
      await status.edit(renderStatus()).catch(() => {});
    });
  });
}

async function handleNew(message) {
  const status = await message.reply('⏳ Fetching new releases from Beatport…');

  let tracks;
  try {
    tracks = await fetchNewReleases(config.beatportUrl);
  } catch (err) {
    await status.edit(`❌ Beatport fetch failed: ${err.message}`);
    return;
  }

  if (!tracks.length) {
    await status.edit('No tracks found on Beatport. Try again later.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🆕 New on Beatport')
    .setColor(0x01ff95)
    .setDescription(
      tracks.map((t, i) =>
        `**${i + 1}.** ${t.displayTitle}${t.duration ? ` · ${t.duration}` : ''}`
      ).join('\n')
    )
    .setFooter({ text: 'Pick a number to search YouTube and download.' });

  await status.edit({
    content: null,
    embeds: [embed],
    components: buildTrackRow(tracks.length),
  });

  const filter = (i) => i.user.id === message.author.id;
  let pick;
  try {
    pick = await status.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 60_000 });
  } catch {
    await status.edit({ content: '⏳ Timed out.', embeds: [], components: [] });
    return;
  }

  if (pick.customId === 'cancel') {
    await pick.update({ content: 'Cancelled.', embeds: [], components: [] });
    return;
  }

  const chosen = tracks[parseInt(pick.customId.split(':')[1], 10)];
  const query  = chosen.searchQuery;

  await pick.update({ content: `🔎 Searching YouTube for **${query}**…`, embeds: [], components: [] });

  let results;
  try {
    results = await searchYouTube(query, config.searchResults);
  } catch (err) {
    await status.edit(`❌ Search failed: ${err.message}`);
    return;
  }
  if (!results.length) {
    await status.edit(`No YouTube results for **${query}**.`);
    return;
  }

  const listEmbed = new EmbedBuilder()
    .setTitle(`YouTube results for "${query}"`)
    .setColor(0x1db954)
    .setDescription(
      results.map((r, i) =>
        `**${i + 1}.** [${r.title}](${r.url})\n` +
        `   ⏱ ${formatDuration(r.duration)} · 👁 ${formatViews(r.viewCount)} · ${r.channel}`
      ).join('\n\n')
    )
    .setFooter({ text: 'Pick a number to download, or ✕ to cancel.' });

  await status.edit({ content: null, embeds: [listEmbed], components: buildTrackRow(results.length) });

  let ytPick;
  try {
    ytPick = await status.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 60_000 });
  } catch {
    await status.edit({ content: '⏳ Timed out.', embeds: [], components: [] });
    return;
  }
  if (ytPick.customId === 'cancel') {
    await ytPick.update({ content: 'Cancelled.', embeds: [], components: [] });
    return;
  }

  const ytChosen = results[parseInt(ytPick.customId.split(':')[1], 10)];
  await ytPick.update({
    content: `Selected: **${ytChosen.title}**\nWhich folder?`,
    embeds: [],
    components: buildGenreRows(),
  });

  let genreInteraction;
  try {
    genreInteraction = await status.awaitMessageComponent({ filter, componentType: ComponentType.Button, time: 60_000 });
  } catch {
    await status.edit({ content: '⏳ Timed out.', components: [] });
    return;
  }

  const genre   = config.genres[parseInt(genreInteraction.customId.split(':')[1], 10)];
  const destDir = path.join(config.outputDir, genre);
  await genreInteraction.update({ content: `⬇️ Downloading **${ytChosen.title}** → \`${genre}\`…`, components: [] });

  downloadQueue.add(async () => {
    try {
      await mkdir(destDir, { recursive: true });
      const finalPath    = await downloadAudio(ytChosen.url, destDir);
      const [match, bpm] = await Promise.all([identify(finalPath), detectBpm(finalPath)]);
      writeTags(finalPath, match, bpm);
      await status.edit(
        `✅ **${path.basename(finalPath)}**\n→ \`${genre}\` (${config.audioBitrate} MP3)\n${formatVerification(match, bpm)}`
      );
    } catch (err) {
      await status.edit(`❌ Download failed: ${err.message}`);
    }
  });
}

async function handleReport(message, reportPrefix) {
  const genreArg = message.content.slice(reportPrefix.length).trim();

  let targets;
  if (genreArg) {
    const genre = config.genres.find((g) => g.toLowerCase() === genreArg.toLowerCase());
    if (!genre) {
      await message.reply(`Unknown genre **${genreArg}**.\nAvailable: ${config.genres.join(', ')}`);
      return;
    }
    targets = [{ genre, dir: path.join(config.outputDir, genre) }];
  } else {
    targets = config.genres.map((g) => ({ genre: g, dir: path.join(config.outputDir, g) }));
  }

  const lowConfidence = [];  // score < 80 but processed
  const unverified = [];     // never processed

  for (const { genre, dir } of targets) {
    let entries;
    try {
      entries = await readdir(dir, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.mp3')) continue;
      const fullPath = path.join(dir, entry);
      const score = readScore(fullPath);
      if (score === null) {
        unverified.push({ genre, name: path.basename(entry) });
      } else if (score < 80) {
        lowConfidence.push({ genre, name: path.basename(entry), score });
      }
    }
  }

  if (!lowConfidence.length && !unverified.length) {
    await message.reply('✅ All files verified at ≥ 80% confidence. Nothing to flag.');
    return;
  }

  const lines = [];

  if (lowConfidence.length) {
    lowConfidence.sort((a, b) => a.score - b.score);
    lines.push(`**⚠️ Low confidence (${lowConfidence.length})**`);
    for (const f of lowConfidence) {
      lines.push(`  ${f.score}% · \`${f.genre}\` · ${f.name}`);
    }
  }

  if (unverified.length) {
    lines.push(`\n**❓ Never scanned (${unverified.length}) — run \`!dlscan\`**`);
    for (const f of unverified) {
      lines.push(`  \`${f.genre}\` · ${f.name}`);
    }
  }

  // Discord message cap: 2000 chars. Truncate if needed.
  const header = `**!dlreport** — ${lowConfidence.length} low confidence · ${unverified.length} unscanned\n\n`;
  let body = lines.join('\n');
  if (header.length + body.length > 1900) {
    body = body.slice(0, 1900 - header.length) + '\n…(truncated)';
  }

  await message.reply(header + body);
}

async function handleScan(message, scanPrefix) {
  const genreArg = message.content.slice(scanPrefix.length).trim();

  // Resolve which genre folders to scan
  let targets;
  if (genreArg) {
    const genre = config.genres.find((g) => g.toLowerCase() === genreArg.toLowerCase());
    if (!genre) {
      await message.reply(`Unknown genre **${genreArg}**.\nAvailable: ${config.genres.join(', ')}`);
      return;
    }
    targets = [path.join(config.outputDir, genre)];
  } else {
    targets = config.genres.map((g) => path.join(config.outputDir, g));
  }

  // Collect all unverified MP3s
  const toProcess = [];
  for (const dir of targets) {
    let entries;
    try {
      entries = await readdir(dir, { recursive: true });
    } catch {
      continue; // folder doesn't exist yet
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.mp3')) continue;
      const fullPath = path.join(dir, entry);
      if (!isVerified(fullPath)) toProcess.push({ fullPath, name: path.basename(entry) });
    }
  }

  if (!toProcess.length) {
    await message.reply('✅ All MP3s are already verified — nothing to do.');
    return;
  }

  const total = toProcess.length;
  const counts = { ok: 0, warn: 0, fail: 0 };
  let lastLine = '';
  let done = 0;

  const render = () =>
    `🔍 Scanning — ${done}/${total} done\n` +
    `✅ ${counts.ok} · ⚠️ ${counts.warn} · ❌ ${counts.fail} · ⏳ ${total - done} remaining\n` +
    (lastLine ? `→ ${lastLine}` : '');

  const statusMsg = await message.reply(
    `🔍 Found **${total}** unverified MP3${total === 1 ? '' : 's'} — scanning…`
  );

  for (const file of toProcess) {
    downloadQueue.add(async () => {
      try {
        const [match, bpm] = await Promise.all([identify(file.fullPath), detectBpm(file.fullPath)]);
        writeTags(file.fullPath, match, bpm);
        const pct = match ? Math.round(match.score * 100) : 0;
        if (pct >= 80) counts.ok++;
        else counts.warn++;
        lastLine = [
          file.name,
          match?.artist ?? null,
          match?.year   ?? null,
          bpm           ? `${bpm} BPM` : null,
          match         ? `${pct}%`    : 'no match',
        ].filter(Boolean).join(' · ');
      } catch {
        counts.fail++;
        lastLine = `❌ ${file.name}`;
      }
      done++;
      await statusMsg.edit(render()).catch(() => {});
    });
  }

  // Final summary queued after all scan jobs
  downloadQueue.add(async () => {
    await statusMsg.edit(
      `✅ Scan complete — ${total} file${total === 1 ? '' : 's'}\n` +
      `✅ ${counts.ok} verified · ⚠️ ${counts.warn} low confidence · ❌ ${counts.fail} failed`
    ).catch(() => {});
  });
}

async function handleBatch(message, batchPrefix) {
  const lines = message.content
    .slice(batchPrefix.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    await message.reply(
      `Usage:\n\`\`\`\n${batchPrefix} <genre>\nsong 1\nsong 2\n...\n\`\`\`\nAvailable genres: ${config.genres.join(', ')}`
    );
    return;
  }

  const genreLine = lines[0];
  const queries = lines.slice(1);

  const genre = config.genres.find((g) => g.toLowerCase() === genreLine.toLowerCase());
  if (!genre) {
    await message.reply(
      `Unknown genre **${genreLine}**.\nAvailable: ${config.genres.join(', ')}`
    );
    return;
  }

  const destDir = path.join(config.outputDir, genre);
  await mkdir(destDir, { recursive: true });

  // track per-song state for the live status message
  const statuses = queries.map((q) => ({ query: q, icon: '⏳', label: q }));

  const renderStatus = () =>
    `⬇️ Batch → \`${genre}\` (${queries.length} tracks)\n` +
    statuses.map((s, i) => `**${i + 1}.** ${s.icon} ${s.label}`).join('\n');

  const statusMsg = await message.reply(renderStatus());

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    downloadQueue.add(async () => {
      statuses[i].icon = '🔎';
      await statusMsg.edit(renderStatus()).catch(() => {});

      let results;
      try {
        results = await searchYouTube(q, 1);
      } catch (err) {
        statuses[i].icon = '❌';
        statuses[i].label = `${q} — search failed`;
        await statusMsg.edit(renderStatus()).catch(() => {});
        return;
      }

      if (!results.length) {
        statuses[i].icon = '❌';
        statuses[i].label = `${q} — no results`;
        await statusMsg.edit(renderStatus()).catch(() => {});
        return;
      }

      const track = results[0];
      statuses[i].icon = '⬇️';
      statuses[i].label = track.title;
      await statusMsg.edit(renderStatus()).catch(() => {});

      try {
        const finalPath = await downloadAudio(track.url, destDir);
        const [match, bpm] = await Promise.all([identify(finalPath), detectBpm(finalPath)]);
        writeTags(finalPath, match, bpm);
        const pct = match ? `${Math.round(match.score * 100)}%` : null;
        const parts = [
          path.basename(finalPath),
          match?.artist ?? null,
          match?.year   ?? null,
          bpm ? `${bpm} BPM` : null,
          pct,
        ].filter(Boolean);
        statuses[i].icon = match && match.score >= 0.8 ? '✅' : match ? '⚠️' : '✅';
        statuses[i].label = parts.join(' · ');
      } catch (err) {
        statuses[i].icon = '❌';
        statuses[i].label = `${track.title} — download failed`;
      }

      await statusMsg.edit(renderStatus()).catch(() => {});
    });
  }
}

client.login(config.token);
