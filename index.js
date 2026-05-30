import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { config, validateConfig } from './src/config.js';
import { searchYouTube, downloadAudio, checkYtdlp } from './src/ytdlp.js';
import { formatDuration, formatViews, SerialQueue } from './src/util.js';
import { identify, detectBpm, writeTags, formatVerification } from './src/acoustid.js';

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
});

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
      if (match && match.score >= 0.5) writeTags(finalPath, match, bpm);
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
        if (match && match.score >= 0.5) writeTags(finalPath, match, bpm);
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
