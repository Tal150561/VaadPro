/**
 * VaadPro – SaaS Server v1.0
 * Multi-tenant ועד הבית management
 */

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode    = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── קבצי Bridge מוטמעים ─────────────────────────────────────────
const BRIDGE_JS_CONTENT = "/**\n * VaadPro Bridge \u2013 \u05d2\u05e8\u05e1\u05ea \u05dc\u05e7\u05d5\u05d7\n * \u05d0\u05dc \u05ea\u05e2\u05e8\u05d5\u05da \u05e7\u05d5\u05d1\u05e5 \u05d6\u05d4\n */\n\nconst { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');\nconst { Boom } = require('@hapi/boom');\nconst qrcode = require('qrcode');\nconst https  = require('https');\nconst http   = require('http');\nconst fs     = require('fs');\nconst path   = require('path');\n\n// \u2500\u2500 \u05e7\u05e8\u05d0 \u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05de\u05e7\u05d5\u05d1\u05e5 config.json \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst CONFIG_FILE = path.join(__dirname, 'config.json');\nif (!fs.existsSync(CONFIG_FILE)) {\n  console.error('\u274c \u05e7\u05d5\u05d1\u05e5 config.json \u05dc\u05d0 \u05e0\u05de\u05e6\u05d0!');\n  console.error('   \u05e6\u05d5\u05e8 \u05e7\u05d5\u05d1\u05e5 config.json \u05e2\u05dd \u05d4\u05e4\u05e8\u05d8\u05d9\u05dd \u05e9\u05e7\u05d9\u05d1\u05dc\u05ea \u05d1-\u05d0\u05d9\u05de\u05d9\u05d9\u05dc.');\n  process.exit(1);\n}\nconst config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));\nconst { cloudUrl, bridgeSecret, tenantId } = config;\nif (!cloudUrl || !bridgeSecret || !tenantId) {\n  console.error('\u274c config.json \u05d7\u05e1\u05e8\u05d9\u05dd \u05e4\u05e8\u05d8\u05d9\u05dd. \u05d5\u05d3\u05d0 \u05e9\u05d9\u05e9 cloudUrl, bridgeSecret, tenantId.');\n  process.exit(1);\n}\n\nconst AUTH_DIR      = './wa-auth';\nconst POLL_INTERVAL = 5000;\nconst HEALTH_INTERVAL = 60000;\n\n// \u2500\u2500 HTTP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction apiCall(method, urlPath, body) {\n  return new Promise((resolve, reject) => {\n    const url = new URL(cloudUrl + urlPath);\n    const isHttps = url.protocol === 'https:';\n    const lib  = isHttps ? https : http;\n    const data = body ? JSON.stringify(body) : null;\n    const opts = {\n      hostname: url.hostname,\n      port: url.port || (isHttps ? 443 : 80),\n      path: url.pathname + (url.search || ''),\n      method,\n      headers: {\n        'Content-Type': 'application/json',\n        'x-bridge-secret': bridgeSecret,\n        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})\n      },\n      timeout: 10000\n    };\n    const req = lib.request(opts, (res) => {\n      let raw = '';\n      res.on('data', d => raw += d);\n      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); } });\n    });\n    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });\n    req.on('error', reject);\n    if (data) req.write(data);\n    req.end();\n  });\n}\n\nasync function pushStatus(status, qrDataUrl, phone) {\n  try {\n    await apiCall('POST', '/api/bridge/status', { tenantId, status, qrDataUrl, phone });\n    if (status === 'ready') console.log(`\u2705 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4 \u05de\u05d7\u05d5\u05d1\u05e8! (${phone})`);\n    else if (status === 'qr') console.log('\ud83d\udcf1 \u05de\u05de\u05ea\u05d9\u05df \u05dc\u05e1\u05e8\u05d9\u05e7\u05ea QR \u05d1\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4...');\n    else console.log(`\u2139\ufe0f  \u05e1\u05d8\u05d8\u05d5\u05e1: ${status}`);\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n}\n\n// \u2500\u2500 Polling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nlet isPolling = false, pollTimer = null, sock = null, waReady = false;\n\nfunction startPolling() {\n  if (pollTimer) return;\n  pollTimer = setInterval(pollAndSend, POLL_INTERVAL);\n}\n\nfunction stopPolling() {\n  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }\n}\n\nasync function pollAndSend() {\n  if (isPolling || !waReady || !sock) return;\n  isPolling = true;\n  try {\n    const res = await apiCall('GET', `/api/bridge/queue/${tenantId}`, null);\n    if (!res.pending || !res.pending.length) return;\n    for (const msg of res.pending) {\n      let ok = false, error = '';\n      try {\n        const jid = msg.phone.replace(/\\D/g, '') + '@s.whatsapp.net';\n        await sock.sendMessage(jid, { text: msg.message });\n        ok = true;\n        console.log(`\ud83d\udce4 \u05d4\u05d5\u05d3\u05e2\u05d4 \u05e0\u05e9\u05dc\u05d7\u05d4 \u05dc-${msg.phone}`);\n      } catch(e) { error = e.message; console.error(`\u274c \u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05e9\u05dc\u05d9\u05d7\u05d4:`, error); }\n      await apiCall('POST', '/api/bridge/ack', { tenantId, msgId: msg.msgId, ok, error });\n    }\n  } catch(e) { /* \u05d1\u05e9\u05e7\u05d8 */ }\n  finally { isPolling = false; }\n}\n\nsetInterval(async () => {\n  if (!waReady) return;\n  try { await pushStatus('ready', null, sock?.user?.id?.split(':')[0] || null); } catch(e) {}\n}, HEALTH_INTERVAL);\n\n// \u2500\u2500 Baileys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nasync function initWA() {\n  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);\n  const { version } = await fetchLatestBaileysVersion();\n\n  sock = makeWASocket({\n    version,\n    auth: state,\n    printQRInTerminal: false,\n    logger: {\n      level: 'silent',\n      trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; }\n    },\n    browser: ['VaadPro', 'Chrome', '1.0'],\n    connectTimeoutMs: 30000,\n    keepAliveIntervalMs: 30000,\n  });\n\n  sock.ev.on('connection.update', async (update) => {\n    const { connection, lastDisconnect, qr } = update;\n\n    if (qr) {\n      waReady = false; stopPolling();\n      const qrDataUrl = await qrcode.toDataURL(qr);\n      await pushStatus('qr', qrDataUrl, null);\n      console.log('');\n      console.log('\ud83d\udc46 \u05e4\u05ea\u05d7 \u05d0\u05ea VaadPro \u05d1\u05d3\u05e4\u05d3\u05e4\u05df \u2190 \u05dc\u05d7\u05e5 \"\u05d7\u05d9\u05d1\u05d5\u05e8 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4\" \u2190 \u05e1\u05e8\u05d5\u05e7 QR');\n      console.log('');\n    }\n\n    if (connection === 'open') {\n      waReady = true;\n      const phone = sock.user?.id?.split(':')[0] || null;\n      await pushStatus('ready', null, phone);\n      startPolling();\n    }\n\n    if (connection === 'close') {\n      waReady = false; stopPolling();\n      const statusCode = (lastDisconnect?.error instanceof Boom)\n        ? lastDisconnect.error.output.statusCode : 0;\n\n      await pushStatus('disconnected', null, null);\n\n      if (statusCode === DisconnectReason.loggedOut) {\n        console.log('\u26a0\ufe0f  \u05e0\u05d5\u05ea\u05e7\u05ea \u2014 \u05de\u05d7\u05d9\u05e7\u05ea \u05d0\u05d9\u05de\u05d5\u05ea \u05d5\u05d0\u05ea\u05d7\u05d5\u05dc \u05de\u05d7\u05d3\u05e9...');\n        fs.rmSync(AUTH_DIR, { recursive: true, force: true });\n        setTimeout(initWA, 3000);\n      } else {\n        console.log('\ud83d\udd04 \u05de\u05e0\u05e1\u05d4 \u05dc\u05d4\u05ea\u05d7\u05d1\u05e8 \u05de\u05d7\u05d3\u05e9...');\n        setTimeout(initWA, 5000);\n      }\n    }\n  });\n\n  sock.ev.on('creds.update', saveCreds);\n}\n\n// \u2500\u2500 Start \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconsole.log('');\nconsole.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');\nconsole.log('\u2551   VaadPro Bridge                     \u2551');\nconsole.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');\nconsole.log('');\nconsole.log('\u05de\u05ea\u05d7\u05d1\u05e8 \u05dc\u05e9\u05e8\u05ea VaadPro...');\ninitWA().catch(console.error);\n";
const BRIDGE_PKG_CONTENT = "{\n  \"name\": \"vaadpro-bridge\",\n  \"version\": \"1.0.0\",\n  \"description\": \"VaadPro Bridge \u2013 \u05d7\u05d9\u05d1\u05d5\u05e8 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4\",\n  \"main\": \"bridge.js\",\n  \"scripts\": {\n    \"start\": \"node bridge.js\"\n  },\n  \"dependencies\": {\n    \"@whiskeysockets/baileys\": \"^6.7.0\",\n    \"@hapi/boom\": \"^10.0.1\",\n    \"qrcode\": \"^1.5.3\"\n  }\n}\n";
const BRIDGE_INSTALL_BAT = "@echo off\nchcp 65001 > nul\necho.\necho \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\necho \u2551   VaadPro Bridge - \u05d4\u05ea\u05e7\u05e0\u05d4            \u2551\necho \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\necho.\necho \u05de\u05ea\u05e7\u05d9\u05df... \u05d0\u05e0\u05d0 \u05d4\u05de\u05ea\u05df (~2 \u05d3\u05e7\u05d5\u05ea)\necho.\nnpm install\necho.\necho \u2705 \u05d4\u05d4\u05ea\u05e7\u05e0\u05d4 \u05d4\u05d5\u05e9\u05dc\u05de\u05d4!\necho \u05e2\u05db\u05e9\u05d9\u05d5 \u05dc\u05d7\u05e5 \u05e4\u05e2\u05de\u05d9\u05d9\u05dd \u05e2\u05dc start.bat \u05dc\u05d4\u05e4\u05e2\u05dc\u05d4\necho.\npause\n";
const BRIDGE_START_BAT = "@echo off\nchcp 65001 > nul\necho.\necho \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\necho \u2551   VaadPro Bridge - \u05d4\u05e4\u05e2\u05dc\u05d4            \u2551\necho \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\necho.\necho \u05de\u05e4\u05e2\u05d9\u05dc \u05d7\u05d9\u05d1\u05d5\u05e8 \u05d5\u05d5\u05d8\u05e1\u05d0\u05e4...\necho \u05d0\u05dc \u05ea\u05e1\u05d2\u05d5\u05e8 \u05d7\u05dc\u05d5\u05df \u05d6\u05d4 \u05d1\u05d6\u05de\u05df \u05d4\u05e9\u05d9\u05de\u05d5\u05e9!\necho.\nnode bridge.js\npause\n";
const BRIDGE_README = "# VaadPro Bridge\n\n## \u05d4\u05ea\u05e7\u05e0\u05d4 (\u05e4\u05e2\u05dd \u05d0\u05d7\u05ea \u05d1\u05dc\u05d1\u05d3)\n1. \u05dc\u05d7\u05e5 \u05e4\u05e2\u05de\u05d9\u05d9\u05dd \u05e2\u05dc install.bat\n2. \u05d7\u05db\u05d4 ~2 \u05d3\u05e7\u05d5\u05ea \u05e2\u05d3 \u05e9\u05e0\u05d2\u05de\u05e8\n\n## \u05d4\u05e4\u05e2\u05dc\u05d4 \u05d9\u05d5\u05de\u05d9\u05ea\n1. \u05dc\u05d7\u05e5 \u05e4\u05e2\u05de\u05d9\u05d9\u05dd \u05e2\u05dc start.bat\n2. \u05d0\u05dc \u05ea\u05e1\u05d2\u05d5\u05e8 \u05d0\u05ea \u05d4\u05d7\u05dc\u05d5\u05df \u05d4\u05e9\u05d7\u05d5\u05e8!\n3. \u05db\u05e0\u05e1 \u05dc\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4 \u05d5\u05e1\u05e8\u05d5\u05e7 QR (\u05e4\u05e2\u05dd \u05e8\u05d0\u05e9\u05d5\u05e0\u05d4 \u05d1\u05dc\u05d1\u05d3)\n\n## \u05e9\u05d0\u05dc\u05d5\u05ea?\nsupport@vaadpro.co.il\n";

const JWT_SECRET = process.env.JWT_SECRET || 'vaadpro-secret-change-in-production';

// ── Directories ──────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, '_users.json');
const WA_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
[DATA_DIR, WA_AUTH_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Users store ──────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ── Tenant data store ────────────────────────────────────────────
function tenantFile(tenantId) {
  return path.join(DATA_DIR, tenantId + '.json');
}

function loadTenantData(tenantId) {
  const f = tenantFile(tenantId);
  if (!fs.existsSync(f)) return { tenants: [], sentLog: {}, config: {}, reports: [], rptLayouts: {} };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { tenants: [], sentLog: {}, config: {}, reports: [], rptLayouts: {} }; }
}

function saveTenantData(tenantId, patch) {
  const current = loadTenantData(tenantId);
  const merged  = Object.assign(current, patch);
  fs.writeFileSync(tenantFile(tenantId), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ── JWT Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, tenantId, email, buildingName }
    next();
  } catch(e) {
    res.status(401).json({ error: 'פג תוקף החיבור – התחבר מחדש' });
  }
}

const WA_MODE = process.env.WA_MODE || 'local'; // 'local' | 'cloud'
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'vaadpro-bridge-secret';

// ── WhatsApp state (used in both modes) ─────────────────────────
const waClients = {}; // tenantId → { client?, status, qrData, phone, restarting, healthTimer }

function getWa(tenantId) {
  if (!waClients[tenantId]) {
    waClients[tenantId] = { client: null, status: 'disconnected', qrData: null, phone: null, restarting: false, healthTimer: null };
  }
  return waClients[tenantId];
}

const DETACH_ERRORS = ['detached frame','target closed','session closed','protocol error','execution context','page crashed','browser has disconnected'];
function isDetachError(msg) { const l=(msg||'').toLowerCase(); return DETACH_ERRORS.some(e=>l.includes(e)); }

async function destroyWaClient(tenantId) {
  const wa = getWa(tenantId);
  if (wa.client) { try { await wa.client.destroy(); } catch(e) {} wa.client = null; }
}

async function restartWa(tenantId, reason) {
  const wa = getWa(tenantId);
  if (wa.restarting) return;
  wa.restarting = true;
  wa.status = 'disconnected';
  wa.phone  = null;
  console.log(`[WA:${tenantId}] restart: ${reason}`);
  await destroyWaClient(tenantId);
  if (wa.healthTimer) { clearInterval(wa.healthTimer); wa.healthTimer = null; }
  await new Promise(r => setTimeout(r, 3000));
  wa.restarting = false;
  initWa(tenantId);
}

function startHealthCheck(tenantId) {
  const wa = getWa(tenantId);
  if (wa.healthTimer) clearInterval(wa.healthTimer);
  wa.healthTimer = setInterval(async () => {
    if (wa.status !== 'ready' || wa.restarting) return;
    try { await wa.client.pupPage.evaluate(() => document.title); }
    catch(e) { if (isDetachError(e.message)) restartWa(tenantId, 'health: '+e.message); }
  }, 30000);
}

function initWa(tenantId) {
  const wa = getWa(tenantId);
  wa.client = new Client({
    authStrategy: new LocalAuth({ clientId: tenantId, dataPath: WA_AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-background-timer-throttling','--disable-renderer-backgrounding']
    }
  });

  wa.client.on('qr', async (qr) => {
    wa.status = 'qr';
    wa.qrData = await qrcode.toDataURL(qr);
    console.log(`[WA:${tenantId}] QR ready`);
  });

  wa.client.on('ready', () => {
    wa.status = 'ready';
    wa.qrData = null;
    wa.phone  = wa.client.info ? wa.client.info.wid.user : null;
    console.log(`[WA:${tenantId}] connected`, wa.phone || '');
    startHealthCheck(tenantId);
  });

  wa.client.on('disconnected', (reason) => {
    wa.status = 'disconnected';
    wa.phone  = null;
    if (wa.healthTimer) { clearInterval(wa.healthTimer); wa.healthTimer = null; }
    console.log(`[WA:${tenantId}] disconnected: ${reason}`);
    setTimeout(() => restartWa(tenantId, 'disconnected: '+reason), 5000);
  });

  wa.client.on('auth_failure', () => { wa.status = 'disconnected'; });

  wa.client.initialize().catch(e => {
    console.error(`[WA:${tenantId}] init error:`, e.message);
    setTimeout(() => restartWa(tenantId, 'init: '+e.message), 5000);
  });
}

async function sendWaMsg(tenantId, phone, message) {
  const wa = getWa(tenantId);
  if (wa.status !== 'ready') throw new Error('WhatsApp לא מחובר');
  let normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);

  if (WA_MODE === 'cloud') {
    // במצב ענן — הבקשה נשמרת בתור, ה-bridge שולח אותה
    const queue = sendQueue[tenantId] = sendQueue[tenantId] || [];
    return new Promise((resolve, reject) => {
      const msgId = Date.now() + '_' + Math.random().toString(36).slice(2);
      queue.push({ msgId, phone: normalized, message, resolve, reject, ts: Date.now() });
      // timeout אחרי 30 שניות אם ה-bridge לא מגיב
      setTimeout(() => reject(new Error('Bridge timeout – וודא שה-WA Bridge מחובר')), 30000);
    });
  }

  // מצב local — שלח ישירות
  try {
    await wa.client.sendMessage(normalized + '@c.us', message);
  } catch(e) {
    if (isDetachError(e.message)) {
      restartWa(tenantId, 'send: '+e.message);
      throw new Error('WhatsApp התנתק – מתחבר מחדש, נסה שוב בעוד 15 שניות');
    }
    throw e;
  }
}

// ── Send Queue (cloud mode) ──────────────────────────────────────
const sendQueue = {}; // tenantId → [{msgId, phone, message, resolve, reject}]

// ── Bridge API routes (נקראים מה-WA Bridge על המחשב המקומי) ────

// Bridge: עדכון סטטוס WA
app.post('/api/bridge/status', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId, status, qrDataUrl, phone } = req.body;
  if (!tenantId) return res.json({ ok: false });
  const wa = getWa(tenantId);
  wa.status = status || 'disconnected';
  wa.qrData = qrDataUrl || null;
  wa.phone  = phone || null;
  console.log(`[Bridge:${tenantId}] status=${status} phone=${phone||'-'}`);
  res.json({ ok: true });
});

// Bridge: משוך הודעות לשליחה (polling)
app.get('/api/bridge/queue/:tenantId', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId } = req.params;
  const queue = sendQueue[tenantId] || [];
  const pending = queue.map(m => ({ msgId: m.msgId, phone: m.phone, message: m.message }));
  res.json({ pending });
});

// Bridge: דווח על תוצאת שליחה
app.post('/api/bridge/ack', (req, res) => {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) return res.status(403).json({ error: 'אסור' });
  const { tenantId, msgId, ok, error } = req.body;
  const queue = sendQueue[tenantId];
  if (!queue) return res.json({ ok: true });
  const idx = queue.findIndex(m => m.msgId === msgId);
  if (idx === -1) return res.json({ ok: true });
  const [msg] = queue.splice(idx, 1);
  if (ok) msg.resolve();
  else msg.reject(new Error(error || 'שגיאה בשליחה'));
  res.json({ ok: true });
});

// ── Helpers ──────────────────────────────────────────────────────
function getEffectiveMonth(config) {
  const now = new Date(), day = now.getDate();
  const names = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  if (config && config.monthMode === 'manual' && config.manualMonth) return config.manualMonth;
  return names[day < 10 ? (now.getMonth()-1+12)%12 : now.getMonth()];
}

// ════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// ── Email helper (אימייל ברוכה) ─────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'VaadPro <noreply@vaadpro.co.il>';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function sendEmailResend(to, subject, body) {
  const fromAddr = SMTP_FROM || 'VaadPro <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: fromAddr, to, subject, text: body })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function sendWelcomeEmail(email, buildingName, tenantId) {
  if (!RESEND_API_KEY && (!SMTP_HOST || !SMTP_USER)) {
    console.log('[Email] Email not configured — skipping welcome email');
    return;
  }
  if (RESEND_API_KEY) {
    try {
      await sendEmailResend(email, `ברוך הבא ל-VaadPro! 🏢`, `שלום!

החשבון שלך ל-${buildingName} נוצר בהצלחה.

כניסה:
https://web-production-f2db5.up.railway.app

30 יום ניסיון חינם!

צוות VaadPro`);
      console.log('[Email] welcome sent via Resend to ' + email);
    } catch(e) { console.error('[Email] Resend welcome failed:', e.message); }
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    const appUrl = process.env.APP_URL || 'https://your-app.railway.app';
    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `ברוכים הבאים ל-VaadPro! 🏢`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d1117;color:#e6edf3;padding:32px;border-radius:12px;">
          <h1 style="color:#25D366;">ברוכים הבאים ל-VaadPro! 🎉</h1>
          <p>שלום,</p>
          <p>החשבון עבור <strong>${buildingName}</strong> נוצר בהצלחה.</p>
          <p>יש לך <strong>30 יום ניסיון חינם</strong> — ללא כרטיס אשראי.</p>
          <h2 style="color:#25D366;">צעדים ראשונים:</h2>
          <ol>
            <li>התחבר לאפליקציה: <a href="${appUrl}/app.html" style="color:#25D366;">${appUrl}</a></li>
            <li>הוסף דיירים בטאב "דיירים"</li>
            <li>חבר את הווטסאפ שלך (יש הוראות בתוך האפליקציה)</li>
            <li>שלח תזכורות תשלום בלחיצה אחת!</li>
          </ol>
          <p style="margin-top:24px;color:#8b949e;font-size:0.85rem;">
            לכל שאלה: <a href="mailto:support@vaadpro.co.il" style="color:#25D366;">support@vaadpro.co.il</a>
          </p>
        </div>
      `
    });
    console.log(`[Email] welcome sent to ${email}`);
  } catch(e) {
    console.error('[Email] failed:', e.message);
  }
}

// הרשמה
app.post('/api/auth/register', async (req, res) => {
  const { email, password, buildingName, address, phone, fullName } = req.body;
  if (!email || !password || !buildingName) return res.json({ ok: false, error: 'יש למלא את כל השדות' });
  if (password.length < 6) return res.json({ ok: false, error: 'סיסמה חייבת להכיל לפחות 6 תווים' });

  const users = loadUsers();
  if (users.find(u => u.email === email.toLowerCase())) return res.json({ ok: false, error: 'אימייל זה כבר רשום' });

  const tenantId  = uuidv4();
  const passHash  = await bcrypt.hash(password, 10);
  const trialEnd  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 יום

  const user = { id: uuidv4(), email: email.toLowerCase(), passHash, tenantId, buildingName, address: address||'', phone: phone||'', fullName: fullName||'', plan: 'trial', trialEnd, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  // צור קובץ נתונים ראשוני לבניין
  saveTenantData(tenantId, { tenants: [], sentLog: {}, config: { amount: 300, sendDay: 1, sendHour: 9, sendMinute: 0, monthMode: 'auto', manualMonth: '', template: 'שלום {שם}! 👋\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה! 🙏' }, reports: [], rptLayouts: {} });

  const token = jwt.sign({ userId: user.id, tenantId, email: user.email, buildingName }, JWT_SECRET, { expiresIn: '30d' });
  // שלח אימייל ברוכה (לא חוסם את התשובה)
  sendWelcomeEmail(user.email, buildingName, tenantId).catch(() => {});
  res.json({ ok: true, token, buildingName, plan: 'trial', trialEnd });
});

// התחברות
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'יש למלא אימייל וסיסמה' });

  const users = loadUsers();
  const user  = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });

  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });

  // בדוק תוקף מנוי
  const now = new Date();
  if (user.plan === 'trial' && new Date(user.trialEnd) < now) {
    return res.json({ ok: false, error: 'תקופת הניסיון הסתיימה – צור קשר לחידוש המנוי', expired: true });
  }

  const token = jwt.sign({ userId: user.id, tenantId: user.tenantId, email: user.email, buildingName: user.buildingName }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, buildingName: user.buildingName, plan: user.plan, trialEnd: user.trialEnd });
});

// פרטי משתמש מחובר
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
  res.json({ email: user.email, buildingName: user.buildingName, address: user.address, plan: user.plan, trialEnd: user.trialEnd });
});

// ════════════════════════════════════════════════════════════════
// TENANT API ROUTES (כל route מוגן ב-auth)
// ════════════════════════════════════════════════════════════════

// Status WhatsApp
app.get('/api/status', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  const wa = getWa(tenantId);
  const d  = loadTenantData(tenantId);
  console.log(`[status] tenantId=${tenantId} waStatus=${wa.status} phone=${wa.phone}`);
  res.json({
    status:          wa.restarting ? 'reconnecting' : wa.status,
    qrDataUrl:       wa.qrData,
    phoneConnected:  wa.phone,
    effectiveMonth:  getEffectiveMonth(d.config),
    currentAutoMonth: getEffectiveMonth(d.config)
  });
});

// Data CRUD
app.get('/api/data', authMiddleware, (req, res) => {
  const d = loadTenantData(req.user.tenantId);
  d.effectiveMonth    = getEffectiveMonth(d.config);
  d.currentAutoMonth  = getEffectiveMonth(d.config);
  res.json(d);
});

app.post('/api/data', authMiddleware, (req, res) => {
  const merged = saveTenantData(req.user.tenantId, req.body);
  res.json({ ok: true, effectiveMonth: getEffectiveMonth(merged.config), data: merged });
});

// Init WhatsApp — במצב ענן מחזיר סטטוס מה-Bridge, במצב local מפעיל WA
app.post('/api/wa/init', authMiddleware, (req, res) => {
  const { tenantId } = req.user;
  const wa = getWa(tenantId);
  console.log(`[wa/init] mode=${WA_MODE} tenantId=${tenantId} status=${wa.status}`);

  if (WA_MODE === 'cloud') {
    // במצב ענן — ה-Bridge הוא שמנהל את WA, רק מחזיר סטטוס נוכחי
    return res.json({ ok: true, status: wa.status, qrDataUrl: wa.qrData });
  }

  // מצב local — הפעל WA ישירות
  if (!wa.client) {
    console.log(`[wa/init] starting local WA for ${tenantId}`);
    initWa(tenantId);
  }
  res.json({ ok: true, status: wa.restarting ? 'reconnecting' : wa.status, qrDataUrl: wa.qrData });
});

// Reconnect WhatsApp
app.post('/api/reconnect', authMiddleware, async (req, res) => {
  await restartWa(req.user.tenantId, 'manual');
  res.json({ ok: true });
});

// Send to single tenant
app.post('/api/send/:id', authMiddleware, async (req, res) => {
  const d      = loadTenantData(req.user.tenantId);
  const tenant = d.tenants.find(t => String(t.id) === req.params.id);
  if (!tenant) return res.json({ ok: false, error: 'דייר לא נמצא' });
  const month  = getEffectiveMonth(d.config);
  const amount = (d.config||{}).amount || 300;
  const tmpl   = (d.config||{}).template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  const msg    = tmpl.replace(/{שם}/g,tenant.name).replace(/{חודש}/g,month).replace(/{סכום}/g,amount);
  try {
    await sendWaMsg(req.user.tenantId, tenant.phone, msg);
    const key = tenant.id+'_'+month; d.sentLog[key]='sent_'+new Date().toISOString();
    saveTenantData(req.user.tenantId, { sentLog: d.sentLog });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Send all
app.post('/api/send-all', authMiddleware, async (req, res) => {
  const d      = loadTenantData(req.user.tenantId);
  const month  = getEffectiveMonth(d.config);
  const amount = (d.config||{}).amount || 300;
  const tmpl   = (d.config||{}).template || 'שלום {שם}!\nתזכורת לתשלום ועד הבית לחודש {חודש}.\nהסכום: *{סכום} ₪*\n\nתודה!';
  let sent = 0;
  for (const tenant of d.tenants) {
    const msg = tmpl.replace(/{שם}/g,tenant.name).replace(/{חודש}/g,month).replace(/{סכום}/g,amount);
    try { await sendWaMsg(req.user.tenantId, tenant.phone, msg); d.sentLog[tenant.id+'_'+month]='sent_'+new Date().toISOString(); sent++; await new Promise(r=>setTimeout(r,1200)); }
    catch(e) { console.error(`[send-all:${req.user.tenantId}]`, tenant.name, e.message); }
  }
  saveTenantData(req.user.tenantId, { sentLog: d.sentLog });
  res.json({ ok: true, sent });
});

// Generic send message
app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.json({ ok: false, error: 'חסר מידע' });
  try { await sendWaMsg(req.user.tenantId, phone, message); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

// הורדת config.json מותאם אישית ללקוח
app.get('/api/bridge/config', authMiddleware, (req, res) => {
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const config = {
    cloudUrl:     appUrl,
    bridgeSecret: BRIDGE_SECRET,
    tenantId:     req.user.tenantId
  };
  res.setHeader('Content-Disposition', 'attachment; filename="config.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(config, null, 2));
});

// ── הורדת חבילת Bridge מלאה (ZIP עם config מובנה) ──────────────
app.get('/api/bridge/download', authMiddleware, (req, res) => {
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const config = {
    cloudUrl:     appUrl,
    bridgeSecret: BRIDGE_SECRET,
    tenantId:     req.user.tenantId
  };
  const configJson = JSON.stringify(config, null, 2);

  // קבצי ה-Bridge מוטמעים בקוד
  const BRIDGE_FILES = {
    'config.json':   configJson,
    'bridge.js':     BRIDGE_JS_CONTENT,
    'package.json':  BRIDGE_PKG_CONTENT,
    'install.bat':   BRIDGE_INSTALL_BAT,
    'start.bat':     BRIDGE_START_BAT,
    'README.md':     BRIDGE_README
  };

  // בנה ZIP ידנית (פורמט ZIP פשוט ללא דחיסה - Stored)
  const buildZip = (files) => {
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
      const nameBuf  = Buffer.from(name, 'utf8');
      const dataBuf  = Buffer.from(content, 'utf8');
      const crc      = crc32(dataBuf);
      const now      = new Date();
      const dosDate  = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
      const dosTime  = (now.getHours()<<11)|(now.getMinutes()<<5)|(Math.floor(now.getSeconds()/2));

      // Local file header
      const lh = Buffer.alloc(30 + nameBuf.length);
      lh.writeUInt32LE(0x04034b50,0);  // signature
      lh.writeUInt16LE(20,4);           // version needed
      lh.writeUInt16LE(0,6);            // flags
      lh.writeUInt16LE(0,8);            // compression (stored)
      lh.writeUInt16LE(dosTime,10);
      lh.writeUInt16LE(dosDate,12);
      lh.writeUInt32LE(crc,14);
      lh.writeUInt32LE(dataBuf.length,18);
      lh.writeUInt32LE(dataBuf.length,22);
      lh.writeUInt16LE(nameBuf.length,26);
      lh.writeUInt16LE(0,28);
      nameBuf.copy(lh,30);

      parts.push(lh, dataBuf);

      // Central directory entry
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50,0);
      cd.writeUInt16LE(20,4);
      cd.writeUInt16LE(20,6);
      cd.writeUInt16LE(0,8);
      cd.writeUInt16LE(0,10);
      cd.writeUInt16LE(dosTime,12);
      cd.writeUInt16LE(dosDate,14);
      cd.writeUInt32LE(crc,16);
      cd.writeUInt32LE(dataBuf.length,20);
      cd.writeUInt32LE(dataBuf.length,24);
      cd.writeUInt16LE(nameBuf.length,28);
      cd.writeUInt16LE(0,30);
      cd.writeUInt16LE(0,32);
      cd.writeUInt16LE(0,34);
      cd.writeUInt16LE(0,36);
      cd.writeUInt32LE(0,38);
      cd.writeUInt32LE(offset,42);
      nameBuf.copy(cd,46);
      centralDir.push(cd);

      offset += lh.length + dataBuf.length;
    }

    const cdBuf   = Buffer.concat(centralDir);
    const eocd    = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0);
    eocd.writeUInt16LE(0,4);
    eocd.writeUInt16LE(0,6);
    eocd.writeUInt16LE(centralDir.length,8);
    eocd.writeUInt16LE(centralDir.length,10);
    eocd.writeUInt32LE(cdBuf.length,12);
    eocd.writeUInt32LE(offset,16);
    eocd.writeUInt16LE(0,20);

    return Buffer.concat([...parts, cdBuf, eocd]);
  };

  // CRC-32
  const crc32 = (() => {
    const table = new Uint32Array(256);
    for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;table[i]=c;}
    return (buf) => {
      let crc=0xFFFFFFFF;
      for(let i=0;i<buf.length;i++)crc=table[(crc^buf[i])&0xFF]^(crc>>>8);
      return (crc^0xFFFFFFFF)>>>0;
    };
  })();

  try {
    const zipBuf = buildZip(BRIDGE_FILES);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="VaadPro-Bridge.zip"');
    res.setHeader('Content-Length', zipBuf.length);
    res.send(zipBuf);
  } catch(e) {
    console.error('[bridge/download]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// ADMIN SYSTEM v1.4
// ════════════════════════════════════════════════════════════════
const ADMIN_USERS_FILE = path.join(DATA_DIR, '_admins.json');
const TEMPLATES_FILE = path.join(DATA_DIR, '_templates.json');
const CRM_FILE = path.join(DATA_DIR, '_crm.json');

function loadCRM() {
  if (!fs.existsSync(CRM_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CRM_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCRM(data) { fs.writeFileSync(CRM_FILE, JSON.stringify(data, null, 2)); }
function getCRMCard(id) { const c = loadCRM(); return c[id] || { notes: [], tasks: [], status: '', calls: [] }; }
function saveCRMCard(id, card) { const c = loadCRM(); c[id] = card; saveCRM(c); }
const MSG_LOG_FILE = path.join(DATA_DIR, '_msglog.json');

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); } catch(e) { return []; }
}
function saveTemplates(t) { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(t, null, 2)); }

function loadMsgLog() {
  if (!fs.existsSync(MSG_LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(MSG_LOG_FILE, 'utf8')); } catch(e) { return []; }
}
function addMsgLog(entry) {
  const log = loadMsgLog();
  log.unshift({ ...entry, ts: new Date().toISOString() });
  if (log.length > 500) log.splice(500); // שמור 500 אחרונים
  fs.writeFileSync(MSG_LOG_FILE, JSON.stringify(log, null, 2));
}
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET + '-admin';

function loadAdmins() {
  if (!fs.existsSync(ADMIN_USERS_FILE)) {
    // צור admin ברירת מחדל אם לא קיים
    const defaultAdmin = [{
      email: process.env.ADMIN_EMAIL || 'admin@vaadpro.co.il',
      passHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'VaadPro2025!', 10)
    }];
    fs.writeFileSync(ADMIN_USERS_FILE, JSON.stringify(defaultAdmin, null, 2));
    return defaultAdmin;
  }
  try { return JSON.parse(fs.readFileSync(ADMIN_USERS_FILE, 'utf8')); } catch(e) { return []; }
}

function adminAuthMiddleware(req, res, next) {
  const token = (req.headers['x-admin-token'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'אסור' });
    req.adminUser = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'פג תוקף החיבור' });
  }
}

// ── Admin Login ──────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok: false, error: 'יש למלא אימייל וסיסמה' });
  const admins = loadAdmins();
  const admin = admins.find(a => a.email === email.toLowerCase());
  if (!admin) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });
  const ok = await bcrypt.compare(password, admin.passHash);
  if (!ok) return res.json({ ok: false, error: 'אימייל או סיסמה שגויים' });
  const token = jwt.sign({ email: admin.email, isAdmin: true }, ADMIN_JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, email: admin.email });
});

// ── Admin: רשימת לקוחות ─────────────────────────────────────────
app.get('/api/admin/tenants', adminAuthMiddleware, (req, res) => {
  const users = loadUsers().map(u => ({
    email: u.email, buildingName: u.buildingName, address: u.address,
    fullName: u.fullName||'', phone: u.phone||'',
    plan: u.plan, trialEnd: u.trialEnd, createdAt: u.createdAt,
    tenantId: u.tenantId
  }));
  res.json({ count: users.length, users });
});

// ── Admin: שינוי plan ───────────────────────────────────────────
app.post('/api/admin/set-plan', adminAuthMiddleware, (req, res) => {
  const { email, plan } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  user.plan = plan;
  if (plan === 'trial') {
    user.trialEnd = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  } else {
    delete user.trialEnd;
  }
  if (plan === 'suspended') user.suspended = true;
  else delete user.suspended;
  saveUsers(users);
  res.json({ ok: true, email, plan });
});

// ── Admin: שליחת מייל (Resend / SMTP fallback) ─────────────────
app.post('/api/admin/send-email', adminAuthMiddleware, async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.json({ ok: false, error: 'חסרים שדות' });
  try {
    if (RESEND_API_KEY) {
      await sendEmailResend(to, subject, body);
    } else if (SMTP_USER) {
      const nodemailer = require('nodemailer');
      let transportConfig;
      if (!SMTP_HOST || SMTP_HOST.includes('gmail') || SMTP_USER.includes('gmail.com')) {
        transportConfig = { service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } };
      } else {
        transportConfig = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } };
      }
      const transporter = require('nodemailer').createTransport(transportConfig);
      await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text: body });
    } else {
      return res.json({ ok: false, error: 'לא מוגדר שירות מייל (RESEND_API_KEY או SMTP_USER)' });
    }
    addMsgLog({ channel: 'email', to, subject, message: body, status: 'sent' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-email]', e.message);
    addMsgLog({ channel: 'email', to, subject, message: body, status: 'failed', error: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: שליחת WA ─────────────────────────────────────────────
app.post('/api/admin/send-wa', adminAuthMiddleware, async (req, res) => {
  const { phone, message, tenantId, sendToOwner } = req.body;
  if (!message) return res.json({ ok: false, error: 'חסרה הודעה' });

  // בחר bridge לשליחה — כל bridge פעיל
  const bridgeTenantId = Object.keys(waClients).find(id => {
    const wa = waClients[id];
    return wa && (wa.status === 'connected' || wa.status === 'ready');
  });
  if (!bridgeTenantId) return res.json({ ok: false, error: 'אין Bridge מחובר. חבר WA תחילה.' });

  // אם sendToOwner — שלח לטלפון של בעל ה-tenantId
  let targetPhone = phone;
  if (sendToOwner && tenantId) {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === tenantId);
    if (!user) return res.json({ ok: false, error: 'לקוח לא נמצא' });
    if (!user.phone) return res.json({ ok: false, error: `ללקוח ${user.email} אין מספר טלפון בפרופיל` });
    targetPhone = user.phone;
  }

  if (!targetPhone) return res.json({ ok: false, error: 'חסר מספר טלפון' });

  try {
    await sendWaMsg(bridgeTenantId, targetPhone, message);
    addMsgLog({ channel: 'wa', to: targetPhone, message, status: 'sent', contactId: tenantId||'' });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-wa]', e.message);
    addMsgLog({ channel: 'wa', to: targetPhone, message, status: 'failed', error: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: עדכון טלפון לקוח ────────────────────────────────────
app.post('/api/admin/set-phone', adminAuthMiddleware, (req, res) => {
  const { email, phone } = req.body;
  if (!email || !phone) return res.json({ ok: false, error: 'חסרים שדות' });
  const users = loadUsers();
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'משתמש לא נמצא' });
  user.phone = phone;
  saveUsers(users);
  res.json({ ok: true });
});

// ── Admin: רשימת Bridges פעילים ────────────────────────────────
app.get('/api/admin/bridges', adminAuthMiddleware, (req, res) => {
  const bridges = Object.entries(waClients).map(([tenantId, wa]) => {
    const users = loadUsers();
    const user = users.find(u => u.tenantId === tenantId);
    return { tenantId, status: wa.status, phone: wa.phone, email: user ? user.email : tenantId, buildingName: user ? user.buildingName : '' };
  }).filter(b => b.status === 'connected' || b.status === 'ready');
  res.json({ bridges });
});

// ── Admin: CRM ──────────────────────────────────────────────────

// קבל כרטיית לקוח/ליד
app.get('/api/admin/crm/:id', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  // הוסף היסטוריית הודעות מהלוג
  const log = loadMsgLog().filter(l => l.contactId === req.params.id);
  res.json({ ok: true, card, msgHistory: log });
});

// שמור כרטיית לקוח/ליד
app.post('/api/admin/crm/:id', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const updated = Object.assign(card, req.body);
  saveCRMCard(req.params.id, updated);
  res.json({ ok: true });
});

// הוסף סיכום שיחה
app.post('/api/admin/crm/:id/call', adminAuthMiddleware, (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.json({ ok: false, error: 'חסר סיכום' });
  const card = getCRMCard(req.params.id);
  if (!card.calls) card.calls = [];
  card.calls.unshift({ id: uuidv4(), summary, ts: new Date().toISOString() });
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// הוסף משימה
app.post('/api/admin/crm/:id/task', adminAuthMiddleware, (req, res) => {
  const { text, dueDate } = req.body;
  if (!text) return res.json({ ok: false, error: 'חסר טקסט' });
  const card = getCRMCard(req.params.id);
  if (!card.tasks) card.tasks = [];
  card.tasks.unshift({ id: uuidv4(), text, dueDate: dueDate||'', done: false, ts: new Date().toISOString() });
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// עדכן סטטוס משימה
app.patch('/api/admin/crm/:id/task/:taskId', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const task = (card.tasks||[]).find(t => t.id === req.params.taskId);
  if (!task) return res.json({ ok: false, error: 'משימה לא נמצאה' });
  task.done = req.body.done;
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// מחק פריט (שיחה/משימה)
app.delete('/api/admin/crm/:id/:type/:itemId', adminAuthMiddleware, (req, res) => {
  const card = getCRMCard(req.params.id);
  const key = req.params.type === 'call' ? 'calls' : 'tasks';
  card[key] = (card[key]||[]).filter(x => x.id !== req.params.itemId);
  saveCRMCard(req.params.id, card);
  res.json({ ok: true });
});

// ── Admin: תבניות הודעות ────────────────────────────────────────
app.get('/api/admin/templates', adminAuthMiddleware, (req, res) => {
  res.json({ templates: loadTemplates() });
});

app.post('/api/admin/templates', adminAuthMiddleware, (req, res) => {
  const { name, channel, subject, body } = req.body;
  if (!name || !body) return res.json({ ok: false, error: 'חסרים שדות' });
  const templates = loadTemplates();
  const existing = templates.findIndex(t => t.id === req.body.id);
  const template = { id: req.body.id || uuidv4(), name, channel: channel||'wa', subject: subject||'', body, updatedAt: new Date().toISOString() };
  if (existing >= 0) templates[existing] = template;
  else templates.unshift(template);
  saveTemplates(templates);
  res.json({ ok: true, template });
});

app.delete('/api/admin/templates/:id', adminAuthMiddleware, (req, res) => {
  const templates = loadTemplates().filter(t => t.id !== req.params.id);
  saveTemplates(templates);
  res.json({ ok: true });
});

// ── Admin: לוג שליחות ───────────────────────────────────────────
app.get('/api/admin/msglog', adminAuthMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const log = loadMsgLog().slice(0, limit);
  res.json({ log });
});

// ── Admin: שרת קובץ admin.html ──────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   VaadPro v1.4 – SaaS Server         ║');
  console.log('║   http://localhost:' + PORT + '             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Mode:      ', WA_MODE === 'cloud' ? '☁️  Cloud (WA Bridge)' : '💻 Local (direct WA)');
  console.log('Admin URL:  /admin');
  console.log('');
  if (WA_MODE === 'local') {
    console.log('WhatsApp: local mode – WA will init on first login');
  } else {
    console.log('WhatsApp: cloud mode – waiting for WA Bridge connections');
    console.log('Bridge secret:', BRIDGE_SECRET);
  }
  console.log('');
});
