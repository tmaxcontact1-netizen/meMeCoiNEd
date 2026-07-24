import axios from 'axios';
import { log, error } from '../shared/logger.js';
import config from '../config/index.js';

const JUPITER_BASE = 'https://api.jup.ag';

export async function getQuote(inputMint, outputMint, amount) {
  try {
    const resp = await axios.get(`${JUPITER_BASE}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: 100,
      },
    });
    return resp.data || null;
  } catch (err) {
    error(`[JUPITER] Quote failed: ${err.message}`);
    return null;
  }
}

export async function getSwapTransaction(inputMint, outputMint, amount, quoteResponse) {
  if (!config.wallet.publicKey) {
    error('[JUPITER] Cannot create swap transaction: WALLET_PUBLIC_KEY not configured');
    return null;
  }

  try {
    const resp = await axios.post(`${JUPITER_BASE}/swap`, {
      quoteResponse,
      userPublicKey: config.wallet.publicKey,
      wrapAndUnwrapSol: true,
    });
    return resp.data?.swapTransaction || null;
  } catch (err) {
    error(`[JUPITER] Swap transaction failed: ${err.message}`);
    return null;
  }
}

export async function searchTokens(query) {
  try {
    const resp = await axios.get(`${JUPITER_BASE}/token/search`, {
      params: { q: query },
    });
    return resp.data?.tokens || [];
  } catch (err) {
    error(`[JUPITER] Token search failed: ${err.message}`);
    return [];
  }
}

export async function getTokenMetadata(tokenAddress) {
  try {
    const resp = await axios.get(`${JUPITER_BASE}/token/${tokenAddress}`);
    return resp.data || null;
  } catch (err) {
    error(`[JUPITER] Failed to get token metadata: ${err.message}`);
    return null;
  }
}