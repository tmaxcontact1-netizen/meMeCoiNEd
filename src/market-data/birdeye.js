import axios from 'axios';
import { log, error } from '../shared/logger.js';
import { setState } from '../shared/redis.js';
import config from '../config/index.js';

const BASE = 'https://api.birdeye.so';

export async function getTopGainers(limit = 20) {
  try {
    const resp = await axios.get(`${BASE}/public/v1/token/top_gainers`, {
      headers: { 'x-chain': 'solana', 'X-API-KEY': config.birdeye.apiKey },
      params: { limit },
    });
    return resp.data?.data?.items || [];
  } catch (err) {
    error(`[BIRDEYE] Failed to get top gainers: ${err.message}`);
    return [];
  }
}

export async function getTokenPrice(tokenAddress) {
  try {
    const resp = await axios.get(`${BASE}/public/v1/price`, {
      headers: { 'x-chain': 'solana', 'X-API-KEY': config.birdeye.apiKey },
      params: { address: tokenAddress },
    });
    return resp.data?.data?.price || null;
  } catch (err) {
    error(`[BIRDEYE] Failed to get price for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

export async function getTokenDetails(tokenAddress) {
  try {
    const resp = await axios.get(`${BASE}/public/v1/token_overview`, {
      headers: { 'x-chain': 'solana', 'X-API-KEY': config.birdeye.apiKey },
      params: { address: tokenAddress },
    });
    return resp.data?.data || null;
  } catch (err) {
    error(`[BIRDEYE] Failed to get details for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

export async function searchTokens(query) {
  try {
    const resp = await axios.get(`${BASE}/public/v1/search/tokens`, {
      headers: { 'x-chain': 'solana', 'X-API-KEY': config.birdeye.apiKey },
      params: { keywords: query },
    });
    return resp.data?.data?.items || [];
  } catch (err) {
    error(`[BIRDEYE] Search failed for "${query}": ${err.message}`);
    return [];
  }
}

export async function getRecentMints(count = 50) {
  try {
    const resp = await axios.get(`${BASE}/public/v1/token/new_list_tokens`, {
      headers: { 'x-chain': 'solana', 'X-API-KEY': config.birdeye.apiKey },
      params: { count },
    });
    return resp.data?.data?.items || [];
  } catch (err) {
    error(`[BIRDEYE] Failed to get recent mints: ${err.message}`);
    return [];
  }
}