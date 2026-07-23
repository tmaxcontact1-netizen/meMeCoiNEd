import axios from 'axios';
import { log, error } from '../shared/logger.js';
import { setState, getState } from '../shared/redis.js';
import config from '../config/index.js';

const BASE = config.dexscreener.baseUrl;

export async function getCurrentPrice(tokenAddress) {
  try {
    const resp = await axios.get(`${BASE}/latest/dex/pairs/solana/${tokenAddress}`);
    if (resp.data.pairs?.length > 0) {
      return parseFloat(resp.data.pairs[0].priceUsd);
    }
    return null;
  } catch (err) {
    error(`[DEXSCREENER] Failed to get price for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

export async function searchTokens(query) {
  try {
    const resp = await axios.get(`${BASE}/search`, {
      params: { query },
    });
    return resp.data.pairs || [];
  } catch (err) {
    error(`[DEXSCREENER] Search failed for "${query}": ${err.message}`);
    return [];
  }
}

export async function getBoostedTokens() {
  try {
    const resp = await axios.get(`${BASE}/boost`);
    return resp.data?.boostedPairs || [];
  } catch (err) {
    error(`[DEXSCREENER] Failed to get boosted tokens: ${err.message}`);
    return [];
  }
}

export function startDiscovery() {
  // Placeholder - will be replaced by discovery/service.js coordination
  log('[DEXSCREENER] Discovery started');
  return true;
}

export async function getPairInfo(pairAddress) {
  try {
    const resp = await axios.get(`${BASE}/pair/data/${pairAddress}`);
    return resp.data.pair || null;
  } catch (err) {
    error(`[DEXSCREENER] Failed to get pair info for ${pairAddress}: ${err.message}`);
    return null;
  }
}

export async function getTokenHistory(tokenAddress, timeframe = '1h') {
  try {
    const resp = await axios.get(`${BASE}/pool/history`, {
      params: {
        pool: tokenAddress,
        timeframe,
      },
    });
    return resp.data.history || [];
  } catch (err) {
    error(`[DEXSCREENER] Failed to get token history: ${err.message}`);
    return [];
  }
}