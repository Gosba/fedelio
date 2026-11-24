// Fidélio — cartes de fidélité dématérialisées pour commerçants
// Node 22+ (node:sqlite intégré), Express, web-push, qrcode
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push');
const QRCode = require('qrcode');
const paypal = require('./paypal');
const gw = require('./googlewallet');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_NAME = process.env.APP_NAME || 'Fidélio';
const PRICE = Number(process.env.PRICE_EUR || 29);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'fidelio.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS shops(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'essai', paid_until TEXT NOT NULL,
  notes TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}',
  pin TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards(
  id TEXT PRIMARY KEY, code TEXT NOT NULL, shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0, rewards INTEGER NOT NULL DEFAULT 0,
  push TEXT, last_stamp TEXT, created_at TEXT NOT NULL, UNIQUE(shop_id, code));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  card_id TEXT, type TEXT NOT NULL, delta INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS periods(
  id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  title TEXT NOT NULL, message TEXT DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1, goal INTEGER, reward TEXT, color TEXT,
  notify INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  amount REAL NOT NULL, until TEXT NOT NULL, at TEXT NOT NULL, note TEXT DEFAULT '');
`);
for (const m of ['ALTER TABLE shops ADD COLUMN paypal_sub TEXT', 'ALTER TABLE shops ADD COLUMN paypal_status TEXT', 'ALTER TABLE shops ADD COLUMN paypal_next TEXT', 'ALTER TABLE payments ADD COLUMN ref TEXT', 'ALTER TABLE cards ADD COLUMN gw INTEGER NOT NULL DEFAULT 0'])
  try { db.exec(m); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payments_ref ON payments(ref) WHERE ref IS NOT NULL');
const q = (sql) => db.prepare(sql);
const getSetting = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ---------- Secrets, mot de passe admin, clés push ----------
const rnd = (n, abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => Array.from(crypto.randomBytes(n), b => abc[b % abc.length]).join('');
if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.SESSION_SECRET || getSetting('secret');

function hash(pw) { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); }
function check(pw, h) {
  if (!h || !pw) return false; const [s, k] = h.split(':');
  const a = crypto.scryptSync(String(pw), s, 64), b = Buffer.from(k, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (process.env.ADMIN_PASSWORD) setSetting('admin_hash', hash(process.env.ADMIN_PASSWORD));
if (!getSetting('admin_hash')) {
  const pw = rnd(12, 'abcdefghjkmnpqrstuvwxyz23456789');
  setSetting('admin_hash', hash(pw));
  console.log(`\n  Mot de passe administrateur généré : ${pw}\n  (changez-le dans l'espace admin ou via la variable ADMIN_PASSWORD)\n`);
}
if (!getSetting('vapid')) setSetting('vapid', JSON.stringify(webpush.generateVAPIDKeys()));
const VAPID = JSON.parse(getSetting('vapid'));
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contact@example.com', VAPID.publicKey, VAPID.privateKey);

// ---------- Sessions (cookie signé) ----------
const sign = (v) => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function unsign(t) {
  if (!t) return null; const i = t.lastIndexOf('.'); const v = t.slice(0, i);
  const good = sign(v); if (good.length !== t.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(t))) return null;
  const [role, id, exp, as] = v.split('|'); if (Date.now() > Number(exp)) return null;
  return { role, id: Number(id), as: as === '1' };
}
function setSession(res, role, id, as = false) {
  const v = [role, id, Date.now() + 1000 * 3600 * 24 * 14, as ? 1 : 0].join('|');
  res.setHeader('Set-Cookie', `${role}=${encodeURIComponent(sign(v))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${3600 * 24 * 14}${process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`);
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; })); }
const isAdmin = (req) => unsign(cookies(req).adm)?.role === 'adm';
function needAdmin(req, res, next) { isAdmin(req) ? next() : res.status(401).json({ error: 'Connexion administrateur requise' }); }
function needShop(req, res, next) {
  const s = unsign(cookies(req).pro);
  const shop = s && q('SELECT * FROM shops WHERE id=?').get(s.id);
  if (!shop) return res.status(401).json({ error: 'Connexion requise' });
  req.shop = shop; req.impersonated = s.as; next();
}

// ---------- Utilitaires métier ----------
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonth = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); };
const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'boutique';
const DEFAULTS = {
  color: '#0f5132', accent: '#ffc845', goal: 10, perVisit: 1, cooldownHours: 2,
  reward: 'Un produit offert', tagline: 'Merci de votre fidélité !', address: '', stampLabel: 'tampon',
};
const config = (shop) => ({ ...DEFAULTS, ...JSON.parse(shop.config || '{}') });
const isActive = (shop) => shop.status !== 'suspendu' && shop.paid_until >= today();
const currentPeriod = (shopId) => q('SELECT * FROM periods WHERE shop_id=? AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1').get(shopId, today(), today());
function rules(shop) {
  const c = config(shop), p = currentPeriod(shop.id);
  return {
    goal: p?.goal || c.goal, reward: p?.reward || c.reward,
    multiplier: p?.multiplier || 1, perVisit: c.perVisit, period: p || null,
  };
}
const publicShop = (shop) => {
  const c = config(shop), r = rules(shop);
  return {
    slug: shop.slug, name: shop.name, active: isActive(shop), ...c, goal: r.goal, reward: r.reward, multiplier: r.multiplier,
    period: r.period && { title: r.period.title, message: r.period.message, end: r.period.end_date, color: r.period.color, multiplier: r.period.multiplier },
  };
};
const cardView = (card, shop) => ({
  id: card.id, code: card.code, points: card.points, earned: card.earned, rewards: card.rewards, push: !!card.push,
  shop: publicShop(shop),
  messages: q('SELECT title, body, at FROM messages WHERE shop_id=? ORDER BY id DESC LIMIT 5').all(shop.id),
});
const log = (shopId, cardId, type, delta = 0) => q('INSERT INTO events(shop_id,card_id,type,delta,at) VALUES(?,?,?,?,?)').run(shopId, cardId, type, delta, now());
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

async function pushToShop(shopId, title, body) {
  const shop = q('SELECT slug FROM shops WHERE id=?').get(shopId);
  const subs = q('SELECT id, push FROM cards WHERE shop_id=? AND push IS NOT NULL').all(shopId);
  let ok = 0;
  await Promise.all(subs.map(async (c) => {
    try { await webpush.sendNotification(JSON.parse(c.push), JSON.stringify({ title, body, url: `/s/${shop.slug}` })); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) q('UPDATE cards SET push=NULL WHERE id=?').run(c.id); }
  }));
  return ok;
}

// ---------- Application ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// Limitation simple des tentatives (mots de passe, codes boutique)
const hits = new Map();
function limit(key, max, ms) {
  const t = Date.now(), h = (hits.get(key) || []).filter(x => t - x < ms);
  h.push(t); hits.set(key, h); return h.length > max;
}

app.get('/api/info', (req, res) => res.json({ app: APP_NAME, price: PRICE, vapid: VAPID.publicKey, googleWallet: gw.enabled }));

// ===== GOOGLE WALLET =====
const BASE = (req) => (process.env.PUBLIC_URL || baseUrl(req)).replace(/\/$/, '');
function walletInfo(shop, base) {
  const c = config(shop), r = rules(shop);
  return { baseUrl: base, color: r.period?.color || c.color, goal: r.goal, reward: r.reward, label: c.stampLabel, period: r.period };
}
// Après chaque changement de points : met à jour la carte dans le Wallet (sans bloquer la caisse)
function gwRefresh(cardId, base) {
  if (!gw.enabled) return;
  const c = q('SELECT * FROM cards WHERE id=?').get(cardId); if (!c?.gw) return;
  const s = q('SELECT * FROM shops WHERE id=?').get(c.shop_id);
  gw.updateObject(s, c, walletInfo(s, base)).catch(e => console.error(e.message));
}
app.get('/api/cards/:id/google-wallet', async (req, res) => {
  if (!gw.enabled) return res.status(404).json({ error: 'Google Wallet n\'est pas activé' });
  const r = cardById(req.params.id); if (!r) return res.status(404).json({ error: 'Carte introuvable' });
  const info = walletInfo(r.s, BASE(req));
  try { await gw.syncClass(r.s, info); } catch (e) { console.error(e.message); }
  q('UPDATE cards SET gw=1 WHERE id=?').run(r.c.id);
  res.json({ url: gw.saveUrl(r.s, r.c, info) });
});

// ===== ADMIN (accès maintenance) =====
app.post('/api/admin/login', (req, res) => {
  if (limit('adm:' + req.ip, 8, 15 * 60e3)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes' });
  if (!check(req.body.password, getSetting('admin_hash'))) return res.status(401).json({ error: 'Mot de passe incorrect' });
  setSession(res, 'adm', 0); res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.setHeader('Set-Cookie', 'adm=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.post('/api/admin/password', needAdmin, (req, res) => {
  const pw = str(req.body.password, 100); if (pw.length < 8) return res.status(400).json({ error: '8 caractères minimum' });
  setSetting('admin_hash', hash(pw)); res.json({ ok: true });
});
app.get('/api/admin/shops', needAdmin, (req, res) => {
  const shops = q(`SELECT s.id, s.slug, s.name, s.email, s.status, s.paid_until, s.notes, s.created_at, s.paypal_status,
    (SELECT COUNT(*) FROM cards c WHERE c.shop_id=s.id) cards,
    (SELECT COUNT(*) FROM events e WHERE e.shop_id=s.id AND e.type='stamp' AND e.at>=?) stamps30
    FROM shops s ORDER BY s.name COLLATE NOCASE`).all(addDays(today(), -30));
  const t = today();
  for (const s of shops) s.state = s.status === 'suspendu' ? 'suspendu' : s.paid_until < t ? 'expire' : s.status;
  const paid30 = q('SELECT COALESCE(SUM(amount),0) v FROM payments WHERE at>=?').get(addDays(t, -30)).v;
  res.json({ shops, price: PRICE, stats: {
    total: shops.length, actifs: shops.filter(s => s.state === 'actif').length, essais: shops.filter(s => s.state === 'essai').length,
    aRelancer: shops.filter(s => s.state === 'expire' || (s.state !== 'suspendu' && s.paid_until <= addDays(t, 5))).length,
    mrr: shops.filter(s => s.state === 'actif').length * PRICE, paid30,
  } });
});
app.post('/api/admin/shops', needAdmin, (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email, 120).toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Nom et e-mail valides requis' });
  if (q('SELECT 1 FROM shops WHERE email=?').get(email)) return res.status(400).json({ error: 'Cet e-mail est déjà utilisé' });
  let slug = slugify(str(req.body.slug, 40) || name), i = 2; const base = slug;
  while (q('SELECT 1 FROM shops WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
  const password = rnd(10, 'abcdefghjkmnpqrstuvwxyz23456789');
  const r = q('INSERT INTO shops(slug,name,email,pass,status,paid_until,notes,config,pin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(slug, name, email, hash(password), 'essai', addDays(today(), TRIAL_DAYS), str(req.body.notes, 1000), '{}', rnd(4, '0123456789'), now());
  res.json({ id: Number(r.lastInsertRowid), slug, password });
});
app.patch('/api/admin/shops/:id', needAdmin, (req, res) => {
  const s = q('SELECT * FROM shops WHERE id=?').get(req.params.id); if (!s) return res.status(404).json({ error: 'Introuvable' });
  const b = req.body;
  const status = ['essai', 'actif', 'suspendu'].includes(b.status) ? b.status : s.status;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(b.paid_until || '') ? b.paid_until : s.paid_until;
  q('UPDATE shops SET name=?, email=?, status=?, paid_until=?, notes=? WHERE id=?')
    .run(str(b.name ?? s.name, 80) || s.name, str(b.email ?? s.email, 120).toLowerCase() || s.email, status, until, str(b.notes ?? s.notes, 1000), s.id);
  res.json({ ok: true });
});
app.post('/api/admin/shops/:id/payment', needAdmin, (req, res) => {
  const s = q('SELECT * FROM shops WHERE id=?').get(req.params.id); if (!s) return res.status(404).json({ error: 'Introuvable' });
  const months = Math.min(Math.max(parseInt(req.body.months) || 1, 1), 12);
  let until = s.paid_until > today() ? s.paid_until : today();
  for (let i = 0; i < months; i++) until = addMonth(until);
  q('UPDATE shops SET status=\'actif\', paid_until=? WHERE id=?').run(until, s.id);
  q('INSERT INTO payments(shop_id,amount,until,at,note) VALUES(?,?,?,?,?)').run(s.id, PRICE * months, until, now(), str(req.body.note, 200));
  res.json({ ok: true, paid_until: until });
});
app.get('/api/admin/shops/:id/payments', needAdmin, (req, res) => res.json(q('SELECT amount, until, at, note FROM payments WHERE shop_id=? ORDER BY id DESC').all(req.params.id)));
app.post('/api/admin/shops/:id/reset', needAdmin, (req, res) => {
  const password = rnd(10, 'abcdefghjkmnpqrstuvwxyz23456789');
  const r = q('UPDATE shops SET pass=? WHERE id=?').run(hash(password), req.params.id);
  r.changes ? res.json({ password }) : res.status(404).json({ error: 'Introuvable' });
});
app.post('/api/admin/shops/:id/impersonate', needAdmin, (req, res) => {
  if (!q('SELECT 1 FROM shops WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Introuvable' });
  setSession(res, 'pro', Number(req.params.id), true); res.json({ ok: true });
});
app.delete('/api/admin/shops/:id', needAdmin, (req, res) => { q('DELETE FROM shops WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ===== COMMERÇANT =====
app.post('/api/pro/login', (req, res) => {
  if (limit('pro:' + req.ip, 10, 15 * 60e3)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes' });
  const s = q('SELECT * FROM shops WHERE email=?').get(str(req.body.email, 120).toLowerCase());
  if (!s || !check(req.body.password, s.pass)) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect' });
  setSession(res, 'pro', s.id); res.json({ ok: true });
});
app.post('/api/pro/logout', (req, res) => { res.setHeader('Set-Cookie', 'pro=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/pro/me', needShop, (req, res) => {
  const s = req.shop, since = addDays(today(), -30);
  const n = (sql, ...a) => q(sql).get(s.id, ...a).v;
  res.json({
    id: s.id, slug: s.slug, name: s.name, email: s.email, status: s.status, paid_until: s.paid_until, active: isActive(s),
    pin: s.pin, paypal: s.paypal_status, paypalNext: s.paypal_next, config: config(s), rules: rules(s), price: PRICE, impersonated: req.impersonated, url: `${baseUrl(req)}/s/${s.slug}`,
    stats: {
      cards: n('SELECT COUNT(*) v FROM cards WHERE shop_id=?'),
      newCards30: n('SELECT COUNT(*) v FROM cards WHERE shop_id=? AND created_at>=?', since),
      stamps30: n('SELECT COALESCE(SUM(delta),0) v FROM events WHERE shop_id=? AND type IN (\'stamp\',\'manual\') AND at>=?', since),
      rewards30: n('SELECT COUNT(*) v FROM events WHERE shop_id=? AND type=\'reward\' AND at>=?', since),
      push: n('SELECT COUNT(*) v FROM cards WHERE shop_id=? AND push IS NOT NULL'),
      ready: n('SELECT COUNT(*) v FROM cards WHERE shop_id=? AND points>=?', rules(s).goal),
      days: q(`SELECT substr(at,1,10) d, SUM(CASE WHEN type IN ('stamp','manual') THEN delta ELSE 0 END) v FROM events WHERE shop_id=? AND at>=? GROUP BY d`).all(s.id, addDays(today(), -13)),
    },
  });
});
app.put('/api/pro/config', needShop, (req, res) => {
  const b = req.body, c = config(req.shop), hex = (v, d) => /^#[0-9a-f]{6}$/i.test(v || '') ? v : d;
  const next = {
    color: hex(b.color, c.color), accent: hex(b.accent, c.accent),
    goal: Math.min(Math.max(parseInt(b.goal) || c.goal, 2), 50), perVisit: Math.min(Math.max(parseInt(b.perVisit) || 1, 1), 10),
    cooldownHours: Math.min(Math.max(Number(b.cooldownHours ?? c.cooldownHours) || 0, 0), 72),
    reward: str(b.reward ?? c.reward, 120), tagline: str(b.tagline ?? c.tagline, 160), address: str(b.address ?? c.address, 160),
    stampLabel: str(b.stampLabel ?? c.stampLabel, 20) || 'tampon',
  };
  const name = str(b.name, 80) || req.shop.name;
  q('UPDATE shops SET config=?, name=? WHERE id=?').run(JSON.stringify(next), name, req.shop.id); res.json({ ok: true });
  if (gw.enabled && q('SELECT 1 FROM cards WHERE shop_id=? AND gw=1').get(req.shop.id)) {
    const s = q('SELECT * FROM shops WHERE id=?').get(req.shop.id); gw.syncClass(s, walletInfo(s, BASE(req))).catch(e => console.error(e.message));
  }
});
app.post('/api/pro/password', needShop, (req, res) => {
  const pw = str(req.body.password, 100); if (pw.length < 8) return res.status(400).json({ error: '8 caractères minimum' });
  q('UPDATE shops SET pass=? WHERE id=?').run(hash(pw), req.shop.id); res.json({ ok: true });
});
app.post('/api/pro/pin', needShop, (req, res) => {
  const pin = /^\d{4,6}$/.test(req.body.pin || '') ? req.body.pin : rnd(4, '0123456789');
  q('UPDATE shops SET pin=? WHERE id=?').run(pin, req.shop.id); res.json({ pin });
});
const findCard = (shop, code) => q('SELECT * FROM cards WHERE shop_id=? AND code=?').get(shop.id, str(code, 10).toUpperCase().replace(/[^A-Z0-9]/g, ''));
app.get('/api/pro/card/:code', needShop, (req, res) => {
  const c = findCard(req.shop, req.params.code); if (!c) return res.status(404).json({ error: 'Aucune carte avec ce code' });
  res.json({ code: c.code, points: c.points, rewards: c.rewards, created_at: c.created_at, last_stamp: c.last_stamp, goal: rules(req.shop).goal });
});
app.post('/api/pro/card/:code/points', needShop, (req, res) => {
  if (!isActive(req.shop)) return res.status(402).json({ error: 'Abonnement inactif : contactez votre administrateur' });
  const c = findCard(req.shop, req.params.code); if (!c) return res.status(404).json({ error: 'Aucune carte avec ce code' });
  const r = rules(req.shop), base = Math.min(Math.max(parseInt(req.body.points) || r.perVisit, -50), 50);
  const delta = base > 0 ? Math.round(base * r.multiplier) : Math.max(base, -c.points);
  q('UPDATE cards SET points=points+?, earned=earned+?, last_stamp=? WHERE id=?').run(delta, Math.max(delta, 0), now(), c.id);
  log(req.shop.id, c.id, 'manual', delta); gwRefresh(c.id, BASE(req));
  res.json({ points: c.points + delta, delta, goal: r.goal });
});
app.post('/api/pro/card/:code/redeem', needShop, (req, res) => {
  const c = findCard(req.shop, req.params.code); if (!c) return res.status(404).json({ error: 'Aucune carte avec ce code' });
  const r = rules(req.shop); if (c.points < r.goal) return res.status(400).json({ error: `Il manque ${r.goal - c.points} ${config(req.shop).stampLabel}(s)` });
  q('UPDATE cards SET points=points-?, rewards=rewards+1 WHERE id=?').run(r.goal, c.id); log(req.shop.id, c.id, 'reward', -r.goal); gwRefresh(c.id, BASE(req));
  res.json({ points: c.points - r.goal, reward: r.reward });
});
app.get('/api/pro/periods', needShop, (req, res) => res.json(q('SELECT * FROM periods WHERE shop_id=? ORDER BY start_date DESC').all(req.shop.id)));
function periodFrom(b) {
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!str(b.title, 80) || !d.test(b.start_date || '') || !d.test(b.end_date || '') || b.end_date < b.start_date) return null;
  return [str(b.title, 80), str(b.message, 300), b.start_date, b.end_date, Math.min(Math.max(Number(b.multiplier) || 1, 1), 5),
    parseInt(b.goal) > 1 ? Math.min(parseInt(b.goal), 50) : null, str(b.reward, 120) || null, /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null, b.notify ? 1 : 0];
}
app.post('/api/pro/periods', needShop, (req, res) => {
  const v = periodFrom(req.body); if (!v) return res.status(400).json({ error: 'Titre et dates valides requis (fin après début)' });
  q('INSERT INTO periods(title,message,start_date,end_date,multiplier,goal,reward,color,notify,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...v, req.shop.id);
  periodTick().catch(console.error); res.json({ ok: true });
});
app.put('/api/pro/periods/:id', needShop, (req, res) => {
  const v = periodFrom(req.body); if (!v) return res.status(400).json({ error: 'Titre et dates valides requis (fin après début)' });
  q('UPDATE periods SET title=?,message=?,start_date=?,end_date=?,multiplier=?,goal=?,reward=?,color=?,notify=? WHERE id=? AND shop_id=?').run(...v, req.params.id, req.shop.id);
  periodTick().catch(console.error); res.json({ ok: true });
});
app.delete('/api/pro/periods/:id', needShop, (req, res) => { q('DELETE FROM periods WHERE id=? AND shop_id=?').run(req.params.id, req.shop.id); res.json({ ok: true }); });
app.get('/api/pro/messages', needShop, (req, res) => res.json(q('SELECT * FROM messages WHERE shop_id=? ORDER BY id DESC LIMIT 50').all(req.shop.id)));
app.post('/api/pro/messages', needShop, async (req, res) => {
  if (!isActive(req.shop)) return res.status(402).json({ error: 'Abonnement inactif : contactez votre administrateur' });
  const title = str(req.body.title, 60), body = str(req.body.body, 240);
  if (!title || !body) return res.status(400).json({ error: 'Titre et message requis' });
  const day = q('SELECT COUNT(*) v FROM messages WHERE shop_id=? AND at>=?').get(req.shop.id, today()).v;
  if (day >= 3) return res.status(429).json({ error: '3 notifications maximum par jour, pour ne pas lasser vos clients' });
  const sent = await pushToShop(req.shop.id, title, body);
  if (gw.enabled && q('SELECT 1 FROM cards WHERE shop_id=? AND gw=1').get(req.shop.id)) gw.messageAll(req.shop, title, body).catch(e => console.error(e.message));
  q('INSERT INTO messages(shop_id,title,body,sent,at) VALUES(?,?,?,?,?)').run(req.shop.id, title, body, sent, now());
  res.json({ sent });
});

// ===== CARTE CLIENT (anonyme : aucune donnée personnelle) =====
const shopBySlug = (slug) => q('SELECT * FROM shops WHERE slug=?').get(String(slug));
app.get('/api/s/:slug', (req, res) => { const s = shopBySlug(req.params.slug); s ? res.json(publicShop(s)) : res.status(404).json({ error: 'Boutique introuvable' }); });
app.post('/api/s/:slug/cards', (req, res) => {
  const s = shopBySlug(req.params.slug); if (!s) return res.status(404).json({ error: 'Boutique introuvable' });
  if (!isActive(s)) return res.status(402).json({ error: 'Cette carte de fidélité est momentanément indisponible' });
  if (limit('new:' + req.ip, 20, 3600e3)) return res.status(429).json({ error: 'Trop de cartes créées, réessayez plus tard' });
  let code; do code = rnd(6); while (q('SELECT 1 FROM cards WHERE shop_id=? AND code=?').get(s.id, code));
  const id = crypto.randomBytes(16).toString('base64url');
  q('INSERT INTO cards(id,code,shop_id,created_at) VALUES(?,?,?,?)').run(id, code, s.id, now()); log(s.id, id, 'new');
  res.json(cardView(q('SELECT * FROM cards WHERE id=?').get(id), s));
});
const cardById = (id) => { const c = q('SELECT * FROM cards WHERE id=?').get(String(id)); return c && { c, s: q('SELECT * FROM shops WHERE id=?').get(c.shop_id) }; };
app.get('/api/cards/:id', (req, res) => { const r = cardById(req.params.id); r ? res.json(cardView(r.c, r.s)) : res.status(404).json({ error: 'Carte introuvable' }); });
app.post('/api/cards/:id/stamp', (req, res) => {
  const r = cardById(req.params.id); if (!r) return res.status(404).json({ error: 'Carte introuvable' });
  const { c, s } = r;
  if (!isActive(s)) return res.status(402).json({ error: 'Carte momentanément indisponible' });
  if (limit('pin:' + c.id, 5, 10 * 60e3)) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans 10 minutes' });
  if (String(req.body.pin || '') !== s.pin) return res.status(403).json({ error: 'Code commerçant incorrect' });
  const cfg = config(s), ru = rules(s);
  if (c.last_stamp && Date.now() - Date.parse(c.last_stamp) < cfg.cooldownHours * 3600e3)
    return res.status(429).json({ error: `Un seul ${cfg.stampLabel} toutes les ${cfg.cooldownHours} h` });
  const delta = Math.round(ru.perVisit * ru.multiplier);
  q('UPDATE cards SET points=points+?, earned=earned+?, last_stamp=? WHERE id=?').run(delta, delta, now(), c.id); log(s.id, c.id, 'stamp', delta); gwRefresh(c.id, BASE(req));
  res.json({ ...cardView(q('SELECT * FROM cards WHERE id=?').get(c.id), s), delta });
});
app.post('/api/cards/:id/redeem', (req, res) => {
  const r = cardById(req.params.id); if (!r) return res.status(404).json({ error: 'Carte introuvable' });
  const { c, s } = r, ru = rules(s);
  if (limit('pin:' + c.id, 5, 10 * 60e3)) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans 10 minutes' });
  if (String(req.body.pin || '') !== s.pin) return res.status(403).json({ error: 'Code commerçant incorrect' });
  if (c.points < ru.goal) return res.status(400).json({ error: 'Pas encore de récompense disponible' });
  q('UPDATE cards SET points=points-?, rewards=rewards+1 WHERE id=?').run(ru.goal, c.id); log(s.id, c.id, 'reward', -ru.goal); gwRefresh(c.id, BASE(req));
  res.json({ ...cardView(q('SELECT * FROM cards WHERE id=?').get(c.id), s), reward: ru.reward });
});
app.post('/api/cards/:id/push', (req, res) => {
  const sub = req.body.subscription;
  if (sub && !(typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth)) return res.status(400).json({ error: 'Abonnement invalide' });
  const r = q('UPDATE cards SET push=? WHERE id=?').run(sub ? JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }) : null, String(req.params.id));
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Carte introuvable' });
});
app.get('/api/s/:slug/qr.svg', async (req, res) => {
  const s = shopBySlug(req.params.slug); if (!s) return res.status(404).end();
  res.type('image/svg+xml').send(await QRCode.toString(`${baseUrl(req)}/s/${s.slug}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }));
});
app.get('/api/qr.svg', async (req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(str(req.query.t, 64) || '-', { type: 'svg', margin: 1 }));
});

// ===== PAYPAL (abonnement automatique) =====
const ppPlan = () => process.env.PAYPAL_PLAN_ID || getSetting('paypal_plan_' + paypal.MODE) || '';
const ppHook = () => process.env.PAYPAL_WEBHOOK_ID || getSetting('paypal_webhook_' + paypal.MODE) || '';
const ppReady = () => paypal.enabled && !!ppPlan();
// Aligne une boutique sur l'état réel de son abonnement PayPal (PayPal fait foi)
function syncSubscription(sub) {
  const shop = q('SELECT * FROM shops WHERE paypal_sub=?').get(sub.id) || q('SELECT * FROM shops WHERE id=?').get(Number(sub.custom_id));
  if (!shop) return null;
  const next = sub.billing_info?.next_billing_time ? sub.billing_info.next_billing_time.slice(0, 10) : null;
  let until = shop.paid_until, status = shop.status;
  if (sub.status === 'ACTIVE' && next) {
    const covered = addDays(next, 2); // 2 jours de marge le temps que le prélèvement passe
    if (covered > until) until = covered;
    if (status !== 'suspendu') status = 'actif';
  }
  q('UPDATE shops SET paypal_sub=?, paypal_status=?, paypal_next=?, paid_until=?, status=? WHERE id=?')
    .run(sub.id, sub.status, sub.status === 'ACTIVE' ? next : null, until, status, shop.id);
  return shop.id;
}
app.get('/api/admin/paypal', needAdmin, (req, res) => res.json({
  keys: paypal.enabled, mode: paypal.MODE, planId: ppPlan(), webhookId: ppHook(), webhookUrl: `${baseUrl(req)}/api/paypal/webhook`,
  subscribers: q('SELECT COUNT(*) v FROM shops WHERE paypal_status=\'ACTIVE\'').get().v,
  googleWallet: gw.enabled, gwIssuer: gw.ISSUER, gwEmail: gw.email, gwCards: q('SELECT COUNT(*) v FROM cards WHERE gw=1').get().v,
}));
app.post('/api/admin/paypal/setup', needAdmin, async (req, res) => {
  const url = `${baseUrl(req)}/api/paypal/webhook`;
  if (!/^https:\/\//.test(url)) return res.status(400).json({ error: 'PayPal exige une adresse en https : faites cette étape une fois l\'application en ligne (Railway), ou renseignez PUBLIC_URL' });
  try {
    const r = await paypal.setup({ price: PRICE, name: APP_NAME, webhookUrl: url });
    setSetting('paypal_plan_' + paypal.MODE, r.planId); setSetting('paypal_webhook_' + paypal.MODE, r.webhookId); res.json(r);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/pro/paypal', needShop, (req, res) => {
  const s = req.shop, trialLeft = s.status !== 'suspendu' && s.paid_until > addDays(today(), 1);
  res.json({ ready: ppReady(), clientId: paypal.CLIENT_ID, planId: ppPlan(), mode: paypal.MODE, status: s.paypal_status, next: s.paypal_next,
    customId: String(s.id), startTime: trialLeft ? s.paid_until + 'T08:00:00Z' : null });
});
app.post('/api/pro/paypal/confirm', needShop, async (req, res) => {
  try {
    const sub = await paypal.getSubscription(str(req.body.subscriptionID, 60));
    if (String(sub.custom_id) !== String(req.shop.id) || sub.plan_id !== ppPlan()) return res.status(400).json({ error: 'Abonnement PayPal non reconnu' });
    q('UPDATE shops SET paypal_sub=? WHERE id=?').run(sub.id, req.shop.id); syncSubscription(sub);
    res.json({ status: sub.status });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/pro/paypal/cancel', needShop, async (req, res) => {
  const id = req.shop.paypal_sub; if (!id) return res.status(400).json({ error: 'Aucun abonnement PayPal' });
  try { await paypal.cancelSubscription(id); syncSubscription(await paypal.getSubscription(id)); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/paypal/webhook', async (req, res) => {
  const ev = req.body || {};
  try {
    if (!ppHook() || !(await paypal.verifyWebhook(req.headers, ev, ppHook()))) return res.status(400).end();
    const r = ev.resource || {};
    if (ev.event_type === 'PAYMENT.SALE.COMPLETED' && r.billing_agreement_id) {
      const sub = await paypal.getSubscription(r.billing_agreement_id); const shopId = syncSubscription(sub);
      const shop = shopId && q('SELECT paid_until FROM shops WHERE id=?').get(shopId);
      if (shop) q('INSERT OR IGNORE INTO payments(shop_id,amount,until,at,note,ref) VALUES(?,?,?,?,?,?)')
        .run(shopId, Number(r.amount?.total) || PRICE, shop.paid_until, now(), 'PayPal', 'paypal:' + r.id);
    } else if (ev.event_type?.startsWith('BILLING.SUBSCRIPTION.') && r.id) {
      syncSubscription(await paypal.getSubscription(r.id));
    }
    res.json({ ok: true });
  } catch (e) { console.error('Webhook PayPal :', e.message); res.status(500).end(); }
});

// ===== Pages =====
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/s/:slug/manifest.webmanifest', (req, res) => {
  const s = shopBySlug(req.params.slug); if (!s) return res.status(404).end(); const c = config(s);
  res.type('application/manifest+json').json({ name: `${s.name} — carte de fidélité`, short_name: s.name.slice(0, 12), start_url: `/s/${s.slug}`, scope: `/s/${s.slug}`, display: 'standalone', background_color: c.color, theme_color: c.color, icons: [{ src: `/s/${s.slug}/icon.svg`, sizes: 'any', type: 'image/svg+xml' }] });
});
app.get('/s/:slug/icon.svg', (req, res) => {
  const s = shopBySlug(req.params.slug); if (!s) return res.status(404).end(); const c = config(s);
  const letter = s.name.trim().charAt(0).toUpperCase().replace(/[<>&"']/g, '');
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${c.color}"/><circle cx="256" cy="256" r="150" fill="${c.accent}"/><text x="256" y="310" font-family="Arial,sans-serif" font-weight="700" font-size="170" text-anchor="middle" fill="${c.color}">${letter}</text></svg>`);
});
app.get('/s/:slug', page('card.html'));
app.get('/s/:slug/affiche', page('poster.html'));
app.get('/admin', page('admin.html'));
app.get('/pro', page('pro.html'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Notifications automatiques au début d'une période
async function periodTick() {
  for (const p of q('SELECT * FROM periods WHERE notify=1 AND notified=0 AND start_date<=? AND end_date>=?').all(today(), today())) {
    q('UPDATE periods SET notified=1 WHERE id=?').run(p.id);
    const body = p.message || (p.multiplier > 1 ? `Vos ${'points'} comptent x${p.multiplier} jusqu'au ${p.end_date.split('-').reverse().join('/')}` : 'Nouvelle offre en boutique');
    const sent = await pushToShop(p.shop_id, p.title, body);
    q('INSERT INTO messages(shop_id,title,body,sent,at) VALUES(?,?,?,?,?)').run(p.shop_id, p.title, body, sent, now());
  }
}
setInterval(() => periodTick().catch(console.error), 10 * 60e3); periodTick().catch(console.error);

if (require.main === module) app.listen(PORT, () => console.log(`${APP_NAME} en ligne sur http://localhost:${PORT}  (admin : /admin, commerçants : /pro)`));
module.exports = app;
