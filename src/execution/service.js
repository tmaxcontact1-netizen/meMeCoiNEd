import { log, error, debug } from '../shared/logger.js';
import { getState, setState, deleteKey, addToList, publish, subscribe } from '../shared/redis.js';
import { getCurrentPrice } from '../market-data/dexscreener.js';
import { checkTokenSafety } from '../rug-check/service.js';
import config from '../config/index.js';

const POSITION_PREFIX = 'position:';
let listenerActive = false;
let healthInterval = null;

export async function initExecution() {
  try {
    // Ensure portfolio defaults exist
    const cash = await getState('portfolio:cash');
    if (cash === null) {
      await setState('portfolio:cash', 1000);
      log('[EXECUTION] Portfolio initialized with $1000 paper balance');
    }

    const positionKeys = await getState('portfolio:positionKeys');
    if (positionKeys === null) {
      await setState('portfolio:positionKeys', []);
    }

    const history = await getState('portfolio:history');
    if (history === null) {
      await setState('portfolio:history', []);
    }

    log('[EXECUTION] Initialized');
    return true;
  } catch (err) {
    error('[EXECUTION] Init failed:', err.message);
    return false;
  }
}

async function reportHealth(status, message = '') {
  const current = await getState('service:health') || {};
  current.execution = { status, message, timestamp: Date.now() };
  await setState('service:health', current);
  await publish('service:health', current);
}

export async function startExecutionListener() {
  if (listenerActive) {
    log('[EXECUTION] Listener already running');
    return false;
  }

  listenerActive = true;

  // Listen for discovery signals
  await subscribe('discovery:new', async (data) => {
    if (!data?.top5) return;
    for (const token of data.top5) {
      const profile = await getState('profiles:active');
      if (!profile) continue;

      const positionKeys = await getState('portfolio:positionKeys') || [];
      if (positionKeys.length >= profile.risk.maxConcurrentPositions) {
        debug('[EXECUTION] Max positions reached, skipping');
        break;
      }

      // Check if already holding
      const existing = await getState(`${POSITION_PREFIX}${token.mint}`);
      if (existing) continue;

      // Rug check before buying
      if (!config.paperTrading) {
        const safety = await checkTokenSafety(token.mint);
        if (!safety || !safety.safe) {
          debug(`[EXECUTION] Skipped unsafe token ${token.mint}: ${safety?.risks?.[0] || 'unknown risk'}`);
          continue;
        }
      }

      // Execute buy
      const cash = await getState('portfolio:cash');
      const buyAmount = cash * profile.risk.maxPositionPct;
      if (buyAmount < 1) continue;

      await buyToken(token.mint, buyAmount);
    }
  });

  // Health heartbeat
  healthInterval = setInterval(async () => {
    await reportHealth('online', 'Listening for signals');
  }, 10000);

  await reportHealth('online', 'Started');
  log('[EXECUTION] Listener started');
  return true;
}

export async function buyToken(address, amountUsd) {
  try {
    const price = await getCurrentPrice(address);
    if (!price || price <= 0) {
      error(`[EXECUTION] Cannot buy ${address}: no price data`);
      return null;
    }

    const profile = await getState('profiles:active') || {};
    const risk = profile.risk || {};

    // Check liquidity threshold
    if (risk.minLiquidityUsd) {
      // Would check liquidity here via dexscreener pair data
      // Skipping for now - discovery already filters
    }

    const tokenAmount = amountUsd / price;
    const cash = await getState('portfolio:cash');

    if (amountUsd > cash) {
      error(`[EXECUTION] Insufficient cash: need $${amountUsd}, have $${cash}`);
      return null;
    }

    // Deduct cash
    await setState('portfolio:cash', cash - amountUsd);

    // Create position
    const position = {
      address,
      entryPrice: price,
      tokenAmount,
      costUsd: amountUsd,
      openedAt: new Date().toISOString(),
      stopLoss: price * (1 - (risk.hardStopLossPct || 0.15)),
      trailingStop: price * (1 + (risk.trailingStopPct || 0.10)),
      highestPrice: price,
      status: 'open',
    };

    await setState(`${POSITION_PREFIX}${address}`, position);

    // Update position keys
    const positionKeys = await getState('portfolio:positionKeys') || [];
    positionKeys.push(address);
    await setState('portfolio:positionKeys', positionKeys);

    // Record trade
    const trade = {
      type: 'buy',
      address,
      price,
      tokenAmount,
      costUsd: amountUsd,
      timestamp: new Date().toISOString(),
    };
    await addToList('portfolio:history', trade, 2000);

    if (config.paperTrading) {
      log(`[EXECUTION] [PAPER] Bought ${tokenAmount.toFixed(4)} of ${address} at $${price} (cost: $${amountUsd.toFixed(2)})`);
    } else {
      log(`[EXECUTION] Bought ${tokenAmount.toFixed(4)} of ${address} at $${price} (cost: $${amountUsd.toFixed(2)})`);
    }

    await publish('execution:trade', trade);
    return position;
  } catch (err) {
    error(`[EXECUTION] Buy failed for ${address}:`, err.message);
    return null;
  }
}

export async function sellToken(address) {
  try {
    const position = await getState(`${POSITION_PREFIX}${address}`);
    if (!position) {
      error(`[EXECUTION] No position found for ${address}`);
      return null;
    }

    const price = await getCurrentPrice(address);
    if (!price || price <= 0) {
      error(`[EXECUTION] Cannot sell ${address}: no price data`);
      return null;
    }

    const proceeds = position.tokenAmount * price;
    const pnl = proceeds - position.costUsd;
    const pnlPct = (pnl / position.costUsd) * 100;

    // Add proceeds to cash
    const cash = await getState('portfolio:cash');
    await setState('portfolio:cash', cash + proceeds);

    // Remove position
    await deleteKey(`${POSITION_PREFIX}${address}`);

    // Update position keys
    const positionKeys = await getState('portfolio:positionKeys') || [];
    const updatedKeys = positionKeys.filter(k => k !== address);
    await setState('portfolio:positionKeys', updatedKeys);

    // Record trade
    const trade = {
      type: 'sell',
      address,
      price,
      tokenAmount: position.tokenAmount,
      proceedsUsd: proceeds,
      pnl,
      pnlPct,
      timestamp: new Date().toISOString(),
    };
    await addToList('portfolio:history', trade, 2000);

    if (config.paperTrading) {
      log(`[EXECUTION] [PAPER] Sold ${position.tokenAmount.toFixed(4)} of ${address} at $${price} (proceeds: $${proceeds.toFixed(2)}, PnL: $${pnl.toFixed(2)} / ${pnlPct.toFixed(2)}%)`);
    } else {
      log(`[EXECUTION] Sold ${position.tokenAmount.toFixed(4)} of ${address} at $${price} (proceeds: $${proceeds.toFixed(2)}, PnL: $${pnl.toFixed(2)} / ${pnlPct.toFixed(2)}%)`);
    }

    await publish('execution:trade', trade);
    return trade;
  } catch (err) {
    error(`[EXECUTION] Sell failed for ${address}:`, err.message);
    return null;
  }
}

export async function getAllPositions() {
  const positionKeys = await getState('portfolio:positionKeys') || [];
  const positions = [];

  for (const key of positionKeys) {
    const pos = await getState(`${POSITION_PREFIX}${key}`);
    if (pos) {
      const currentPrice = await getCurrentPrice(key);
      positions.push({
        ...pos,
        currentPrice: currentPrice || null,
        currentValue: currentPrice ? pos.tokenAmount * currentPrice : null,
        unrealizedPnl: currentPrice ? (pos.tokenAmount * currentPrice) - pos.costUsd : null,
        unrealizedPnlPct: currentPrice ? (((pos.tokenAmount * currentPrice) - pos.costUsd) / pos.costUsd) * 100 : null,
      });
    }
  }

  return positions;
}

export async function getPortfolioSummary() {
  const cash = await getState('portfolio:cash') || 0;
  const positions = await getAllPositions();
  const positionsValue = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
  const totalValue = cash + positionsValue;
  const totalCost = positions.reduce((sum, p) => sum + p.costUsd, 0);
  const unrealizedPnl = positionsValue - totalCost;

  return {
    cash,
    positionsValue,
    totalValue,
    positionCount: positions.length,
    unrealizedPnl,
    unrealizedPnlPct: totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0,
  };
}

export function stopExecution() {
  listenerActive = false;
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  reportHealth('offline', 'Stopped');
  log('[EXECUTION] Stopped');
}