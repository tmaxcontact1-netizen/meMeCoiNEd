import axios from 'axios';
import { log, error, debug } from '../shared/logger.js';
import { getState, setState, publish } from '../shared/redis.js';
import config from '../config/index.js';

const SOLANA_RPC = config.helius.rpcUrl;
const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1';

let healthInterval = null;
let listenerActive = false;

async function reportHealth(status, message = '') {
  const current = await getState('service:health') || {};
  current['rug-check'] = { status, message, timestamp: Date.now() };
  await setState('service:health', current);
  await publish('service:health', current);
}

export async function checkTokenSafety(tokenAddress) {
  try {
    const cached = await getState(`rugcheck:${tokenAddress}`);
    if (cached && (Date.now() - cached.timestamp) < 300000) {
      debug(`[RUG-CHECK] Returning cached result for ${tokenAddress}`);
      return cached.result;
    }

    const [rugcheckResult, holderResult] = await Promise.all([
      fetchRugCheckReport(tokenAddress),
      fetchHolderDistribution(tokenAddress),
    ]);

    const result = {
      address: tokenAddress,
      safe: false,
      score: 0,
      risks: [],
      warnings: [],
      checks: {},
      timestamp: Date.now(),
    };

    if (rugcheckResult) {
      result.checks.rugcheck = rugcheckResult;

      if (rugcheckResult.risks) {
        const criticalRisks = rugcheckResult.risks.filter(r => r.severity === 'critical');
        const highRisks = rugcheckResult.risks.filter(r => r.severity === 'high');

        if (criticalRisks.length > 0) {
          result.risks.push(...criticalRisks.map(r => `CRITICAL: ${r.name} - ${r.description}`));
        }
        if (highRisks.length > 0) {
          result.warnings.push(...highRisks.map(r => `HIGH: ${r.name} - ${r.description}`));
        }
      }

      if (rugcheckResult.score) {
        result.score += rugcheckResult.score;
      }

      if (rugcheckResult.mint_authority === true) {
        result.risks.push('Mint authority is enabled');
      }

      if (rugcheckResult.freeze_authority === true) {
        result.risks.push('Freeze authority is enabled');
      }

      if (rugcheckResult.lp_locked === false) {
        result.warnings.push('LP not locked');
      }
    }

    if (holderResult) {
      result.checks.holders = holderResult;

      const topHolderPct = holderResult.topHolders?.[0]?.percentage || 0;
      const top10Pct = holderResult.topHolders?.slice(0, 10).reduce((sum, h) => sum + (h.percentage || 0), 0) || 0;

      if (topHolderPct > 50) {
        result.risks.push(`Top holder owns ${topHolderPct.toFixed(1)}% of supply`);
      } else if (topHolderPct > 20) {
        result.warnings.push(`Top holder owns ${topHolderPct.toFixed(1)}% of supply`);
      }

      if (top10Pct > 80) {
        result.warnings.push(`Top 10 holders own ${top10Pct.toFixed(1)}% of supply`);
      }

      result.checks.topHolderPct = topHolderPct;
      result.checks.top10Pct = top10Pct;
    }

    result.safe = result.risks.length === 0;
    result.score = Math.max(0, 100 - (result.risks.length * 30) - (result.warnings.length * 10));

    await setState(`rugcheck:${tokenAddress}`, { result, timestamp: Date.now() }, 300);

    log(`[RUG-CHECK] ${tokenAddress}: ${result.safe ? 'SAFE' : 'UNSAFE'} (score: ${result.score}, risks: ${result.risks.length}, warnings: ${result.warnings.length})`);

    return result;
  } catch (err) {
    error(`[RUG-CHECK] Failed to check ${tokenAddress}:`, err.message);
    return {
      address: tokenAddress,
      safe: false,
      score: 0,
      risks: ['Safety check failed'],
      warnings: [],
      timestamp: Date.now(),
    };
  }
}

async function fetchRugCheckReport(tokenAddress) {
  try {
    const resp = await axios.get(`${RUGCHECK_BASE}/tokens/${tokenAddress}/report/summary`);
    return resp.data || null;
  } catch (err) {
    debug(`[RUG-CHECK] RugCheck.xyz report failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

async function fetchHolderDistribution(tokenAddress) {
  try {
    const resp = await axios.post(SOLANA_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [tokenAddress],
    });

    const accounts = resp.data?.result?.value || [];

    const totalSupply = accounts.reduce((sum, a) => sum + BigInt(a.amount), BigInt(0));
    if (totalSupply === BigInt(0)) return null;

    const topHolders = accounts.slice(0, 20).map(a => ({
      address: a.address,
      amount: a.amount,
      percentage: (Number(BigInt(a.amount) * BigInt(10000) / totalSupply) / 100),
    }));

    return {
      topHolders,
      holderCount: accounts.length,
    };
  } catch (err) {
    debug(`[RUG-CHECK] Holder distribution failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

export async function startRugCheckListener() {
  if (listenerActive) {
    log('[RUG-CHECK] Already running');
    return false;
  }

  listenerActive = true;

  healthInterval = setInterval(async () => {
    await reportHealth('online', 'Listening for new tokens');
  }, 10000);

  await reportHealth('online', 'Started');
  log('[RUG-CHECK] Listener started');
  return true;
}

export function stopRugCheck() {
  listenerActive = false;
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  log('[RUG-CHECK] Stopped');
}