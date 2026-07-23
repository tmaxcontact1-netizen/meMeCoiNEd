import axios from 'axios';
import { log, error } from '../shared/logger.js';
import { setState } from '../shared/redis.js';
import config from '../config/index.js';

const REDDIT_BASE = 'https://www.reddit.com';
let pollInterval = null;
let monitoredSubreddits = [];

async function fetchRedditToken() {
  if (!config.reddit.clientId || !config.reddit.clientSecret) {
    throw new Error('Reddit credentials not configured');
  }

  const resp = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'meMeCoiNEd/2.0',
      },
      auth: {
        username: config.reddit.clientId,
        password: config.reddit.clientSecret,
      },
    }
  );

  return resp.data.access_token;
}

async function pollSubreddit(subreddit, token) {
  try {
    const resp = await axios.get(`${REDDIT_BASE}/r/${subreddit}/new.json?limit=25`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'meMeCoiNEd/2.0',
      },
    });

    const posts = resp.data?.data?.children || [];
    const mentions = [];

    for (const post of posts) {
      const data = post.data;
      mentions.push({
        source: 'reddit',
        subreddit,
        title: data.title,
        body: data.selftext || '',
        score: data.score,
        numComments: data.num_comments,
        createdUtc: data.created_utc,
        permalink: `https://reddit.com${data.permalink}`,
      });
    }

    return mentions;
  } catch (err) {
    error(`[REDDIT] Failed to poll r/${subreddit}: ${err.message}`);
    return [];
  }
}

export async function startRedditPolling(subreddits) {
  if (!config.reddit.active) {
    log('[REDDIT] Service inactive, skipping start');
    return false;
  }

  if (!subreddits || subreddits.length === 0) {
    monitoredSubreddits = ['CryptoCurrency', 'Solana', 'CryptoMoonShots'];
  } else {
    monitoredSubreddits = subreddits;
  }

  try {
    const token = await fetchRedditToken();
    log(`[REDDIT] Token acquired, polling ${monitoredSubreddits.length} subreddits`);

    pollInterval = setInterval(async () => {
      for (const sub of monitoredSubreddits) {
        const mentions = await pollSubreddit(sub, token);
        if (mentions.length > 0) {
          await setState(`sentiment:reddit:${sub}`, mentions, 3600);
          log(`[REDDIT] Polled r/${sub}: ${mentions.length} new posts`);
        }
      }
    }, 60000);

    return true;
  } catch (err) {
    error('[REDDIT] Failed to start polling:', err.message);
    return false;
  }
}

export function stopRedditPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log('[REDDIT] Polling stopped');
  }
}

export async function getRedditSentiment(subreddit) {
  return await getState(`sentiment:reddit:${subreddit}`);
}