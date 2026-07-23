import { log, error } from '../shared/logger.js';
import { getState, setState } from '../shared/redis.js';
import config from '../config/index.js';

let pollInterval = null;
let monitoredServers = [];

async function pollDiscordServer(serverId, serverName) {
  // Placeholder for Discord bot polling
  // Requires discord.js integration when bot token is provided
  //
  // Would use Client.guilds.cache.get(serverId).channels.cache
  // to iterate text channels and collect recent messages
  return [];
}

export async function startDiscordListening(servers) {
  if (!config.discord.active) {
    log('[DISCORD] Service inactive, skipping start');
    return false;
  }

  if (!config.discord.botToken || !config.discord.clientId) {
    error('[DISCORD] Missing bot token or client ID');
    return false;
  }

  monitoredServers = servers || [];
  log(`[DISCORD] Listening started for ${monitoredServers.length} servers`);

  pollInterval = setInterval(async () => {
    for (const server of monitoredServers) {
      const mentions = await pollDiscordServer(server.id, server.name);
      if (mentions.length > 0) {
        await setState(`sentiment:discord:${server.id}`, mentions, 3600);
        log(`[DISCORD] Collected ${mentions.length} messages from ${server.name}`);
      }
    }
  }, 60000);

  return true;
}

export function stopDiscordListening() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log('[DISCORD] Listening stopped');
  }
}

export async function getDiscordSentiment(serverId) {
  return await getState(`sentiment:discord:${serverId}`);
}