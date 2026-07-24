import { log, error, debug } from './shared/logger.js';
import { connectRedis, disconnectRedis, getState, setState, publish, subscribe } from './shared/redis.js';
import config from './config/index.js';
import { validateConfig } from './config/index.js';
import { startDashboard } from './dashboard/server.js';
import fs from 'fs';

// PID lock to prevent duplicate instances
const PID_FILE = '/home/tmax/meMeCoiNEd_v2/bot.pid';

async function acquirePidLock() {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    try {
      process.kill(oldPid, 0); // Check if process exists
      error('[BOOT] Another instance is running (PID ' + oldPid + '). Exiting.');
      process.exit(1);
    } catch {
      // Old process dead, remove stale lock
      fs.unlinkSync(PID_FILE);
      log('[BOOT] Removed stale PID lock');
    }
  }
  fs.writeFileSync(PID_FILE, process.pid.toString());
  log(`[BOOT] Acquired PID lock: ${process.pid}`);
}

function releasePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      log('[BOOT] Released PID lock');
    }
  } catch (err) {
    error('[BOOT] Failed to release PID lock:', err.message);
  }
}

async function spawnTelegramSidecar() {
  const { active: tgActive, apiId, apiHash } = config.telegram;
  
  if (!tgActive || !apiId || !apiHash) {
    log('[BOOT] Telegram not configured or disabled, skipping');
    return false;
  }
  
  try {
    const { spawn } = await import('child_process');
    const proc = spawn('python3', ['src/sentiment/telegram.py'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    proc.stdout.on('data', (d) => log('[TELEGRAM] ' + d.toString().trim()));
    proc.stderr.on('data', (d) => error('[TELEGRAM] ' + d.toString().trim()));
    
    // Handle process exit
    proc.on('exit', (code) => {
      log(`[TELEGRAM] Sidecar exited with code ${code}`);
    });
    
    await setState('telegram:sidecar_pid', proc.pid);
    await publish('service:health', { telegram: { status: 'online', pid: proc.pid } });
    
    log('[BOOT] Telegram sidecar spawned (PID ' + proc.pid + ')');
    return true;
  } catch (err) {
    error('[BOOT] Failed to spawn Telegram sidecar:', err.message);
    return false;
  }
}

async function initializeDefaultProfiles() {
  try {
    const scalpingExists = await getState('profiles:scalping');
    const moonshotExists = await getState('profiles:moonshot');
    
    if (!scalpingExists) {
      await setState('profiles:scalping', {
        name: 'scalping',
        risk: {
          maxPositionPct: 0.10,
          maxConcurrentPositions: 20,
          hardStopLossPct: 0.15,
          trailingStopPct: 0.10,
          minLiquidityUsd: 50000,
          maxTokenAgeHours: 24,
          minSocialVelocityPerHour: 10,
          minSentimentScore: 0.2,
        },
        execution: {
          slippageBps: 150,
          priorityFeeLamports: 100000,
        },
        intervals: {
          marketData: 3000,
          trending: 10000,
          positionCheck: 2000,
        },
      });
      log('[BOOT] Created default scalping profile');
    }
    
    if (!moonshotExists) {
      await setState('profiles:moonshot', {
        name: 'moonshot',
        risk: {
          maxPositionPct: 0.05,
          maxConcurrentPositions: 5,
          hardStopLossPct: 0.50,
          trailingStopPct: 0.25,
          minLiquidityUsd: 25000,
          maxTokenAgeHours: 4,
          minSocialVelocityPerHour: 50,
          minSentimentScore: 0.4,
        },
        execution: {
          slippageBps: 500,
          priorityFeeLamports: 200000,
        },
        intervals: {
          marketData: 1000,
          trending: 5000,
          positionCheck: 1000,
        },
      });
      log('[BOOT] Created default moonshot profile');
    }
    
    // Set active profile to scalping if none selected
    const activeProfile = await getState('profiles:active');
    if (!activeProfile) {
      const scalping = await getState('profiles:scalping');
      await setState('profiles:active', scalping);
      log('[BOOT] Set active profile to scalping');
    }
    
    return true;
  } catch (err) {
    error('[BOOT] Failed to initialize default profiles:', err.message);
    return false;
  }
}

async function registerPubSubChannels() {
  try {
    const channels = [
      'service:health',
      'execution:trade',
      'discovery:new',
      'discovery:trending',
      'sentiment:buzz',
      'telegram:auth:update',
      'logs:activity',
    ];
    
    for (const channel of channels) {
      log(`[BOOT] Registered pub/sub channel: ${channel}`);
    }
    
    return true;
  } catch (err) {
    error('[BOOT] Failed to register channels:', err.message);
    return false;
  }
}

async function bootServices(selectedServices = []) {
  const bootStatus = {
    success: false,
    services: {},
    errors: [],
  };
  
  try {
    // Validate config for selected services
    const validationErrors = validateConfig(selectedServices);
    if (validationErrors.length > 0) {
      bootStatus.errors.push(...validationErrors);
      log('[BOOT] Validation errors:', validationErrors.join(', '));
      await setState('boot:status', { running: false, errors: bootStatus.errors });
      return bootStatus;
    }
    
    // Spawn Telegram sidecar if enabled
    if (selectedServices.includes('telegram')) {
      const spawned = await spawnTelegramSidecar();
      bootStatus.services.telegram = spawned ? 'online' : 'failed';
      if (!spawned) {
        bootStatus.errors.push('Failed to spawn Telegram sidecar');
      }
    }
    
    // Import and start services
    const { initExecution, startExecutionListener } = await import('./execution/service.js');
    const { startDiscoveryLoop } = await import('./discovery/service.js');
    const { initRiskManager, startRiskMonitoring } = await import('./risk-manager/service.js');
    const { initRugCheck, startRugCheckListener } = await import('./rug-check/service.js');
    const { initSentiment, startSentimentAggregation, startRedditPolling, startTwitterStream, startDiscordListening } = await import('./sentiment/service.js');
    
    // Initialize all services
    await initExecution();
    await initRiskManager();
    await initRugCheck();
    await initSentiment();
    
    // Start each requested service
    for (const service of selectedServices) {
      switch (service) {
        case 'execution-listener': {
          const started = await startExecutionListener();
          bootStatus.services['execution-listener'] = started ? 'online' : 'failed';
          break;
        }
        case 'discovery': {
          const started = await startDiscoveryLoop();
          bootStatus.services.discovery = started ? 'online' : 'failed';
          break;
        }
        case 'risk': {
          const started = await startRiskMonitoring();
          bootStatus.services.risk = started ? 'online' : 'failed';
          break;
        }
        case 'rug-check': {
          const started = await startRugCheckListener();
          bootStatus.services['rug-check'] = started ? 'online' : 'failed';
          break;
        }
        case 'sentiment': {
          const started = await startSentimentAggregation();
          bootStatus.services.sentiment = started ? 'online' : 'failed';
          
          // Start polling for each sentiment source if configured
          if (config.reddit.active) {
            const redditSubs = await getState('config:reddit');
            await startRedditPolling(redditSubs);
            log('[BOOT] Reddit polling started');
          }
          if (config.twitter.active) {
            const twitterTerms = ['$SOL', 'memecoin', 'pumpfun'];
            await startTwitterStream(twitterTerms);
            log('[BOOT] Twitter streaming started');
          }
          if (config.discord.active) {
            const discordServers = await getState('config:discord');
            await startDiscordListening(discordServers);
            log('[BOOT] Discord listening started');
          }
          break;
        }
        default:
          bootStatus.services[service] = { status: 'unknown', message: `Unknown service: ${service}` };
      }
    }
    
    // Publish health status
    bootStatus.success = bootStatus.errors.length === 0;
    bootStatus.running = bootStatus.success;
    bootStatus.timestamp = Date.now();
    
    await setState('boot:status', bootStatus);
    await publish('service:health', bootStatus.services);
    
    return bootStatus;
  } catch (err) {
    bootStatus.errors.push(`Boot error: ${err.message}`);
    await setState('boot:status', { running: false, error: err.message });
    error('[BOOT] Fatal boot error:', err);
    return bootStatus;
  }
}

async function gracefulShutdown(signal) {
  log(`[BOOT] Received ${signal}, initiating graceful shutdown...`);
  
  releasePidLock();
  
  try {
    // Disconnect Redis
    await disconnectRedis();
  } catch (err) {
    error('[BOOT] Error during shutdown:', err.message);
  }
  
  log('[BOOT] Shutdown complete');
  process.exit(0);
}

async function main() {
  try {
    // Acquire PID lock
    await acquirePidLock();
    
    // Setup signal handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      error('[BOOT] Uncaught exception:', err.message, err.stack);
      gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      error('[BOOT] Unhandled rejection:', reason);
    });
    
    // Connect to Redis
    log('[BOOT] Connecting to Redis...');
    await connectRedis();
    log('[BOOT] Connected to Redis');
    
    // Initialize default trading profiles
    log('[BOOT] Initializing default profiles...');
    await initializeDefaultProfiles();
    
    // Register pub/sub channels
    await registerPubSubChannels();
    
    // Start dashboard
    log('[BOOT] Starting dashboard...');
    await startDashboard();
    
    log('[BOOT] ===================================================');
    log('[BOOT] meMeCoiNEd v2.0 ready');
    log('[BOOT] Dashboard: http://localhost:3000');
    log('[BOOT] To start services, POST to /api/boot with { services: [...] }');
    log('[BOOT] Available services: discovery, execution-listener, risk, rug-check, sentiment, telegram');
    log('[BOOT] ===================================================');
    
    // Report initial health
    await setState('boot:status', { running: true, services: { dashboard: 'online' }, startTime: Date.now() });
    await publish('service:health', { dashboard: { status: 'online' } });
    
  } catch (err) {
    error('[BOOT] Fatal startup error:', err);
    process.exit(1);
  }
}

// Run the bot
main();