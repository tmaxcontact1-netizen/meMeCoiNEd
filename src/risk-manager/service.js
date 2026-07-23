import { log, error, debug } from '../shared/logger.js';
import { getState, setState } from '../shared/redis.js';
import { sellToken, getAllPositions } from '../execution/service.js';
import { getCurrentPrice } from '../market-data/dexscreener.js';

let monitoringInterval = null;
let listenerActive = false;

export async function initRiskManager() {
  try {
    log('[RISK] Initialized');
    return true;
  } catch (err) {
    error('[RISK] Init failed:', err.message);
    return false;
  }
}

async function checkPositionStopLoss(position, currentPrice) {
  const { risk } = await getState('profiles:active') || { risk: {} };
  const hardStop = position.stopLoss || 0;
  const trailingStop = position.trailingStop || 0;

  // Hard stop loss
  if (currentPrice <= hardStop) {
    return {
      triggered: true,
      reason: 'hard_stop',
      stopPrice: hardStop,
      currentPrice,
      pnlPct: ((currentPrice - position.entryPrice) / position.entryPrice) * 100,
    };
  }

  // Trailing stop (locks in profits when price drops from peak)
  if (currentPrice < trailingStop && currentPrice < position.highestPrice * 0.9) {
    return {
      triggered: true,
      reason: 'trailing_stop',
      stopPrice: trailingStop,
      currentPrice,
      pnlPct: ((currentPrice - position.entryPrice) / position.entryPrice) * 100,
    };
  }

  // Update highest price and trailing stop if profitable
  if (currentPrice > position.highestPrice) {
    const newHighest = currentPrice;
    const newTrailingStop = newHighest * (1 - (risk.trailingStopPct || 0.10));
    
    const updated = {
      ...position,
      highestPrice: newHighest,
      trailingStop: newTrailingStop,
    };
    
    await setState(`position:${position.address}`, updated);
    debug(`[RISK] Updated trailing stop for ${position.address}: $${newTrailingStop.toFixed(6)}`);
  }

  return { triggered: false };
}

async function checkAllPositions() {
  const positions = await getAllPositions();
  
  for (const pos of positions) {
    if (!pos.currentPrice || pos.currentPrice <= 0) {
      debug(`[RISK] No price data for ${pos.address}, skipping`);
      continue;
    }

    const check = await checkPositionStopLoss(pos, pos.currentPrice);
    
    if (check.triggered) {
      log(`[RISK] Stop triggered for ${pos.address}: ${check.reason} at $${check.stopPrice.toFixed(6)} (PnL: ${check.pnlPct.toFixed(2)}%)`);
      await sellToken(pos.address);
    }
  }
}

export async function startRiskMonitoring() {
  if (monitoringInterval) {
    log('[RISK] Already running');
    return false;
  }

  const profile = await getState('profiles:active');
  const checkInterval = profile?.intervals?.positionCheck || 2000;

  // Initial check
  await checkAllPositions();

  // Continuous monitoring
  monitoringInterval = setInterval(async () => {
    await checkAllPositions();
  }, checkInterval);

  listenerActive = true;
  log(`[RISK] Started position monitoring (${checkInterval}ms interval)`);
  return true;
}

export async function checkConcurrentPositionLimit() {
  const profile = await getState('profiles:active');
  const maxPositions = profile?.risk?.maxConcurrentPositions || 20;
  const positionKeys = await getState('portfolio:positionKeys') || [];

  if (positionKeys.length >= maxPositions) {
    debug(`[RISK] Position limit reached: ${positionKeys.length}/${maxPositions}`);
    return false;
  }

  return true;
}

export async function enforceLiquidityThreshold(tokenAddress) {
  // This would ideally be called before buying
  // For now, just a placeholder that returns true
  // Full implementation would fetch pair data from dexscreener
  
  return true;
}

export async function calculatePositionSize(tokenAddress, targetPercentage) {
  const portfolio = await getPortfolioSummary();
  const availableCash = portfolio.cash;
  const riskConfig = (await getState('profiles:active'))?.risk || {};
  
  const maxAllowed = availableCash * (targetPercentage || riskConfig.maxPositionPct || 0.10);
  
  return {
    availableCash,
    maxUsd: maxAllowed,
    percentage: targetPercentage || (maxAllowed / availableCash) * 100,
  };
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

export async function updateTrailingStops() {
  const positions = await getAllPositions();
  const { risk } = await getState('profiles:active') || { risk: {} };
  const trailingStopPct = risk.trailingStopPct || 0.10;

  for (const pos of positions) {
    const currentPrice = await getCurrentPrice(pos.address);
    if (!currentPrice || currentPrice <= 0) continue;

    if (currentPrice > pos.highestPrice) {
      const updated = {
        ...pos,
        highestPrice: currentPrice,
        trailingStop: currentPrice * (1 - trailingStopPct),
      };
      
      await setState(`position:${pos.address}`, updated);
      debug(`[RISK] Updated trailing stop for ${pos.address}: $${updated.trailingStop.toFixed(6)}`);
    }
  }
}

export function stopRiskManager() {
  listenerActive = false;
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  log('[RISK] Stopped');
}