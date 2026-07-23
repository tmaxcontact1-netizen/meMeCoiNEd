export function normalizeToken(source, rawData) {
  const normalized = {
    source,
    mint: normalizeAddress(rawData.mint || rawData.address),
    name: rawData.name || 'Unknown',
    symbol: rawData.symbol || '???',
    decimals: rawData.decimals || 9,
    liquidityUsd: normalizeNumber(rawData.liquidityUsd || rawData.liquidity || 0),
    priceUsd: normalizeNumber(rawData.priceUsd || rawData.price || 0),
    volume24h: normalizeNumber(rawData.volume24h || rawData.volume || 0),
    priceChange24h: normalizeNumber(rawData.priceChange24h || rawData.change24h || 0),
    createdAt: normalizeTimestamp(rawData.createdAt || rawData.created_at || rawData.foundedAt),
    holderCount: rawData.holders || rawData.holder_count || 0,
    txCount24h: rawData.tx_count_24h || rawData.transactions24h || 0,
    metadata: rawData.metadata || {},
  };

  // Add source-specific fields
  switch (source) {
    case 'dexscreener':
      normalized.pairAddress = normalizeAddress(rawData.pairAddress);
      normalized.baseToken = rawData.baseToken?.symbol;
      normalized.quoteToken = rawData.quoteToken?.symbol;
      break;
    case 'birdeye':
      normalized.explorer = rawData.explorer;
      normalized.marketCap = normalizeNumber(rawData.market_cap);
      break;
    case 'pumpfun':
      normalized.virtualLiquidityUsd = normalizeNumber(rawData.virtualLiquidityUsd);
      normalized.completed = rawData.completed;
      break;
    default:
      break;
  }

  return normalized;
}

export function normalizeAddress(addr) {
  if (!addr) return '';
  const cleaned = addr.trim();
  if (cleaned.length >= 32 && cleaned.length <= 44) {
    return cleaned;
  }
  return '';
}

export function normalizeNumber(val) {
  if (val === null || val === undefined) return 0;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? 0 : parsed;
}

export function normalizeTimestamp(ts) {
  if (!ts) return null;
  const parsed = typeof ts === 'string' ? Date.parse(ts) : parseInt(ts);
  return isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function calculateVelocity(normalizedToken, timeWindowMinutes = 60) {
  const now = Date.now();
  const windowStart = now - timeWindowMinutes * 60 * 1000;

  const ageMs = normalizedToken.createdAt
    ? now - new Date(normalizedToken.createdAt).getTime()
    : 0;

  const hourlyTx = normalizedToken.txCount24h / 24;
  const socialVelocity = hourlyTx;

  return {
    ageMinutes: ageMs / 60000,
    hourlyTransactions: hourlyTx,
    velocityScore: socialVelocity,
  };
}

export function filterByProfile(tokens, profile) {
  return tokens.filter(t => {
    if (!profile || !profile.risk) return true;

    const { risk } = profile;

    if (risk.minLiquidityUsd && t.liquidityUsd < risk.minLiquidityUsd) return false;
    if (risk.maxTokenAgeHours && t.createdAt) {
      const ageHours = (Date.now() - new Date(t.createdAt).getTime()) / 3600000;
      if (ageHours > risk.maxTokenAgeHours) return false;
    }
    if (risk.minSentimentScore && t.sentimentScore && t.sentimentScore < risk.minSentimentScore) return false;

    return true;
  });
}

export function rankByScore(tokens, weightConfig) {
  const weights = weightConfig || {
    liquidity: 0.2,
    volume: 0.3,
    priceChange: 0.2,
    velocity: 0.3,
  };

  const maxLiq = Math.max(...tokens.map(t => t.liquidityUsd || 1));
  const maxVol = Math.max(...tokens.map(t => t.volume24h || 1));
  const maxVel = Math.max(...tokens.map(t => t.txCount24h || 1));

  return tokens
    .map(t => ({
      ...t,
      score: (
        ((t.liquidityUsd / maxLiq) * weights.liquidity) +
        ((t.volume24h / maxVol) * weights.volume) +
        ((t.priceChange24h / 100) * weights.priceChange) +
        ((t.txCount24h / maxVel) * weights.velocity)
      ) * 100,
    }))
    .sort((a, b) => b.score - a.score);
}