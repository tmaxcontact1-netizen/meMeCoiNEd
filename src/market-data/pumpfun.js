import axios from 'axios';
import WebSocket from 'ws';
import { log, error, debug } from '../shared/logger.js';
import { setState, publish } from '../shared/redis.js';
import config from '../config/index.js';

const PUMPFUN_API = 'https://api.pump.fun';
let ws = null;
let pollingInterval = null;

export function startWebSocketListener(callback) {
  try {
    ws = new WebSocket('wss://pump.fun/stream');

    ws.on('open', () => {
      log('[PUMP.FUN] WebSocket connected');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        debug('[PUMP.FUN] WS Message:', msg);

        if (callback) callback(msg);
      } catch (err) {
        error(`[PUMP.FUN] Failed to parse WS message: ${err.message}`);
      }
    });

    ws.on('close', () => {
      log('[PUMP.FUN] WebSocket disconnected, reconnecting in 5s...');
      setTimeout(() => startWebSocketListener(callback), 5000);
    });

    ws.on('error', (err) => {
      error(`[PUMP.FUN] WebSocket error: ${err.message}`);
    });

    return true;
  } catch (err) {
    error(`[PUMP.FUN] Failed to start WebSocket: ${err.message}`);
    return false;
  }
}

export async function getPumpFunToken(mintAddress) {
  try {
    const resp = await axios.get(`${PUMPFUN_API}/api/token/${mintAddress}`);
    return resp.data || null;
  } catch (err) {
    error(`[PUMP.FUN] Failed to get token ${mintAddress}: ${err.message}`);
    return null;
  }
}

export async function getRecentLaunches(limit = 50) {
  try {
    const resp = await axios.get(`${PUMPFUN_API}/api/recent_launches`, {
      params: { limit },
    });
    return resp.data || [];
  } catch (err) {
    error(`[PUMP.FUN] Failed to get recent launches: ${err.message}`);
    return [];
  }
}

export function startPollingFallback(callback) {
  if (pollingInterval) {
    log('[PUMP.FUN] Polling already running');
    return false;
  }

  pollingInterval = setInterval(async () => {
    const launches = await getRecentLaunches(30);
    if (launches.length > 0 && callback) {
      callback(launches);
    }
  }, 30000);

  log('[PUMP.FUN] Started polling fallback (30s interval)');
  return true;
}

export function stopWebSocketListener() {
  if (ws) {
    ws.close();
    ws = null;
    log('[PUMP.FUN] WebSocket stopped');
  }
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    log('[PUMP.FUN] Polling stopped');
  }
}