import dotenv from 'dotenv';
dotenv.config();

const env = process.env;

const config = {
  redis: {
    url: env.REDIS_URL || 'redis://localhost:6379',
  },
   wallet: {
    privateKey: env.WALLET_PRIVATE_KEY || '',
    publicKey: env.WALLET_PUBLIC_KEY || '',
  },
  paperTrading: env.PAPER_TRADING === 'true',

  telegram: {
    active: env.TELEGRAM_ACTIVE === 'true',
    apiId: env.TELEGRAM_API_ID || '',
    apiHash: env.TELEGRAM_API_HASH || '',
  },

  reddit: {
    active: env.REDDIT_ACTIVE === 'true',
    clientId: env.REDDIT_CLIENT_ID || '',
    clientSecret: env.REDDIT_CLIENT_SECRET || '',
  },

  twitter: {
    active: env.TWITTER_ACTIVE === 'true',
    bearerToken: env.TWITTER_BEARER_TOKEN || '',
  },

  birdeye: {
    apiKey: env.BIRDEYE_API_KEY || '',
  },

  dexscreener: {
    baseUrl: env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com',
  },

  helius: {
    rpcUrl: env.HELIUS_RPC_URL || '',
  },

  discord: {
    active: env.DISCORD_ACTIVE === 'false' ? false : env.DISCORD_ACTIVE === 'true',
    botToken: env.DISCORD_BOT_TOKEN || '',
    clientId: env.DISCORD_CLIENT_ID || '',
  },

  dashboard: {
    port: 3000,
  },
};

export function validateConfig(selectedServices) {
  const errors = [];

  if (!config.wallet.privateKey) {
    errors.push('WALLET_PRIVATE_KEY is required');
  }

  if (!config.redis.url) {
    errors.push('REDIS_URL is required');
  }

  if (selectedServices.includes('telegram')) {
    if (config.telegram.active) {
      if (!config.telegram.apiId) errors.push('TELEGRAM_API_ID is required when Telegram is active');
      if (!config.telegram.apiHash) errors.push('TELEGRAM_API_HASH is required when Telegram is active');
    }
  }

  if (selectedServices.includes('reddit') && config.reddit.active) {
    if (!config.reddit.clientId) errors.push('REDDIT_CLIENT_ID is required when Reddit is active');
    if (!config.reddit.clientSecret) errors.push('REDDIT_CLIENT_SECRET is required when Reddit is active');
  }

  if (selectedServices.includes('twitter') && config.twitter.active) {
    if (!config.twitter.bearerToken) errors.push('TWITTER_BEARER_TOKEN is required when Twitter is active');
  }

  if (selectedServices.includes('discord') && config.discord.active) {
    if (!config.discord.botToken) errors.push('DISCORD_BOT_TOKEN is required when Discord is active');
    if (!config.discord.clientId) errors.push('DISCORD_CLIENT_ID is required when Discord is active');
  }

  return errors;
}

export default config;