import axios from 'axios';
import { log, error } from '../shared/logger.js';
import { setState } from '../shared/redis.js';
import config from '../config/index.js';

const TWITTER_BASE = 'https://api.twitter.com/2';
let pollInterval = null;
let monitoredTerms = [];
let bearerToken = null;

async function searchTweets(term, token) {
  try {
    const resp = await axios.get(`${TWITTER_BASE}/tweets/search/recent`, {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        query: `${term} (cashtag OR hashtag) -is:retweet`,
        'tweet.fields': 'created_at,public_metrics,author_id',
        max_results: 50,
      },
    });

    const tweets = resp.data?.data || [];
    return tweets.map(t => ({
      source: 'twitter',
      term,
      text: t.text,
      authorId: t.author_id,
      createdAt: t.created_at,
      metrics: t.public_metrics,
    }));
  } catch (err) {
    error(`[TWITTER] Search failed for "${term}": ${err.message}`);
    return [];
  }
}

export async function startTwitterStream(terms) {
  if (!config.twitter.active) {
    log('[TWITTER] Service inactive, skipping start');
    return false;
  }

  bearerToken = config.twitter.bearerToken;
  if (!bearerToken) {
    error('[TWITTER] No bearer token configured');
    return false;
  }

  monitoredTerms = terms || ['$SOL', 'memecoin', 'pumpfun'];
  log(`[TWITTER] Streaming started for ${monitoredTerms.length} terms`);

  pollInterval = setInterval(async () => {
    for (const term of monitoredTerms) {
      const tweets = await searchTweets(term, bearerToken);
      if (tweets.length > 0) {
        await setState(`sentiment:twitter:${term}`, tweets, 3600);
        log(`[TWITTER] Collected ${tweets.length} tweets for "${term}"`);
      }
    }
  }, 60000);

  return true;
}

export function stopTwitterStream() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log('[TWITTER] Stream stopped');
  }
}

export async function getTwitterSentiment(term) {
  return await getState(`sentiment:twitter:${term}`);
}