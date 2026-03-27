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

async function sendWelcomeEmail(email, buildingName, tenantId) {
  if (!SMTP_HOST || !SMTP_USER) {
    console.log('[Email] SMTP not configured — skipping welcome email');
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

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// ADMIN SYSTEM v1.4
// ════════════════════════════════════════════════════════════════
const ADMIN_USERS_FILE = path.join(DATA_DIR, '_admins.json');
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

// ── Admin: שליחת מייל (עם תמיכת Gmail) ────────────────────────
app.post('/api/admin/send-email', adminAuthMiddleware, async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.json({ ok: false, error: 'חסרים שדות' });
  if (!SMTP_USER) return res.json({ ok: false, error: 'SMTP_USER לא מוגדר ב-Railway Variables' });
  try {
    const nodemailer = require('nodemailer');
    let transportConfig;
    if (!SMTP_HOST || SMTP_HOST.includes('gmail') || SMTP_USER.includes('gmail.com')) {
      transportConfig = { service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } };
    } else {
      transportConfig = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } };
    }
    const transporter = nodemailer.createTransport(transportConfig);
    await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text: body });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-email]', e.message);
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
    res.json({ ok: true });
  } catch(e) {
    console.error('[Admin:send-wa]', e.message);
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
