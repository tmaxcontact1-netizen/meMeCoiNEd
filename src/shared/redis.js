import { createClient } from 'redis';
import config from '../config/index.js';

let client = null;
let subscribers = [];

export async function connectRedis() {
  if (client) return client;

  client = createClient({
    url: config.redis.url,
  });

  client.on('error', (err) => {
    console.error('[REDIS] Connection error:', err.message);
  });

  await client.connect();
  return client;
}

export async function getState(key) {
  const conn = await connectRedis();
  const value = await conn.get(key);
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return value;
  }
}

export async function setState(key, value, ttl = null) {
  const conn = await connectRedis();
  if (typeof value === 'object') {
    value = JSON.stringify(value);
  }
  if (ttl) {
    await conn.setEx(key, ttl, value);
  } else {
    await conn.set(key, value);
  }
}

export async function deleteKey(key) {
  const conn = await connectRedis();
  await conn.del(key);
}

export async function getList(key) {
  const conn = await connectRedis();
  const values = await conn.lRange(key, 0, -1);
  return values.map(v => {
    try { return JSON.parse(v); } catch { return v; }
  });
}

export async function addToList(key, item, maxLen = null) {
  const conn = await connectRedis();
  if (typeof item === 'object') {
    item = JSON.stringify(item);
  }
  await conn.rPush(key, item);
  
  if (maxLen) {
    const len = await conn.llen(key);
    if (len > maxLen) {
      await conn.lTrim(key, len - maxLen, -1);
    }
  }
}

export async function removeFromList(key, value) {
  const conn = await connectRedis();
  if (typeof value === 'object') {
    value = JSON.stringify(value);
  }
  await conn.lRem(key, 0, value);
}

export async function publish(channel, message) {
  const conn = await connectRedis();
  if (typeof message === 'object') {
    message = JSON.stringify(message);
  }
  await conn.publish(channel, message);
}

export async function subscribe(channel, callback) {
  const conn = await connectRedis();
  await conn.subscribe(channel, (msg) => {
    try {
      callback(JSON.parse(msg));
    } catch {
      callback(msg);
    }
  });
  
  // Track subscriber for cleanup
  const unsubHandler = () => conn.unsubscribe(channel);
  subscribers.push(unsubHandler);
  return unsubHandler;
}

export async function publishAndReceive(channel, message, responseChannel, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`Timeout waiting for ${responseChannel}`)), timeoutMs);
    
    subscribe(responseChannel, (data) => {
      resolve(data);
    });
    
    publish(channel, message);
  });
}

export async function disconnectRedis() {
  if (!client) return;
  await Promise.all(subscribers.map(fn => fn()));
  subscribers = [];
  await client.quit();
  client = null;
}

export function getClient() {
  return client;
}