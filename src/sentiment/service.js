import { log, error, debug } from '../shared/logger.js';
import { getState, setState, getList, publish } from '../shared/redis.js';
import * as reddit from './reddit.js';
import * as twitter from './twitter.js';
import * as discord from './discord.js';

let aggregationInterval = null;
let listenerActive = false;

export async function initSentiment() {
  try {
    log('[SENTIMENT] Initialized');
    return true;
  } catch (err) {
    error('[SENTIMENT] Init failed:', err.message);
    return false;
  }
}

function extractCashtags(text) {
  if (!text) return [];
  const matches = text.match(/\$[A-Za-z0-9_]+/g) || [];
  return [...new Set(matches)].map(m => m.substring(1));
}

function calculateSentimentScore(mentions) {
  if (!mentions || mentions.length === 0) {
    return { score: 0, positive: 0, negative: 0, neutral: 0, total: 0 };
  }

  let positive = 0;
  let negative = 0;
  let neutral = 0;

  const positiveKeywords = ['moon', 'pump', 'bullish', 'green', 'gain', 'rocket', 'lambo', 'to the moon', 'wen', 'moonshot'];
  const negativeKeywords = ['rug', 'scam', 'honeypot', 'dump', 'bearish', 'red', 'loss', 'exit', 'sell', 'dead'];

  for (const mention of mentions) {
    const text = (mention.text || mention.body || '').toLowerCase();
    let sentiment = 0;

    for (const word of positiveKeywords) {
      if (text.includes(word)) sentiment++;
    }
    for (const word of negativeKeywords) {
      if (text.includes(word)) sentiment--;
    }

    if (sentiment > 0) positive++;
    else if (sentiment < 0) negative++;
    else neutral++;
  }

  const total = mentions.length;
  return {
    score: (positive - negative) / total,
    positive,
    negative,
    neutral,
    total,
  };
}

function aggregateBySource(mentions) {
  const bySource = {
    reddit: [],
    twitter: [],
    discord: [],
    telegram: [],
  };

  for (const mention of mentions) {
    if (bySource[mention.source]) {
      bySource[mention.source].push(mention);
    }
  }

  return bySource;
}

function processMentions(mentions, cashtagData, addressData) {
  for (const m of mentions) {
    const text = m.text || m.body || m.title || '';
    const cashtags = extractCashtags(text);

    for (const tag of cashtags) {
      const key = tag.startsWith('$') ? tag.substring(1) : tag;
      if (!cashtagData[key]) cashtagData[key] = [];
      cashtagData[key].push(m);
    }

    if (m.addresses) {
      for (const addr of m.addresses) {
        if (!addressData[addr]) addressData[addr] = [];
        addressData[addr].push(m);
      }
    }
  }
}

function buildScoreEntry(identifier, identifierKey, mentions) {
  const analysis = calculateSentimentScore(mentions);
  const bySource = aggregateBySource(mentions);
  const velocity = mentions.length;

  return {
    [identifierKey]: identifier,
    score: analysis.score,
    breakdown: bySource,
    velocity,
    positive: analysis.positive,
    negative: analysis.negative,
    neutral: analysis.neutral,
    total: analysis.total,
    updatedAt: Date.now(),
  };
}

export async function processSentimentData() {
  try {
    const cashtagData = {};
    const addressData = {};
    const globalMentions = [];

    // --- REDDIT ---
    const redditSubs = await getState('config:reddit') || ['CryptoCurrency', 'Solana', 'CryptoMoonShots'];
    for (const sub of redditSubs) {
      const data = await reddit.getRedditSentiment(sub);
      if (data?.length > 0) {
        globalMentions.push(...data);
        processMentions(data, cashtagData, addressData);
      }
    }

    // --- TWITTER ---
    const twitterTerms = ['$SOL', 'memecoin', 'pumpfun'];
    for (const term of twitterTerms) {
      const data = await twitter.getTwitterSentiment(term);
      if (data?.length > 0) {
        globalMentions.push(...data);
        processMentions(data, cashtagData, addressData);
      }
    }

    // --- TELEGRAM ---
    const telegramMentions = await getList('sentiment:telegram:mentions');
    if (telegramMentions.length > 0) {
      globalMentions.push(...telegramMentions);
      processMentions(telegramMentions, cashtagData, addressData);
    }

    // --- DISCORD ---
    const discordServers = await getState('config:discord') || [];
    for (const server of discordServers) {
      const serverId = server.id || server;
      const data = await discord.getDiscordSentiment(serverId);
      if (data?.length > 0) {
        globalMentions.push(...data);
        processMentions(data, cashtagData, addressData);
      }
    }

    // --- BUILD SCORES ---
    const scores = {};

    for (const [tag, mentions] of Object.entries(cashtagData)) {
      scores[`$${tag}`] = buildScoreEntry(`$${tag}`, 'cashtag', mentions);
    }

    for (const [addr, mentions] of Object.entries(addressData)) {
      scores[addr] = buildScoreEntry(addr, 'address', mentions);
    }

    // Store aggregated data
    await setState('sentiment:scores', scores, 300);
    await setState('sentiment:global', globalMentions.slice(-1000), 300);

    // Publish buzz alerts
    const highScoring = Object.values(scores).filter(s => s.score >= 0.5 && s.velocity >= 10);
    if (highScoring.length > 0) {
      await publish('sentiment:buzz', highScoring);
      log(`[SENTIMENT] Buzz alert: ${highScoring.length} tokens scoring 0.5+`);
    }

    log(`[SENTIMENT] Processed ${globalMentions.length} mentions, ${Object.keys(scores).length} unique tickers`);

    return scores;
  } catch (err) {
    error('[SENTIMENT] Processing failed:', err.message);
    return {};
  }
}

export async function startSentimentAggregation() {
  if (aggregationInterval) {
    log('[SENTIMENT] Already running');
    return false;
  }

  const profile = await getState('profiles:active');
  const checkInterval = profile?.intervals?.marketData || 3000;

  await processSentimentData();

  aggregationInterval = setInterval(async () => {
    await processSentimentData();
  }, Math.max(checkInterval, 60000));

  listenerActive = true;
  log(`[SENTIMENT] Started aggregation loop (${Math.max(checkInterval, 60000)}ms interval)`);
  return true;
}

export async function startRedditPolling(subreddits) {
  return await reddit.startRedditPolling(subreddits);
}

export async function startTwitterStream(terms) {
  return await twitter.startTwitterStream(terms);
}

export async function startDiscordListening(servers) {
  return await discord.startDiscordListening(servers);
}

export async function getSentimentScore(identifier) {
  const scores = await getState('sentiment:scores');
  const key = identifier.startsWith('$') ? identifier.substring(1) : identifier;
  return scores?.[identifier] || scores?.[`$${key}`] || scores?.[key] || null;
}

export async function getGlobalSentiment() {
  return await getState('sentiment:global') || [];
}

export async function getBuzzingTokens(threshold = 0.5, minVelocity = 10) {
  const scores = await getState('sentiment:scores') || {};
  return Object.values(scores).filter(s => s.score >= threshold && s.velocity >= minVelocity);
}

export function stopAggregation() {
  listenerActive = false;
  if (aggregationInterval) {
    clearInterval(aggregationInterval);
    aggregationInterval = null;
  }
  log('[SENTIMENT] Stopped');
}

export function stopRedditPolling() {
  reddit.stopRedditPolling();
}

export function stopTwitterStream() {
  twitter.stopTwitterStream();
}

export function stopDiscordListening() {
  discord.stopDiscordListening();
}