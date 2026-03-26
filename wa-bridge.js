/**
 * VaadPro – WA Bridge v2.0 (Baileys)
 * ללא Chrome/Puppeteer — יציב ומהיר
 * הפעלה: node wa-bridge.js
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode   = require('qrcode');
const https    = require('https');
const http     = require('http');
const path     = require('path');

const CLOUD_URL       = process.env.CLOUD_URL     || 'https://your-app.railway.app';
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET || 'vaadpro-bridge-secret';
const TENANT_ID       = process.env.TENANT_ID     || '';
const AUTH_DIR        = './wa-auth-baileys';
const POLL_INTERVAL   = 5000;
const HEALTH_INTERVAL = 60000;

if (!TENANT_ID) { console.error('❌ חסר TENANT_ID'); process.exit(1); }

// ── HTTP helper ──────────────────────────────────────────────────
function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOUD_URL + urlPath);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-secret': BRIDGE_SECRET,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 10000
    };
    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function pushStatus(status, qrDataUrl, phone) {
  try {
    await apiCall('POST', '/api/bridge/status', { tenantId: TENANT_ID, status, qrDataUrl, phone });
    console.log(`[Bridge] status: ${status}${phone ? ' ('+phone+')' : ''}`);
  } catch(e) { console.error('[Bridge] pushStatus error:', e.message); }
}

// ── Polling ──────────────────────────────────────────────────────
let isPolling = false, pollTimer = null, sock = null, waReady = false;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAndSend, POLL_INTERVAL);
  console.log('[Bridge] polling started');
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollAndSend() {
  if (isPolling || !waReady || !sock) return;
  isPolling = true;
  try {
    const res = await apiCall('GET', `/api/bridge/queue/${TENANT_ID}`, null);
    if (!res.pending || !res.pending.length) return;
    for (const msg of res.pending) {
      let ok = false, error = '';
      try {
        // Baileys format: phone@s.whatsapp.net
        const jid = msg.phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: msg.message });
        ok = true;
        console.log(`[Bridge] ✓ sent → ${msg.phone}`);
      } catch(e) {
        error = e.message;
        console.error(`[Bridge] ✗ failed → ${msg.phone}:`, error);
      }
      await apiCall('POST', '/api/bridge/ack', { tenantId: TENANT_ID, msgId: msg.msgId, ok, error });
    }
  } catch(e) {
    if (e.message !== 'timeout') console.error('[Bridge] poll error:', e.message);
  } finally { isPolling = false; }
}

// ── Health check ─────────────────────────────────────────────────
setInterval(async () => {
  if (!waReady) return;
  try {
    const phone = sock?.user?.id?.split(':')[0] || null;
    await pushStatus('ready', null, phone);
  } catch(e) {}
}, HEALTH_INTERVAL);

// ── Baileys WhatsApp ─────────────────────────────────────────────
async function initWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[Bridge] Baileys version:', version.join('.'));

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // נטפל ב-QR ידנית
    logger: { level: 'silent', // השתק logs מיותרים
      trace(){}, debug(){}, info(){}, warn: console.warn, error: console.error, fatal: console.error, child(){ return this; }
    },
    browser: ['VaadPro', 'Chrome', '1.0'], // מזהה כדפדפן רגיל
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
  });

  // QR
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waReady = false;
      stopPolling();
      console.log('[Bridge] QR מוכן לסריקה');
      const qrDataUrl = await qrcode.toDataURL(qr);
      await pushStatus('qr', qrDataUrl, null);
    }

    if (connection === 'open') {
      waReady = true;
      const phone = sock.user?.id?.split(':')[0] || null;
      console.log('[Bridge] ✅ WhatsApp מחובר!', phone || '');
      await pushStatus('ready', null, phone);
      startPolling();
    }

    if (connection === 'close') {
      waReady = false;
      stopPolling();
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0;
      const reason = DisconnectReason[statusCode] || statusCode;
      console.log('[Bridge] התנתק, סיבה:', reason);

      if (statusCode === DisconnectReason.loggedOut) {
        // נותק על ידי המשתמש — מחק auth ואתחל מחדש
        console.log('[Bridge] Logged out — מחק auth ומתחיל מחדש');
        await pushStatus('disconnected', null, null);
        const fs = require('fs');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(initWA, 3000);
      } else {
        // ניתוק זמני — נסה שוב
        await pushStatus('disconnected', null, null);
        console.log('[Bridge] מנסה לחבר מחדש...');
        setTimeout(initWA, 5000);
      }
    }
  });

  // שמור credentials בכל שינוי
  sock.ev.on('creds.update', saveCreds);
}

// ── Start ────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════╗');
console.log('║   VaadPro WA Bridge v2.0 (Baileys)   ║');
console.log('╚══════════════════════════════════════╝\n');
console.log('Cloud URL:  ', CLOUD_URL);
console.log('Tenant ID:  ', TENANT_ID);
console.log('\nמאתחל WhatsApp...');
initWA().catch(console.error);
