import { log, error, debug } from '../shared/logger.js';
import { setState, getState, getList, publish } from '../shared/redis.js';
import * as dexscreener from '../market-data/dexscreener.js';
import * as birdeye from '../market-data/birdeye.js';
import * as pumpfun from '../market-data/pumpfun.js';
import { normalizeToken, calculateVelocity, filterByProfile, rankByScore } from './normalizer.js';

let discoveryInterval = null;
let trendingInterval = null;
let discoveredTokens = [];

async function collectFromSources() {
  const results = {
    dexscreener: [],
    birdeye: [],
    pumpfun: [],
  };

  // DexScreener - boosted tokens
  const boosted = await dexscreener.getBoostedTokens();
  results.dexscreener = boosted.map(t => normalizeToken('dexscreener', t));

  // Birdeye - top gainers
  const gainers = await birdeye.getTopGainers(20);
  results.birdeye = gainers.map(t => normalizeToken('birdeye', t));

  // Pump.fun - recent launches
  const launches = await pumpfun.getRecentLaunches(30);
  results.pumpfun = launches.map(t => normalizeToken('pumpfun', t));

  return results;
}

async function mergeAndRank(allResults) {
  const merged = [];
  const seen = new Set();

  Object.values(allResults).forEach(sourceTokens => {
    sourceTokens.forEach(token => {
      if (!seen.has(token.mint)) {
        seen.add(token.mint);
        merged.push(token);
      }
    });
  });

  // Calculate velocity for each token
  const withVelocity = merged.map(t => {
    const vel = calculateVelocity(t, 60);
    return { ...t, ...vel };
  });

  // Rank by composite score
  const ranked = rankByScore(withVelocity, {
    liquidity: 0.2,
    volume: 0.3,
    priceChange: 0.2,
    velocity: 0.3,
  });

  return ranked;
}

export async function runDiscovery() {
  try {
    const profile = await getState('profiles:active');
    if (!profile) {
      debug('[DISCOVERY] No active profile, using defaults');
    }

    log('[DISCOVERY] Running discovery cycle...');

    const allResults = await collectFromSources();
    const ranked = await mergeAndRank(allResults);
    const filtered = filterByProfile(ranked, profile);

    discoveredTokens = filtered.slice(0, 100);

    await setState('discovery:ranked', filtered.slice(0, 20), 60);
    await setState('discovery:all', filtered, 300);

    log(`[DISCOVERY] Found ${filtered.length} new tokens (${ranked.length} total before filtering)`);

    // Publish new discoveries for other services to consume
    if (filtered.length > 0) {
      await publish('discovery:new', {
        count: filtered.length,
        top5: filtered.slice(0, 5),
      });
    }

    return filtered;
  } catch (err) {
    error('[DISCOVERY] Discovery cycle failed:', err.message);
    return [];
  }
}

export async function startDiscoveryLoop() {
  if (discoveryInterval) {
    log('[DISCOVERY] Already running');
    return false;
  }

  // Initial discovery
  await runDiscovery();

  // Continuous loop
  discoveryInterval = setInterval(async () => {
    await runDiscovery();
  }, 10000);

  log('[DISCOVERY] Started 10s interval');
  return true;
}

export async function startTrendingCheck() {
  if (trendingInterval) {
    log('[DISCOVERY] Trending check already running');
    return false;
  }

  trendingInterval = setInterval(async () => {
    const tokens = await getList('discovery:ranked');
    const current = await getState('discovery:trending');
    const prev = current?.tokens || [];

    const trending = tokens.filter(t => {
      const prevToken = prev.find(p => p.mint === t.mint);
      if (!prevToken) return true;

      const volChange = t.volume24h / (prevToken.volume24h || 1);
      const liqChange = t.liquidityUsd / (prevToken.liquidityUsd || 1);

      return volChange > 2 || liqChange > 2;
    }).slice(0, 10);

    if (trending.length > 0) {
      await setState('discovery:trending', { tokens: trending, updatedAt: Date.now() }, 300);
      await publish('discovery:trending', trending);
      log(`[DISCOVERY] Trending alert: ${trending.length} tokens`);
    }
  }, 30000);

  log('[DISCOVERY] Trending check started (30s interval)');
  return true;
}

export function stopDiscovery() {
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
  if (trendingInterval) {
    clearInterval(trendingInterval);
    trendingInterval = null;
  }
  log('[DISCOVERY] Stopped');
}

export async function getDiscoveredTokens(limit = 20) {
  const all = await getState('discovery:all');
  return Array.isArray(all) ? all.slice(0, limit) : [];
}

export async function getTokenFromDiscovery(mintAddress) {
  const all = await getState('discovery:all');
  if (Array.isArray(all)) {
    return all.find(t => t.mint === mintAddress) || null;
  }
  return null;
}