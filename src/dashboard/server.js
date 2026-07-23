import express from 'express';
import { log, error, getLogs } from '../shared/logger.js';
import { getState, setState, getList, addToList, publish, deleteKey } from '../shared/redis.js';
import { initExecution, getAllPositions, getPortfolioSummary, sellToken } from '../execution/service.js';
import { startDiscoveryLoop, stopDiscovery, getDiscoveredTokens, getTokenFromDiscovery } from '../discovery/service.js';
import { startRiskMonitoring, stopRiskManager } from '../risk-manager/service.js';
import { startRugCheckListener, stopRugCheck } from '../rug-check/service.js';
import { startSentimentAggregation, stopAggregation } from '../sentiment/service.js';
import config from '../config/index.js';

const app = express();
app.use(express.json());

let healthStatus = {
  running: false,
  services: {},
  startTime: null,
};

// Health endpoint
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

    // Initialize execution
    await initExecution();
    results.execution = { status: 'ok', message: 'Initialized' };

    // Start each requested service
    for (const service of services) {
      switch (service) {
        case 'discovery':
          results.discovery = await startDiscoveryLoop()
            ? { status: 'ok', message: 'Started discovery loop' }
            : { status: 'fail', message: 'Failed to start discovery' };
          break;
        case 'risk':
          results.risk = await startRiskMonitoring()
            ? { status: 'ok', message: 'Started risk monitoring' }
            : { status: 'fail', message: 'Failed to start risk monitoring' };
          break;
        case 'rug-check':
          results['rug-check'] = await startRugCheckListener()
            ? { status: 'ok', message: 'Started rug check listener' }
            : { status: 'fail', message: 'Failed to start rug check' };
          break;
        case 'sentiment':
          results.sentiment = await startSentimentAggregation()
            ? { status: 'ok', message: 'Started sentiment aggregation' }
            : { status: 'fail', message: 'Failed to start sentiment' };
          break;
        case 'execution-listener':
          const execResult = await (await import('../execution/service.js')).startExecutionListener();
          results['execution-listener'] = execResult
            ? { status: 'ok', message: 'Started execution listener' }
            : { status: 'fail', message: 'Failed to start execution listener' };
          break;
        default:
          results[service] = { status: 'unknown', message: `Unknown service: ${service}` };
      }
    }

    healthStatus.services = services.reduce((acc, s) => {
      acc[s] = true;
      return acc;
    }, {});

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

    // Stop execution listener
    const execMod = await import('../execution/service.js');
    if (execMod.stopExecution) execMod.stopExecution();

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

// Trade history
app.get('/api/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const history = await getList('portfolio:history');
    const total = history.length;
    const start = Math.max(0, total - page * pageSize);
    const end = Math.max(0, total - (page - 1) * pageSize);
    
    res.json({
      trades: history.slice(start, end).reverse(),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
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
    
    res.json({
      scalping: scalping || {
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
      },
      moonshot: moonshot || {
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
      },
      active: active?.name || null,
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
    await setState('profiles:active:name', name, null);
    log(`[DASHBOARD] Applied profile: ${name}`);
    res.json({ success: true });
  } catch (err) {
    error('[DASHBOARD] Profile apply failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete profile
app.delete('/api/profiles/:name', async (req, res) => {
  try {
    const { name } = req.params;
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
    const telegramGroups = await getList('config:telegram') || [];
    const telegramConfig = await getState('config:telegram') || [];
    
    res.json({
      trading: config,
      activeProfile,
      telegramGroups,
    });
  } catch (err) {
    error('[DASHBOARD] Config fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/full', async (req, res) => {
  try {
    const { telegramGroups, riskParams } = req.body;
    
    if (telegramGroups !== undefined) {
      await setState('config:telegram', telegramGroups);
    }
    if (riskParams !== undefined) {
      const currentProfile = await getState('profiles:active') || {};
      currentProfile.risk = { ...currentProfile.risk, ...riskParams };
      await setState('profiles:active', currentProfile);
    }
    
    log('[DASHBOARD] Config updated');
    res.json({ success: true });
  } catch (err) {
    error('[DASHBOARD] Config update failed:', err.message);
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
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    await setState('telegram:auth:phone', phone);
    await publish('telegram:auth:update', { status: 'waiting_phone_submitted' });
    
    // Trigger Python sidecar via Redis pub
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
    if (!code) {
      return res.status(400).json({ error: 'OTP code required' });
    }
    
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
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    
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

// Serve dashboard with cache busting
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>meMeCoiNEd Dashboard</title>
  <script>
    let servicesState = {};
    let profileData = {};
    let portfolioData = {};
    
    async function loadLogs() {
      try {
        const resp = await fetch('/api/logs?page=1&pageSize=50');
        const data = await resp.json();
        const logContainer = document.getElementById('activity-log');
        if (logContainer) {
          logContainer.innerHTML = data.logs
            .map(l => \`<div class="log-entry \${l.severity?.toLowerCase()}">\${l.timestamp}</span> [\${l.severity}] \${l.message}</div>\`)
            .join('') || '<div>No logs yet</div>';
        }
      } catch (err) {
        console.error('Failed to load logs:', err);
      }
    }
    
    async function refreshProfiles() {
      try {
        const resp = await fetch('/api/profiles');
        profileData = await resp.json();
        const select = document.getElementById('profile-select');
        if (select) {
          select.value = profileData.active || 'scalping';
        }
      } catch (err) {
        console.error('Failed to load profiles:', err);
      }
    }
    
    async function refreshPortfolio() {
      try {
        const resp = await fetch('/api/portfolio');
        portfolioData = await resp.json();
        
        document.getElementById('portfolio-cash').textContent = '\$' + portfolioData.cash.toFixed(2);
        document.getElementById('portfolio-total').textContent = '\$' + portfolioData.totalValue.toFixed(2);
        document.getElementById('portfolio-positions-count').textContent = portfolioData.positionCount;
        document.getElementById('portfolio-pnl').textContent = portfolioData.unrealizedPnl.toFixed(2);
        
        const pnlEl = document.getElementById('portfolio-pnl');
        pnlEl.style.color = portfolioData.unrealizedPnl >= 0 ? '#4ade80' : '#f87171';
      } catch (err) {
        console.error('Failed to load portfolio:', err);
      }
    }
    
    async function refreshPositions() {
      try {
        const resp = await fetch('/api/positions');
        const positions = await resp.json();
        
        const tableBody = document.getElementById('positions-table-body');
        if (tableBody) {
          tableBody.innerHTML = positions.map(p => \`
            <tr>
              <td><code>\${p.address.substring(0, 8)}...\${p.address.substring(p.address.length - 8)}</code></td>
              <td>\${p.tokenAmount.toFixed(4)}</td>
              <td>$\${p.entryPrice?.toFixed(6)}</td>
              <td>$\${p.currentPrice?.toFixed(6) || '-'}</td>
              <td style="\${(p.unrealizedPnlPct || 0) >= 0 ? 'color: #4ade80;' : 'color: #f87171;'}">$\${p.unrealizedPnl?.toFixed(2) || '0'}</td>
              <td>\${p.unrealizedPnlPct?.toFixed(2) || '0'}%</td>
              <td><button onclick="sellPosition('\${p.address}')">Sell</button></td>
            </tr>
          \`).join('');
        }
      } catch (err) {
        console.error('Failed to load positions:', err);
      }
    }
    
    async function startServices() {
      const selectedServices = [];
      document.querySelectorAll('.service-checkbox:checked').forEach(cb => {
        selectedServices.push(cb.dataset.service);
      });
      
      try {
        const resp = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ services: selectedServices }),
        });
        const result = await resp.json();
        alert(result.success ? 'Boot successful!' : 'Boot failed: ' + result.error);
      } catch (err) {
        alert('Boot failed: ' + err.message);
      }
    }
    
    async function stopServices() {
      try {
        const resp = await fetch('/api/boot-stop', { method: 'POST' });
        const result = await resp.json();
        alert(result.success ? 'Stopped!' : 'Stop failed: ' + result.error);
      } catch (err) {
        alert('Stop failed: ' + err.message);
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
        alert(result.success ? 'Profile applied!' : 'Failed: ' + result.error);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }
    
    async function saveProfile() {
      const name = document.getElementById('profile-select').value;
      const profile = {
        risk: {
          maxPositionPct: parseFloat(document.getElementById('risk-max-position-pct')?.value || 0.10),
          maxConcurrentPositions: parseInt(document.getElementById('risk-max-concurrent')?.value || 20),
          hardStopLossPct: parseFloat(document.getElementById('risk-hard-stop')?.value || 0.15),
          trailingStopPct: parseFloat(document.getElementById('risk-trailing-stop')?.value || 0.10),
        },
      };
      
      try {
        const resp = await fetch('/api/profiles/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, profile }),
        });
        const result = await resp.json();
        alert(result.success ? 'Profile saved!' : 'Failed: ' + result.error);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }
    
    async function sellPosition(address) {
      if (!confirm('Are you sure you want to sell this position?')) return;
      
      try {
        const resp = await fetch('/api/sell/' + address, { method: 'POST' });
        const result = await resp.json();
        if (result.success) {
          refreshPortfolio();
          refreshPositions();
        } else {
          alert('Sell failed: ' + result.error);
        }
      } catch (err) {
        alert('Sell failed: ' + err.message);
      }
    }
    
    async function sendTelegramPhone() {
      const phone = document.getElementById('telegram-phone-input')?.value;
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
      const code = document.getElementById('telegram-otp-input')?.value;
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
    
    // Auto-refresh
    setInterval(loadLogs, 30000);
    setInterval(refreshProfiles, 30000);
    setInterval(refreshPortfolio, 10000);
    setInterval(refreshPositions, 5000);
    
    // Initial load
    document.addEventListener('DOMContentLoaded', () => {
      loadLogs();
      refreshProfiles();
      refreshPortfolio();
      refreshPositions();
    });
  </script>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { margin: 0; padding: 20px; background: #1a1a2e; color: #eee; }
    h1, h2, h3 { color: #6d4aff; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    button { background: #6d4aff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #5a42cc; }
    input, select { background: #0f3460; border: 1px solid #6d4aff; color: white; padding: 8px; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #16213e; }
    th { color: #6d4aff; }
    .log-entry { padding: 5px 10px; margin: 2px 0; border-left: 3px solid #6d4aff; background: #0f3460; }
    .log-entry.ERROR { border-left-color: #f87171; }
    .log-entry.WARN { border-left-color: #fbbf24; }
    .log-entry.INFO { border-left-color: #4ade80; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
    .metric-card { background: #0f3460; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-value { font-size: 1.5em; font-weight: bold; }
    .metric-label { color: #aaa; font-size: 0.9em; margin-top: 5px; }
    .service-row { display: flex; align-items: center; margin: 5px 0; }
    .service-row input[type="checkbox"] { margin-right: 10px; }
    code { background: #0f3460; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>🚀 meMeCoiNEd Trading Bot</h1>
  
  <div class="card">
    <h2>Service Control</h2>
    <div class="service-row"><input type="checkbox" data-service="discovery" id="svc-discovery" checked><label for="svc-discovery">Discovery</label></div>
    <div class="service-row"><input type="checkbox" data-service="execution-listener" id="svc-execution" checked><label for="svc-execution">Execution Listener</label></div>
    <div class="service-row"><input type="checkbox" data-service="risk" id="svc-risk" checked><label for="svc-risk">Risk Manager</label></div>
    <div class="service-row"><input type="checkbox" data-service="rug-check" id="svc-rug" checked><label for="svc-rug">Rug Check</label></div>
    <div class="service-row"><input type="checkbox" data-service="sentiment" id="svc-sentiment" checked><label for="svc-sentiment">Sentiment Analysis</label></div>
    <div style="margin-top: 15px;">
      <button onclick="startServices()">Start Selected Services</button>
      <button onclick="stopServices()" style="background: #f87171;">Stop All</button>
    </div>
  </div>
  
  <div class="card">
    <h2>Trading Profiles</h2>
    <select id="profile-select"></select>
    <button onclick="applyProfile()" style="margin-left: 10px;">Apply</button>
    <button onclick="saveProfile()" style="margin-left: 10px;">Save</button>
  </div>
  
  <div class="card">
    <h2>Telegram Authentication</h2>
    <input type="tel" id="telegram-phone-input" placeholder="+1234567890">
    <button onclick="sendTelegramPhone()" style="margin-left: 10px;">Send Phone</button>
    <br><br>
    <input type="text" id="telegram-otp-input" placeholder="Enter OTP code">
    <button onclick="sendTelegramOTP()" style="margin-left: 10px;">Send OTP</button>
  </div>
  
  <div class="card">
    <h2>Portfolio Summary</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-value" id="portfolio-cash">$0.00</div>
        <div class="metric-label">Cash Balance</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" id="portfolio-total">$0.00</div>
        <div class="metric-label">Total Value</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" id="portfolio-positions-count">0</div>
        <div class="metric-label">Open Positions</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" id="portfolio-pnl">$0.00</div>
        <div class="metric-label">Unrealized PnL</div>
      </div>
    </div>
  </div>
  
  <div class="card">
    <h2>Open Positions</h2>
    <table>
      <thead><tr><th>Token</th><th>Amount</th><th>Entry</th><th>Current</th><th>PnL ($)</th><th>PnL (%)</th><th>Action</th></tr></thead>
      <tbody id="positions-table-body"><tr><td colspan="7">Loading...</td></tr></tbody>
    </table>
  </div>
  
  <div class="card">
    <h2>Risk Parameters</h2>
    <label>Max Position (%): <input type="number" id="risk-max-position-pct" step="0.01" value="10" style="width: 80px;"></label>
    <br><br>
    <label>Max Concurrent: <input type="number" id="risk-max-concurrent" value="20" style="width: 80px;"></label>
    <br><br>
    <label>Hard Stop Loss (%): <input type="number" id="risk-hard-stop" step="0.01" value="15" style="width: 80px;"></label>
    <br><br>
    <label>Trailing Stop (%): <input type="number" id="risk-trailing-stop" step="0.01" value="10" style="width: 80px;"></label>
  </div>
  
  <div class="card">
    <h2>Activity Log</h2>
    <div id="activity-log">Loading...</div>
  </div>
</body>
</html>`;
  
  // Cache-bust the response
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('html').send(html);
});

export async function startDashboard() {
  const port = config.dashboard.port || 3000;
  
  app.listen(port, () => {
    log(`[DASHBOARD] Server running on http://localhost:${port}`);
    healthStatus.services.dashboard = true;
  });
  
  return app;
}

export function stopDashboard() {
  process.exit(0);
}

export default app;