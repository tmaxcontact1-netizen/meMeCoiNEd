import { publish, addToList } from './redis.js';

const LOG_CHANNEL = 'logs:activity';
const LOG_PREFIX = 'bot';

export function formatLog(severity, ...args) {
  const timestamp = new Date().toISOString();
  const message = args
    .map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
    .join(' ');

  return {
    timestamp,
    severity,
    message,
  };
}

export async function log(...args) {
  const entry = formatLog('INFO', ...args);
  await addToList(LOG_CHANNEL, entry, 2000);
  await publish(LOG_CHANNEL, entry);
  console.log(`[${entry.timestamp}] [${LOG_PREFIX}] ${entry.message}`);
}

export async function warn(...args) {
  const entry = formatLog('WARN', ...args);
  await addToList(LOG_CHANNEL, entry, 2000);
  await publish(LOG_CHANNEL, entry);
  console.warn(`[${entry.timestamp}] [${LOG_PREFIX}] ${entry.message}`);
}

export async function error(...args) {
  const errorObj = args.find(a => a instanceof Error);
  const entry = formatLog('ERROR', ...args);
  const entryWithStack = {
    ...entry,
    message: args.map(a => a instanceof Error ? `${a.message}\n${a.stack}` : a).join(' '),
    stack: errorObj?.stack || null,
  };
  await addToList(LOG_CHANNEL, entryWithStack, 2000);
  await publish(LOG_CHANNEL, entryWithStack);
  console.error(`[${entry.timestamp}] [${LOG_PREFIX}] ${entry.message}`);
}

export async function debug(...args) {
  const entry = formatLog('DEBUG', ...args);
  await addToList(LOG_CHANNEL, entry, 2000);
  await publish(LOG_CHANNEL, entry);
  console.debug(`[${entry.timestamp}] [${LOG_PREFIX}] ${entry.message}`);
}

export async function clearLogs() {
  const { deleteKey } = await import('./redis.js');
  await deleteKey(LOG_CHANNEL);
}

export async function getLogs(page = 1, pageSize = 50) {
  const { getList } = await import('./redis.js');
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;
  const logs = await getList(LOG_CHANNEL);
  const total = logs.length;
  const pageLogs = logs.slice(Math.max(0, total - end - 1), Math.max(0, total - start)).reverse();
  return {
    logs: pageLogs,
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };
}