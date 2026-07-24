import express from 'express';
import { log, error, getLogs } from '../shared/logger.js';
import { getState, setState, getList, publish, deleteKey } from '../shared/redis.js';
import { initExecution, startExecutionListener, stopExecution, getAllPositions, getPortfolioSummary, sellToken } from '../execution/service.js';
import { startDiscoveryLoop, stopDiscovery, getDiscoveredTokens } from '../discovery/service.js';
import { startRiskMonitoring, stopRiskManager } from '../risk-manager/service.js';
import { startRugCheckListener, stopRugCheck } from '../rug-check/service.js';
import { startSentimentAggregation, stopAggregation, } from '../sentiment/service.js';
import config from '../config/index.js';

const app = express();
app.use(express.json());

let healthStatus = {
  running: false,
  services: {},
  startTime: null,
};

// ===================== API ENDPOINTS =====================

// Health
app.get('/api/health', async (req, res) => {
  const portfolio = await getPortfolioSummary();
  const positions = await getAllPositions();
  res.json({
    status: healthStatus.running ? 'running' : 'stopped',
    services: healthStatus.services,
    portfolio,
    positionCount: positions.length,
    uptime: healthStatus.startTime ? Date.now() - healthStatus.startTime : 0,
  });
});

// Boot control
app.post('/api/boot', async (req, res) => {
  const services = req.body.services || [];
  const results = {};

  try {
    healthStatus.running = true;
    healthStatus.startTime = Date.now();
    await setState('boot:status', { running: true, services, startTime: Date.now() }, null);

    await initExecution();
    results.execution = { status: 'ok', message: 'Initialized' };

    for (const service of services) {
      switch (service) {
        case 'discovery':
          results.discovery = await startDiscoveryLoop()
            ? { status: 'ok', message: 'Started discovery loop' }
            : { status: 'fail', message: 'Failed to start discovery' };
          healthStatus.services.discovery = true;
          break;
        case 'execution-listener':
          results['execution-listener'] = await startExecutionListener()
            ? { status: 'ok', message: 'Started execution listener' }
            : { status: 'fail', message: 'Failed to start execution listener' };
          healthStatus.services['execution-listener'] = true;
          break;
        case 'risk':
          results.risk = await startRiskMonitoring()
            ? { status: 'ok', message: 'Started risk monitoring' }
            : { status: 'fail', message: 'Failed to start risk monitoring' };
          healthStatus.services.risk = true;
          break;
        case 'rug-check':
          results['rug-check'] = await startRugCheckListener()
            ? { status: 'ok', message: 'Started rug check listener' }
            : { status: 'fail', message: 'Failed to start rug check' };
          healthStatus.services['rug-check'] = true;
          break;
        case 'sentiment':
          results.sentiment = await startSentimentAggregation()
            ? { status: 'ok', message: 'Started sentiment aggregation' }
            : { status: 'fail', message: 'Failed to start sentiment' };
          healthStatus.services.sentiment = true;
          break;
        default:
          results[service] = { status: 'unknown', message: `Unknown service: ${service}` };
      }
    }

    await setState('service:health', healthStatus.services);
    log(`[DASHBOARD] Boot completed: ${services.length} services started`);
    res.json({ success: true, results, healthStatus });
  } catch (err) {
    error('[DASHBOARD] Boot failed:', err.message);
    healthStatus.running = false;
    await setState('boot:status', { running: false, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// Boot stop
app.post('/api/boot-stop', async (req, res) => {
  try {
    healthStatus.running = false;
    healthStatus.startTime = null;
    await setState('boot:status', { running: false });

    stopDiscovery();
    stopRiskManager();
    stopRugCheck();
    stopAggregation();
    stopExecution();

    healthStatus.services = {};
    await setState('service:health', healthStatus.services);

    log('[DASHBOARD] All services stopped');
    res.json({ success: true, message: 'All services stopped' });
  } catch (err) {
    error('[DASHBOARD] Stop failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Boot status
app.get('/api/boot-status', async (req, res) => {
  const status = await getState('boot:status');
  res.json(status || { running: false, services: {} });
});

// Portfolio
app.get('/api/portfolio', async (req, res) => {
  try {
    const summary = await getPortfolioSummary();
    res.json(summary);
  } catch (err) {
    error('[DASHBOARD] Portfolio fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Positions
app.get('/api/positions', async (req, res) => {
  try {
    const positions = await getAllPositions();
    res.json(positions);
  } catch (err) {
    error('[DASHBOARD] Positions fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trade history (paginated)
app.get('/api/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const history = await getList('portfolio:history');
    const total = history.length;
    const start = Math.max(0, total - page * pageSize);
    const end = Math.max(0, total - (page - 1) * pageSize);

    const trades = history.slice(start, end).reverse();

    // Calculate stats
    const sellTrades = history.filter(t => t.type === 'sell');
    const wins = sellTrades.filter(t => t.pnl > 0);
    const losses = sellTrades.filter(t => t.pnl < 0);
    const totalPnl = sellTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;

    res.json({
      trades,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      stats: {
        totalTrades: sellTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: winRate.toFixed(1),
        totalPnl: totalPnl.toFixed(2),
      },
    });
  } catch (err) {
    error('[DASHBOARD] History fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trading profiles
app.get('/api/profiles', async (req, res) => {
  try {
    const scalping = await getState('profiles:scalping');
    const moonshot = await getState('profiles:moonshot');
    const active = await getState('profiles:active');

    const defaultScalping = {
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
    };

    const defaultMoonshot = {
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
    };

    res.json({
      scalping: scalping || defaultScalping,
      moonshot: moonshot || defaultMoonshot,
      active: active?.name || null,
      activeProfile: active,
    });
  } catch (err) {
    error('[DASHBOARD] Profiles fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Save profile
app.post('/api/profiles/save', async (req, res) => {
  try {
    const { name, profile } = req.body;
    if (!name || !profile) {
      return res.status(400).json({ error: 'Missing name or profile' });
    }
    await setState(`profiles:${name}`, profile, null);
    log(`[DASHBOARD] Saved profile: ${name}`);
    res.json({ success: true });
  } catch (err) {
    error('[DASHBOARD] Profile save failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Apply profile
app.post('/api/profiles/apply', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing profile name' });
    }

    const profile = await getState(`profiles:${name}`);
    if (!profile) {
      return res.status(404).json({ error: `Profile "${name}" not found` });
    }

    await setState('profiles:active', profile, null);
    log(`[DASHBOARD] Applied profile: ${name}`);
    res.json({ success: true, profile });
  } catch (err) {
    error('[DASHBOARD] Profile apply failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete profile
app.delete('/api/profiles/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (name === 'scalping' || name === 'moonshot') {
      return res.status(400).json({ error: 'Cannot delete default profiles' });
    }
    await deleteKey(`profiles:${name}`);
    log(`[DASHBOARD] Deleted profile: ${name}`);
    res.json({ success: true });
  } catch (err) {
    error('[DASHBOARD] Profile delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full config
app.get('/api/config/full', async (req, res) => {
  try {
    const activeProfile = await getState('profiles:active') || {};
    const telegramGroups = await getState('config:telegram') || [];
    const redditSubs = await getState('config:reddit') || [];
    const discordServers = await getState('config:discord') || [];

    res.json({
      trading: {
        paperTrading: config.paperTrading,
        heliusRpcUrl: config.helius.rpcUrl ? '***configured***' : '',
        dexscreenerBaseUrl: config.dexscreener.baseUrl,
      },
      activeProfile,
      telegramGroups,
      redditSubs,
      discordServers,
    });
  } catch (err) {
    error('[DASHBOARD] Config fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/full', async (req, res) => {
  try {
    const { telegramGroups, redditSubs, discordServers, riskParams, executionParams, intervalParams } = req.body;

    if (telegramGroups !== undefined) {
      await setState('config:telegram', telegramGroups);
    }
    if (redditSubs !== undefined) {
      await setState('config:reddit', redditSubs);
    }
    if (discordServers !== undefined) {
      await setState('config:discord', discordServers);
    }

    const currentProfile = await getState('profiles:active') || {};
    if (riskParams !== undefined) {
      currentProfile.risk = { ...currentProfile.risk, ...riskParams };
    }
    if (executionParams !== undefined) {
      currentProfile.execution = { ...currentProfile.execution, ...executionParams };
    }
    if (intervalParams !== undefined) {
      currentProfile.intervals = { ...currentProfile.intervals, ...intervalParams };
    }

    if (riskParams || executionParams || intervalParams) {
      await setState('profiles:active', currentProfile);
    }

    log('[DASHBOARD] Config updated');
    res.json({ success: true });
  } catch (err) {
    error('[DASHBOARD] Config update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram groups
app.get('/api/telegram-groups', async (req, res) => {
  try {
    const groups = await getState('config:telegram') || [];
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram-groups', async (req, res) => {
  try {
    const { group } = req.body;
    if (!group) return res.status(400).json({ error: 'Group required' });
    const groups = await getState('config:telegram') || [];
    if (!groups.includes(group)) {
      groups.push(group);
      await setState('config:telegram', groups);
      log(`[DASHBOARD] Added Telegram group: ${group}`);
    }
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/telegram-groups', async (req, res) => {
  try {
    const { group } = req.body;
    const groups = await getState('config:telegram') || [];
    const updated = groups.filter(g => g !== group);
    await setState('config:telegram', updated);
    log(`[DASHBOARD] Removed Telegram group: ${group}`);
    res.json({ success: true, groups: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reddit subreddits
app.get('/api/reddit-subreddits', async (req, res) => {
  try {
    const subs = await getState('config:reddit') || ['CryptoCurrency', 'Solana', 'CryptoMoonShots'];
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reddit-subreddits', async (req, res) => {
  try {
    const { subreddit } = req.body;
    if (!subreddit) return res.status(400).json({ error: 'Subreddit required' });
    const subs = await getState('config:reddit') || ['CryptoCurrency', 'Solana', 'CryptoMoonShots'];
    if (!subs.includes(subreddit)) {
      subs.push(subreddit);
      await setState('config:reddit', subs);
      log(`[DASHBOARD] Added subreddit: ${subreddit}`);
    }
    res.json({ success: true, subs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reddit-subreddits', async (req, res) => {
  try {
    const { subreddit } = req.body;
    const subs = await getState('config:reddit') || [];
    const updated = subs.filter(s => s !== subreddit);
    await setState('config:reddit', updated);
    log(`[DASHBOARD] Removed subreddit: ${subreddit}`);
    res.json({ success: true, subs: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discord servers
app.get('/api/discord-servers', async (req, res) => {
  try {
    const servers = await getState('config:discord') || [];
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discord-servers', async (req, res) => {
  try {
    const { serverId, serverName } = req.body;
    if (!serverId) return res.status(400).json({ error: 'Server ID required' });
    const servers = await getState('config:discord') || [];
    if (!servers.find(s => s.id === serverId)) {
      servers.push({ id: serverId, name: serverName || serverId });
      await setState('config:discord', servers);
      log(`[DASHBOARD] Added Discord server: ${serverName || serverId}`);
    }
    res.json({ success: true, servers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/discord-servers', async (req, res) => {
  try {
    const { serverId } = req.body;
    const servers = await getState('config:discord') || [];
    const updated = servers.filter(s => s.id !== serverId);
    await setState('config:discord', updated);
    log(`[DASHBOARD] Removed Discord server: ${serverId}`);
    res.json({ success: true, servers: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discord invite URL
app.get('/api/discord-invite-url', async (req, res) => {
  try {
    if (!config.discord.clientId) {
      return res.json({ url: null, error: 'DISCORD_CLIENT_ID not configured' });
    }
    const url = `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=68672&scope=bot`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API keys
app.get('/api/keys', async (req, res) => {
  try {
    res.json({
      birdeye: config.birdeye.apiKey ? '***configured***' : '',
      helius: config.helius.rpcUrl ? '***configured***' : '',
      twitter: config.twitter.bearerToken ? '***configured***' : '',
      telegramApiId: config.telegram.apiId ? '***configured***' : '',
      telegramApiHash: config.telegram.apiHash ? '***configured***' : '',
      discordBotToken: config.discord.botToken ? '***configured***' : '',
      discordClientId: config.discord.clientId || '',
      redditClientId: config.reddit.clientId ? '***configured***' : '',
      redditClientSecret: config.reddit.clientSecret ? '***configured***' : '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/keys', async (req, res) => {
  try {
    log('[DASHBOARD] API key update requested — .env must be edited manually');
    res.json({ success: false, message: 'API keys must be updated in .env file directly. Restart bot after editing.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity logs
app.get('/api/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const result = await getLogs(page, pageSize);
    res.json(result);
  } catch (err) {
    error('[DASHBOARD] Logs fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram auth status
app.get('/api/telegram-auth/status', async (req, res) => {
  try {
    const status = await getState('telegram:auth:status') || 'idle';
    res.json({ status });
  } catch (err) {
    error('[DASHBOARD] Telegram auth status failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram auth phone
app.post('/api/telegram-auth/phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    await setState('telegram:auth:phone', phone);
    await publish('telegram:auth:update', { status: 'waiting_phone_submitted' });
    log(`[DASHBOARD] Telegram phone submitted: ${phone}`);
    res.json({ success: true, message: 'Phone submitted, waiting for OTP' });
  } catch (err) {
    error('[DASHBOARD] Telegram phone submit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram auth OTP
app.post('/api/telegram-auth/otp', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'OTP code required' });
    await setState('telegram:auth:otp', code);
    await publish('telegram:auth:update', { status: 'otp_submitted' });
    log('[DASHBOARD] Telegram OTP submitted');
    res.json({ success: true, message: 'OTP submitted, authenticating...' });
  } catch (err) {
    error('[DASHBOARD] Telegram OTP submit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram auth password (2FA)
app.post('/api/telegram-auth/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    await setState('telegram:auth:password', password);
    await publish('telegram:auth:update', { status: 'password_submitted' });
    log('[DASHBOARD] Telegram 2FA password submitted');
    res.json({ success: true, message: 'Password submitted, completing auth...' });
  } catch (err) {
    error('[DASHBOARD] Telegram password submit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Discoveries
app.get('/api/discoveries', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const tokens = await getDiscoveredTokens(limit);
    res.json(tokens);
  } catch (err) {
    error('[DASHBOARD] Discoveries fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sell position
app.post('/api/sell/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const result = await sellToken(address);
    if (result) {
      res.json({ success: true, trade: result });
    } else {
      res.status(404).json({ error: 'Sell failed' });
    }
  } catch (err) {
    error('[DASHBOARD] Sell failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== DASHBOARD HTML =====================

app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>meMeCoiNEd Dashboard</title>
  <script>
    let currentPage_logs = 1;
    let currentPage_history = 1;
    let activeProfileData = null;
    let telegramStatusInterval = null;
    let bootStatusInterval = null;

    // ===== SERVICE CONTROL =====
    async function startServices() {
      const selectedServices = [];
      document.querySelectorAll('.service-checkbox:checked').forEach(cb => {
        selectedServices.push(cb.dataset.service);
      });
      if (selectedServices.length === 0) { alert('Select at least one service'); return; }

      try {
        const resp = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ services: selectedServices }),
        });
        const result = await resp.json();
        if (result.success) {
          alert('Boot successful!');
          startBootStatusPolling();
        } else {
          alert('Boot failed: ' + (result.error || JSON.stringify(result.results)));
        }
      } catch (err) {
        alert('Boot failed: ' + err.message);
      }
    }

    async function stopServices() {
      try {
        const resp = await fetch('/api/boot-stop', { method: 'POST' });
        const result = await resp.json();
        alert(result.success ? 'All services stopped' : 'Stop failed: ' + result.error);
        if (telegramStatusInterval) { clearInterval(telegramStatusInterval); telegramStatusInterval = null; }
        if (bootStatusInterval) { clearInterval(bootStatusInterval); bootStatusInterval = null; }
      } catch (err) {
        alert('Stop failed: ' + err.message);
      }
    }

    function startBootStatusPolling() {
      if (bootStatusInterval) clearInterval(bootStatusInterval);
      bootStatusInterval = setInterval(async () => {
        try {
          const resp = await fetch('/api/boot-status');
          const data = await resp.json();
          const el = document.getElementById('boot-status-display');
          if (el) {
            el.innerHTML = '<strong>Running:</strong> ' + (data.running ? 'YES' : 'NO') +
              (data.services ? ' | Services: ' + Object.keys(data.services).join(', ') : '');
          }
        } catch (err) {}
      }, 5000);
    }

    // ===== TRADING PROFILES =====
    async function refreshProfiles() {
      try {
        const resp = await fetch('/api/profiles');
        const data = await resp.json();
        activeProfileData = data.activeProfile;

        const select = document.getElementById('profile-select');
        if (select) {
          select.innerHTML = '';
          ['scalping', 'moonshot'].forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            select.appendChild(opt);
          });
          if (data.active) select.value = data.active;
        }

        // Populate risk params from active profile
        if (activeProfileData && activeProfileData.risk) {
          const r = activeProfileData.risk;
          setVal('risk-max-position-pct', (r.maxPositionPct * 100).toFixed(1));
          setVal('risk-max-concurrent', r.maxConcurrentPositions);
          setVal('risk-hard-stop', (r.hardStopLossPct * 100).toFixed(1));
          setVal('risk-trailing-stop', (r.trailingStopPct * 100).toFixed(1));
          setVal('risk-min-liquidity', r.minLiquidityUsd);
          setVal('risk-max-token-age', r.maxTokenAgeHours);
          setVal('risk-min-velocity', r.minSocialVelocityPerHour);
          setVal('risk-min-sentiment', r.minSentimentScore);
        }

        // Populate execution params
        if (activeProfileData && activeProfileData.execution) {
          const e = activeProfileData.execution;
          setVal('exec-slippage', e.slippageBps);
          setVal('exec-priority-fee', e.priorityFeeLamports);
        }

        // Populate interval params
        if (activeProfileData && activeProfileData.intervals) {
          const i = activeProfileData.intervals;
          setVal('interval-market-data', i.marketData);
          setVal('interval-trending', i.trending);
          setVal('interval-position-check', i.positionCheck);
        }
      } catch (err) {
        console.error('Failed to load profiles:', err);
      }
    }

    async function applyProfile() {
      const name = document.getElementById('profile-select').value;
      try {
        const resp = await fetch('/api/profiles/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const result = await resp.json();
        if (result.success) {
          alert('Profile "' + name + '" applied');
          await refreshProfiles();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function saveProfile() {
      const name = document.getElementById('profile-select').value;
      const profile = {
        name,
        risk: {
          maxPositionPct: parseFloat(getVal('risk-max-position-pct')) / 100,
          maxConcurrentPositions: parseInt(getVal('risk-max-concurrent')),
          hardStopLossPct: parseFloat(getVal('risk-hard-stop')) / 100,
          trailingStopPct: parseFloat(getVal('risk-trailing-stop')) / 100,
          minLiquidityUsd: parseFloat(getVal('risk-min-liquidity')),
          maxTokenAgeHours: parseFloat(getVal('risk-max-token-age')),
          minSocialVelocityPerHour: parseFloat(getVal('risk-min-velocity')),
          minSentimentScore: parseFloat(getVal('risk-min-sentiment')),
        },
        execution: {
          slippageBps: parseInt(getVal('exec-slippage')),
          priorityFeeLamports: parseInt(getVal('exec-priority-fee')),
        },
        intervals: {
          marketData: parseInt(getVal('interval-market-data')),
          trending: parseInt(getVal('interval-trending')),
          positionCheck: parseInt(getVal('interval-position-check')),
        },
      };

      try {
        const resp = await fetch('/api/profiles/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, profile }),
        });
        const result = await resp.json();
        alert(result.success ? 'Profile saved' : 'Failed: ' + result.error);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function saveRiskParams() {
      const riskParams = {
        maxPositionPct: parseFloat(getVal('risk-max-position-pct')) / 100,
        maxConcurrentPositions: parseInt(getVal('risk-max-concurrent')),
        hardStopLossPct: parseFloat(getVal('risk-hard-stop')) / 100,
        trailingStopPct: parseFloat(getVal('risk-trailing-stop')) / 100,
        minLiquidityUsd: parseFloat(getVal('risk-min-liquidity')),
        maxTokenAgeHours: parseFloat(getVal('risk-max-token-age')),
        minSocialVelocityPerHour: parseFloat(getVal('risk-min-velocity')),
        minSentimentScore: parseFloat(getVal('risk-min-sentiment')),
      };
      const executionParams = {
        slippageBps: parseInt(getVal('exec-slippage')),
        priorityFeeLamports: parseInt(getVal('exec-priority-fee')),
      };
      const intervalParams = {
        marketData: parseInt(getVal('interval-market-data')),
        trending: parseInt(getVal('interval-trending')),
        positionCheck: parseInt(getVal('interval-position-check')),
      };

      try {
        const resp = await fetch('/api/config/full', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ riskParams, executionParams, intervalParams }),
        });
        const result = await resp.json();
        alert(result.success ? 'Parameters saved to active profile' : 'Failed: ' + result.error);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function deleteProfile() {
      const name = document.getElementById('profile-select').value;
      if (name === 'scalping' || name === 'moonshot') {
        alert('Cannot delete default profiles');
        return;
      }
      if (!confirm('Delete profile "' + name + '"?')) return;
      try {
        const resp = await fetch('/api/profiles/' + name, { method: 'DELETE' });
        const result = await resp.json();
        if (result.success) {
          alert('Profile deleted');
          await refreshProfiles();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    // ===== TELEGRAM AUTH =====
    async function pollTelegramStatus() {
      try {
        const resp = await fetch('/api/telegram-auth/status');
        const data = await resp.json();
        const statusEl = document.getElementById('telegram-auth-status');
        const phoneSection = document.getElementById('telegram-phone-section');
        const otpSection = document.getElementById('telegram-otp-section');
        const passwordSection = document.getElementById('telegram-password-section');
        const doneSection = document.getElementById('telegram-done-section');

        if (statusEl) statusEl.textContent = data.status;

        if (phoneSection) phoneSection.style.display = (data.status === 'waiting_phone') ? 'block' : 'none';
        if (otpSection) otpSection.style.display = (data.status === 'waiting_otp') ? 'block' : 'none';
        if (passwordSection) passwordSection.style.display = (data.status === 'waiting_password') ? 'block' : 'none';
        if (doneSection) doneSection.style.display = (data.status === 'done') ? 'block' : 'none';
      } catch (err) {
        console.error('Telegram status poll failed:', err);
      }
    }

    function startTelegramPolling() {
      if (telegramStatusInterval) clearInterval(telegramStatusInterval);
      pollTelegramStatus();
      telegramStatusInterval = setInterval(pollTelegramStatus, 3000);
    }

    async function sendTelegramPhone() {
      const phone = getVal('telegram-phone-input');
      if (!phone) { alert('Enter phone number'); return; }
      try {
        const resp = await fetch('/api/telegram-auth/phone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });
        const result = await resp.json();
        alert(result.message);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function sendTelegramOTP() {
      const code = getVal('telegram-otp-input');
      if (!code) { alert('Enter OTP code'); return; }
      try {
        const resp = await fetch('/api/telegram-auth/otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const result = await resp.json();
        alert(result.message);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function sendTelegramPassword() {
      const password = getVal('telegram-password-input');
      if (!password) { alert('Enter password'); return; }
      try {
        const resp = await fetch('/api/telegram-auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const result = await resp.json();
        alert(result.message);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    // ===== TELEGRAM GROUPS =====
    async function loadTelegramGroups() {
      try {
        const resp = await fetch('/api/telegram-groups');
        const groups = await resp.json();
        const container = document.getElementById('telegram-groups-list');
        if (container) {
          container.innerHTML = (groups || []).map(g =>
            '<div class="list-item"><span>' + escapeHtml(g) + '</span>' +
            '<button onclick="removeTelegramGroup(\\'' + escapeHtml(g) + '\\')">Remove</button></div>'
          ).join('') || '<div class="empty-state">No groups configured</div>';
        }
      } catch (err) {
        console.error('Failed to load Telegram groups:', err);
      }
    }

    async function addTelegramGroup() {
      const group = getVal('telegram-group-input');
      if (!group) { alert('Enter group name or link'); return; }
      try {
        const resp = await fetch('/api/telegram-groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group }),
        });
        const result = await resp.json();
        if (result.success) {
          setVal('telegram-group-input', '');
          await loadTelegramGroups();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function removeTelegramGroup(group) {
      try {
        const resp = await fetch('/api/telegram-groups', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group }),
        });
        const result = await resp.json();
        if (result.success) {
          await loadTelegramGroups();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    // ===== REDDIT SUBREDDITS =====
    async function loadRedditSubs() {
      try {
        const resp = await fetch('/api/reddit-subreddits');
        const subs = await resp.json();
        const container = document.getElementById('reddit-subs-list');
        if (container) {
          container.innerHTML = (subs || []).map(s =>
            '<div class="list-item"><span>r/' + escapeHtml(s) + '</span>' +
            '<button onclick="removeRedditSub(\\'' + escapeHtml(s) + '\\')">Remove</button></div>'
          ).join('') || '<div class="empty-state">No subreddits configured</div>';
        }
      } catch (err) {
        console.error('Failed to load Reddit subreddits:', err);
      }
    }

    async function addRedditSub() {
      const subreddit = getVal('reddit-sub-input');
      if (!subreddit) { alert('Enter subreddit name'); return; }
      try {
        const resp = await fetch('/api/reddit-subreddits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subreddit }),
        });
        const result = await resp.json();
        if (result.success) {
          setVal('reddit-sub-input', '');
          await loadRedditSubs();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function removeRedditSub(subreddit) {
      try {
        const resp = await fetch('/api/reddit-subreddits', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subreddit }),
        });
        const result = await resp.json();
        if (result.success) {
          await loadRedditSubs();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    // ===== DISCORD SERVERS =====
    async function loadDiscordServers() {
      try {
        const resp = await fetch('/api/discord-servers');
        const servers = await resp.json();
        const container = document.getElementById('discord-servers-list');
        if (container) {
          container.innerHTML = (servers || []).map(s =>
            '<div class="list-item"><span>' + escapeHtml(s.name || s.id) + '</span>' +
            '<button onclick="removeDiscordServer(\\'' + escapeHtml(s.id) + '\\')">Remove</button></div>'
          ).join('') || '<div class="empty-state">No Discord servers configured</div>';
        }
      } catch (err) {
        console.error('Failed to load Discord servers:', err);
      }
    }

    async function addDiscordServer() {
      const serverId = getVal('discord-server-id-input');
      const serverName = getVal('discord-server-name-input');
      if (!serverId) { alert('Enter server ID'); return; }
      try {
        const resp = await fetch('/api/discord-servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, serverName }),
        });
        const result = await resp.json();
        if (result.success) {
          setVal('discord-server-id-input', '');
          setVal('discord-server-name-input', '');
          await loadDiscordServers();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function removeDiscordServer(serverId) {
      try {
        const resp = await fetch('/api/discord-servers', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId }),
        });
        const result = await resp.json();
        if (result.success) {
          await loadDiscordServers();
        } else {
          alert('Failed: ' + result.error);
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function loadDiscordInviteUrl() {
      try {
        const resp = await fetch('/api/discord-invite-url');
        const data = await resp.json();
        const el = document.getElementById('discord-invite-url-display');
        if (el) {
          if (data.url) {
            el.innerHTML = '<a href="' + data.url + '" target="_blank">' + data.url + '</a>';
          } else {
            el.textContent = data.error || 'Not configured';
          }
        }
      } catch (err) {
        console.error('Failed to load Discord invite URL:', err);
      }
    }

    // ===== PORTFOLIO =====
    async function refreshPortfolio() {
      try {
        const resp = await fetch('/api/portfolio');
        const data = await resp.json();
        document.getElementById('portfolio-cash').textContent = '$' + (data.cash || 0).toFixed(2);
        document.getElementById('portfolio-total').textContent = '$' + (data.totalValue || 0).toFixed(2);
        document.getElementById('portfolio-positions-count').textContent = data.positionCount || 0;
        document.getElementById('portfolio-pnl').textContent = '$' + (data.unrealizedPnl || 0).toFixed(2);
        const pnlEl = document.getElementById('portfolio-pnl');
        pnlEl.style.color = (data.unrealizedPnl || 0) >= 0 ? '#4ade80' : '#f87171';
      } catch (err) {
        console.error('Failed to load portfolio:', err);
      }
    }

    // ===== POSITIONS =====
    async function refreshPositions() {
      try {
        const resp = await fetch('/api/positions');
        const positions = await resp.json();
        const tableBody = document.getElementById('positions-table-body');
        if (tableBody) {
          tableBody.innerHTML = (positions || []).map(p => {
            const shortAddr = p.address.substring(0, 8) + '...' + p.address.substring(p.address.length - 6);
            const pnlColor = (p.unrealizedPnlPct || 0) >= 0 ? '#4ade80' : '#f87171';
            return '<tr>' +
              '<td><code>' + shortAddr + '</code></td>' +
              '<td>' + (p.tokenAmount || 0).toFixed(4) + '</td>' +
              '<td>$' + (p.entryPrice || 0).toFixed(6) + '</td>' +
              '<td>$' + (p.currentPrice || 0).toFixed(6) + '</td>' +
              '<td style="color:' + pnlColor + '">$' + (p.unrealizedPnl || 0).toFixed(2) + '</td>' +
              '<td style="color:' + pnlColor + '">' + (p.unrealizedPnlPct || 0).toFixed(2) + '%</td>' +
              '<td><button class="btn-small" onclick="sellPosition(\\'' + p.address + '\\')">Sell</button></td>' +
              '</tr>';
          }).join('') || '<tr><td colspan="7" class="empty-state">No open positions</td></tr>';
        }
      } catch (err) {
        console.error('Failed to load positions:', err);
      }
    }

    async function sellPosition(address) {
      if (!confirm('Sell position ' + address.substring(0, 8) + '...?')) return;
      try {
        const resp = await fetch('/api/sell/' + address, { method: 'POST' });
        const result = await resp.json();
        if (result.success) {
          alert('Sold at $' + result.trade.price.toFixed(6) + ' (PnL: $' + result.trade.pnl.toFixed(2) + ')');
          refreshPortfolio();
          refreshPositions();
        } else {
          alert('Sell failed: ' + (result.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Sell failed: ' + err.message);
      }
    }

    // ===== TRANSACTION HISTORY =====
    async function loadHistory(page) {
      currentPage_history = page || 1;
      try {
        const resp = await fetch('/api/history?page=' + currentPage_history + '&pageSize=20');
        const data = await resp.json();
        const tableBody = document.getElementById('history-table-body');
        if (tableBody) {
          tableBody.innerHTML = (data.trades || []).map(t => {
            const shortAddr = t.address.substring(0, 8) + '...' + t.address.substring(t.address.length - 6);
            const typeColor = t.type === 'buy' ? '#4ade80' : '#f87171';
            return '<tr>' +
              '<td style="color:' + typeColor + '">' + t.type.toUpperCase() + '</td>' +
              '<td><code>' + shortAddr + '</code></td>' +
              '<td>$' + (t.price || 0).toFixed(6) + '</td>' +
              '<td>' + (t.tokenAmount || 0).toFixed(4) + '</td>' +
              '<td>$' + (t.costUsd || t.proceedsUsd || 0).toFixed(2) + '</td>' +
              '<td>' + (t.pnl !== undefined ? '$' + t.pnl.toFixed(2) : '-') + '</td>' +
              '<td>' + (t.pnlPct !== undefined ? t.pnlPct.toFixed(2) + '%' : '-') + '</td>' +
              '<td>' + (t.timestamp || '') + '</td>' +
              '</tr>';
          }).join('') || '<tr><td colspan="8" class="empty-state">No trades yet</td></tr>';
        }

        // Pagination
        const pagination = document.getElementById('history-pagination');
        if (pagination) {
          let html = '';
          for (let i = 1; i <= (data.totalPages || 1); i++) {
            html += '<button class="page-btn' + (i === currentPage_history ? ' active' : '') + '" onclick="loadHistory(' + i + ')">' + i + '</button>';
          }
          pagination.innerHTML = html;
        }

        // Stats
        const statsEl = document.getElementById('history-stats');
        if (statsEl && data.stats) {
          statsEl.innerHTML = '<span>Trades: ' + data.stats.totalTrades + '</span>' +
            '<span>Wins: ' + data.stats.wins + '</span>' +
            '<span>Losses: ' + data.stats.losses + '</span>' +
            '<span>Win Rate: ' + data.stats.winRate + '%</span>' +
            '<span>Total PnL: $' + data.stats.totalPnl + '</span>';
        }
      } catch (err) {
        console.error('Failed to load history:', err);
      }
    }

    // ===== ACTIVITY LOGS =====
    async function loadLogs(page) {
      currentPage_logs = page || 1;
      try {
        const resp = await fetch('/api/logs?page=' + currentPage_logs + '&pageSize=50');
        const data = await resp.json();
        const container = document.getElementById('activity-log');
        if (container) {
          container.innerHTML = (data.logs || []).map(l =>
            '<div class="log-entry ' + (l.severity || 'INFO').toLowerCase() + '">' +
            '<span class="log-time">' + l.timestamp + '</span> ' +
            '<span class="log-severity">[' + l.severity + ']</span> ' +
            l.message + '</div>'
          ).join('') || '<div class="empty-state">No logs yet</div>';
        }

        // Pagination
        const pagination = document.getElementById('logs-pagination');
        if (pagination) {
          let html = '';
          for (let i = 1; i <= (data.totalPages || 1); i++) {
            html += '<button class="page-btn' + (i === currentPage_logs ? ' active' : '') + '" onclick="loadLogs(' + i + ')">' + i + '</button>';
          }
          pagination.innerHTML = html;
        }
      } catch (err) {
        console.error('Failed to load logs:', err);
      }
    }

    // ===== API KEYS =====
    async function loadApiKeys() {
      try {
        const resp = await fetch('/api/keys');
        const data = await resp.json();
        const container = document.getElementById('api-keys-display');
        if (container) {
          container.innerHTML = Object.entries(data).map(([key, val]) =>
            '<div class="api-key-row"><span class="api-key-label">' + key + '</span>' +
            '<span class="api-key-value">' + (val || '<em>not set</em>') + '</span></div>'
          ).join('');
        }
      } catch (err) {
        console.error('Failed to load API keys:', err);
      }
    }

    // ===== DISCOVERIES =====
    async function loadDiscoveries() {
      try {
        const resp = await fetch('/api/discoveries?limit=20');
        const tokens = await resp.json();
        const container = document.getElementById('discoveries-list');
        if (container) {
          container.innerHTML = (tokens || []).map(t =>
            '<div class="discovery-item">' +
            '<code>' + (t.mint || '').substring(0, 12) + '...</code>' +
            '<span>' + (t.name || 'Unknown') + ' (' + (t.symbol || '???') + ')</span>' +
            '<span>Liq: $' + (t.liquidityUsd || 0).toFixed(0) + '</span>' +
            '<span>Score: ' + (t.score || 0).toFixed(1) + '</span>' +
            '</div>'
          ).join('') || '<div class="empty-state">No discoveries yet</div>';
        }
      } catch (err) {
        console.error('Failed to load discoveries:', err);
      }
    }

    // ===== HELPERS =====
    function setVal(id, val) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }

    function getVal(id) {
      const el = document.getElementById(id);
      return el ? el.value : '';
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // ===== AUTO REFRESH =====
    document.addEventListener('DOMContentLoaded', () => {
      loadLogs(1);
      refreshProfiles();
      refreshPortfolio();
      refreshPositions();
      loadHistory(1);
      loadApiKeys();
      loadTelegramGroups();
      loadRedditSubs();
      loadDiscordServers();
      loadDiscordInviteUrl();
      loadDiscoveries();
      startTelegramPolling();
      startBootStatusPolling();

      setInterval(() => loadLogs(currentPage_logs), 30000);
      setInterval(refreshProfiles, 30000);
      setInterval(refreshPortfolio, 10000);
      setInterval(refreshPositions, 5000);
      setInterval(loadDiscoveries, 15000);
    });
  </script>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { margin: 0; padding: 20px; background: #1a1a2e; color: #eee; }
    h1, h2, h3 { color: #6d4aff; margin-top: 0; }
    h1 { margin-bottom: 20px; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    button { background: #6d4aff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #5a42cc; }
    button.btn-danger { background: #f87171; }
    button.btn-danger:hover { background: #e55a5a; }
    button.btn-small { padding: 5px 10px; font-size: 12px; }
    button.page-btn { padding: 5px 12px; margin: 0 3px; font-size: 13px; }
    button.page-btn.active { background: #5a42cc; }
    input, select { background: #0f3460; border: 1px solid #6d4aff; color: white; padding: 8px; border-radius: 4px; font-size: 14px; }
    input[type="number"] { width: 100px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #0f3460; font-size: 13px; }
    th { color: #6d4aff; }
    .log-entry { padding: 5px 10px; margin: 2px 0; border-left: 3px solid #6d4aff; background: #0f3460; font-size: 12px; }
    .log-entry.error { border-left-color: #f87171; }
    .log-entry.warn { border-left-color: #fbbf24; }
    .log-entry.info { border-left-color: #4ade80; }
    .log-entry.debug { border-left-color: #6b7280; }
    .log-time { color: #888; }
    .log-severity { font-weight: bold; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
    .metric-card { background: #0f3460; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-value { font-size: 1.5em; font-weight: bold; }
    .metric-label { color: #aaa; font-size: 0.9em; margin-top: 5px; }
    .service-row { display: flex; align-items: center; margin: 5px 0; }
    .service-row input[type="checkbox"] { margin-right: 10px; width: auto; }
    code { background: #0f3460; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .list-item { display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #0f3460; border-radius: 4px; margin: 5px 0; }
    .list-item span { font-size: 14px; }
    .list-item button { padding: 4px 10px; font-size: 12px; background: #f87171; }
    .empty-state { color: #666; font-style: italic; padding: 20px; text-align: center; }
    .form-row { margin-bottom: 10px; }
    .form-row label { display: inline-block; width: 200px; }
    .form-row input { width: 120px; }
    .discovery-item { display: flex; justify-content: space-between; padding: 8px; background: #0f3460; border-radius: 4px; margin: 5px 0; font-size: 13px; }
    .api-key-row { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #0f3460; }
    .api-key-label { color: #6d4aff; font-weight: bold; }
    .api-key-value { color: #aaa; }
    .pagination { margin-top: 10px; }
    .stats-bar { display: flex; gap: 20px; margin: 10px 0; padding: 10px; background: #0f3460; border-radius: 4px; font-size: 13px; }
    #boot-status-display { margin: 10px 0; padding: 10px; background: #0f3460; border-radius: 4px; font-size: 14px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>🚀 meMeCoiNEd Trading Bot v2</h1>
  <div id="boot-status-display">Status: Loading...</div>

  <!-- 1. Service Control -->
  <div class="card">
    <h2>Service Control</h2>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="discovery" id="svc-discovery" checked><label for="svc-discovery">Discovery</label></div>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="execution-listener" id="svc-execution" checked><label for="svc-execution">Execution Listener</label></div>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="risk" id="svc-risk" checked><label for="svc-risk">Risk Manager</label></div>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="rug-check" id="svc-rug" checked><label for="svc-rug">Rug Check</label></div>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="sentiment" id="svc-sentiment" checked><label for="svc-sentiment">Sentiment Analysis</label></div>
    <div class="service-row"><input type="checkbox" class="service-checkbox" data-service="telegram" id="svc-telegram"><label for="svc-telegram">Telegram (requires sidecar)</label></div>
    <div style="margin-top: 15px;">
      <button onclick="startServices()">Start Selected Services</button>
      <button class="btn-danger" onclick="stopServices()">Stop All</button>
    </div>
  </div>

  <!-- 2. Trading Profiles -->
  <div class="card">
    <h2>Trading Profiles</h2>
    <select id="profile-select"></select>
    <button onclick="applyProfile()" style="margin-left: 10px;">Apply</button>
    <button onclick="saveProfile()" style="margin-left: 10px;">Save</button>
    <button class="btn-danger" onclick="deleteProfile()" style="margin-left: 10px;">Delete</button>
  </div>

  <!-- 3. Telegram Authentication -->
  <div class="card">
    <h2>Telegram Authentication</h2>
    <p>Status: <strong id="telegram-auth-status">idle</strong></p>
    <div id="telegram-phone-section" class="hidden">
      <input type="tel" id="telegram-phone-input" placeholder="+1234567890">
      <button onclick="sendTelegramPhone()">Send Phone</button>
    </div>
    <div id="telegram-otp-section" class="hidden">
      <input type="text" id="telegram-otp-input" placeholder="Enter OTP code">
      <button onclick="sendTelegramOTP()">Send OTP</button>
    </div>
    <div id="telegram-password-section" class="hidden">
      <input type="password" id="telegram-password-input" placeholder="Enter 2FA password">
      <button onclick="sendTelegramPassword()">Send Password</button>
    </div>
    <div id="telegram-done-section" class="hidden">
      <p style="color: #4ade80;">✓ Telegram authenticated and connected</p>
    </div>
    <button onclick="startTelegramPolling()" style="margin-top: 10px;">Poll Status</button>
  </div>

  <!-- 4. Discord Configuration -->
  <div class="card">
    <h2>Discord Configuration</h2>
    <div id="discord-invite-url-display" style="margin-bottom: 15px;">Loading...</div>
  </div>

  <!-- 5. Portfolio -->
  <div class="card">
    <h2>Portfolio Summary</h2>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-value" id="portfolio-cash">$0.00</div><div class="metric-label">Cash Balance</div></div>
      <div class="metric-card"><div class="metric-value" id="portfolio-total">$0.00</div><div class="metric-label">Total Value</div></div>
      <div class="metric-card"><div class="metric-value" id="portfolio-positions-count">0</div><div class="metric-label">Open Positions</div></div>
      <div class="metric-card"><div class="metric-value" id="portfolio-pnl">$0.00</div><div class="metric-label">Unrealized PnL</div></div>
    </div>
  </div>

  <!-- 6. Positions -->
  <div class="card">
    <h2>Open Positions</h2>
    <table>
      <thead><tr><th>Token</th><th>Amount</th><th>Entry</th><th>Current</th><th>PnL ($)</th><th>PnL (%)</th><th>Action</th></tr></thead>
      <tbody id="positions-table-body"><tr><td colspan="7" class="empty-state">Loading...</td></tr></tbody>
    </table>
  </div>

  <!-- 7. Risk Parameters -->
  <div class="card">
    <h2>Risk Parameters</h2>
    <div class="form-row"><label>Max Position (%):</label><input type="number" id="risk-max-position-pct" step="0.1" value="10"></div>
    <div class="form-row"><label>Max Concurrent Positions:</label><input type="number" id="risk-max-concurrent" value="20"></div>
    <div class="form-row"><label>Hard Stop Loss (%):</label><input type="number" id="risk-hard-stop" step="0.1" value="15"></div>
    <div class="form-row"><label>Trailing Stop (%):</label><input type="number" id="risk-trailing-stop" step="0.1" value="10"></div>
    <div class="form-row"><label>Min Liquidity (USD):</label><input type="number" id="risk-min-liquidity" value="50000"></div>
    <div class="form-row"><label>Max Token Age (hours):</label><input type="number" id="risk-max-token-age" value="24"></div>
    <div class="form-row"><label>Min Social Velocity/hr:</label><input type="number" id="risk-min-velocity" value="10"></div>
    <div class="form-row"><label>Min Sentiment Score:</label><input type="number" id="risk-min-sentiment" step="0.1" value="0.2"></div>
    <button onclick="saveRiskParams()">Save to Active Profile</button>
  </div>

  <!-- 8. Trading Config (Extended) -->
  <div class="card">
    <h2>Trading Config</h2>
    <h3 style="font-size: 15px;">Execution</h3>
    <div class="form-row"><label>Slippage (bps):</label><input type="number" id="exec-slippage" value="150"></div>
    <div class="form-row"><label>Priority Fee (lamports):</label><input type="number" id="exec-priority-fee" value="100000"></div>
    <h3 style="font-size: 15px;">Intervals (ms)</h3>
    <div class="form-row"><label>Market Data Check:</label><input type="number" id="interval-market-data" value="3000"></div>
    <div class="form-row"><label>Trending Check:</label><input type="number" id="interval-trending" value="10000"></div>
    <div class="form-row"><label>Position Check:</label><input type="number" id="interval-position-check" value="2000"></div>
    <button onclick="saveRiskParams()">Save Config</button>
  </div>

  <!-- 9. Telegram Groups -->
  <div class="card">
    <h2>Telegram Groups</h2>
    <div class="form-row">
      <input type="text" id="telegram-group-input" placeholder="Group name or invite link" style="width: 300px;">
      <button onclick="addTelegramGroup()">Add</button>
    </div>
    <div id="telegram-groups-list">Loading...</div>
  </div>

  <!-- 10. Reddit Subreddits -->
  <div class="card">
    <h2>Reddit Subreddits</h2>
    <div class="form-row">
      <input type="text" id="reddit-sub-input" placeholder="Subreddit name (without r/)" style="width: 300px;">
      <button onclick="addRedditSub()">Add</button>
    </div>
    <div id="reddit-subs-list">Loading...</div>
  </div>

  <!-- 11. Discord Servers -->
  <div class="card">
    <h2>Discord Servers</h2>
    <div class="form-row">
      <input type="text" id="discord-server-id-input" placeholder="Server ID" style="width: 200px;">
      <input type="text" id="discord-server-name-input" placeholder="Server Name (optional)" style="width: 200px;">
      <button onclick="addDiscordServer()">Add</button>
    </div>
    <div id="discord-servers-list">Loading...</div>
  </div>

  <!-- 12. Transaction History -->
  <div class="card">
    <h2>Transaction History</h2>
    <div id="history-stats" class="stats-bar"></div>
    <table>
      <thead><tr><th>Type</th><th>Token</th><th>Price</th><th>Amount</th><th>Value</th><th>PnL</th><th>PnL %</th><th>Time</th></tr></thead>
      <tbody id="history-table-body"><tr><td colspan="8" class="empty-state">Loading...</td></tr></tbody>
    </table>
    <div id="history-pagination" class="pagination"></div>
  </div>

  <!-- 13. API Keys -->
  <div class="card">
    <h2>API Keys</h2>
    <p style="font-size: 13px; color: #aaa;">Keys are read from .env at startup. Edit .env and restart to change.</p>
    <div id="api-keys-display">Loading...</div>
  </div>

  <!-- 14. Activity Log -->
  <div class="card">
    <h2>Activity Log</h2>
    <div id="activity-log" style="max-height: 400px; overflow-y: auto;">Loading...</div>
    <div id="logs-pagination" class="pagination"></div>
  </div>

  <!-- Discoveries (bonus) -->
  <div class="card">
    <h2>Recent Discoveries</h2>
    <div id="discoveries-list">Loading...</div>
  </div>
</body>
</html>`;

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('html').send(html);
});

// ===================== START DASHBOARD =====================

export async function startDashboard() {
  const port = config.dashboard.port || 3000;
  app.listen(port, () => {
    log(`[DASHBOARD] Server running on http://localhost:${port}`);
    healthStatus.services.dashboard = true;
  });
  return app;
}

export function stopDashboard() {
  log('[DASHBOARD] Stopping server');
}

export default app;