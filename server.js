const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'cryptowatch.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      target REAL NOT NULL,
      triggered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'CryptoWatch Backend',
    time: new Date().toISOString()
  });
});

// Watchlist routes
app.get('/api/watchlist', async (_req, res) => {
  try {
    const rows = await all('SELECT * FROM watchlist ORDER BY added_at DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load watchlist', detail: error.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const { symbol, name } = req.body;
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await run('INSERT INTO watchlist (id, symbol, name) VALUES (?, ?, ?)', [id, symbol, name || symbol]);
    const row = await get('SELECT * FROM watchlist WHERE id = ?', [id]);

    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save watchlist item', detail: error.message });
  }
});

app.delete('/api/watchlist/:id', async (req, res) => {
  try {
    await run('DELETE FROM watchlist WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete watchlist item', detail: error.message });
  }
});

// Alert routes
app.get('/api/alerts', async (_req, res) => {
  try {
    const rows = await all('SELECT * FROM alerts ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load alerts', detail: error.message });
  }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const { assetId, direction, target, triggered = 0 } = req.body;
    if (!assetId || !direction || target === undefined) {
      return res.status(400).json({ error: 'assetId, direction, and target are required' });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await run(
      'INSERT INTO alerts (id, asset_id, direction, target, triggered) VALUES (?, ?, ?, ?, ?)',
      [id, assetId, direction, Number(target), triggered ? 1 : 0]
    );

    const row = await get('SELECT * FROM alerts WHERE id = ?', [id]);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save alert', detail: error.message });
  }
});

app.patch('/api/alerts/:id', async (req, res) => {
  try {
    const { triggered } = req.body;
    await run('UPDATE alerts SET triggered = ? WHERE id = ?', [triggered ? 1 : 0, req.params.id]);
    const row = await get('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update alert', detail: error.message });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  try {
    await run('DELETE FROM alerts WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete alert', detail: error.message });
  }
});

// Existing proxy route
app.get('/api/proxy', (req, res) => {
  const target = req.query.target;
  if (!target) {
    return res.status(400).json({ error: 'Missing target query parameter' });
  }

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(target));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  const transport = parsed.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];

  const options = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    method: req.method,
    headers
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({
      error: 'Proxy request failed',
      detail: err.message
    });
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  await initDb();
  app.listen(port, () => {
    console.log(`CryptoWatch backend running on http://localhost:${port}`);
  });
}

start();