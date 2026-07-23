import axios from 'axios';
import WebSocket from 'ws';
import { log, error, debug } from '../shared/logger.js';
import { setState, publish } from '../shared/redis.js';
import config from '../config/index.js';

const PUMPFUN_API = 'https://api.pump.fun';
let ws = null;
let discoveryInterval = null;

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
      setTimeout(startWebSocketListener, 5000);
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

export function stopWebSocketListener() {
  if (ws) {
    ws.close();
    ws = null;
    log('[PUMP.FUN] WebSocket stopped');
  }
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
}