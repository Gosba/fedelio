// Google Wallet : cartes de fidélité (loyaltyClass par boutique, loyaltyObject par carte)
'use strict';
const crypto = require('crypto');
const API = process.env.GOOGLE_WALLET_API_BASE || 'https://walletobjects.googleapis.com/walletobjects/v1';
const OAUTH = process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const ISSUER = (process.env.GOOGLE_WALLET_ISSUER_ID || '').trim();
let SA = null;
try { const raw = (process.env.GOOGLE_WALLET_SA_JSON || '').trim(); if (raw) SA = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString()); }
catch (e) { console.error('GOOGLE_WALLET_SA_JSON illisible :', e.message); }
const enabled = !!(ISSUER && SA?.client_email && SA?.private_key);

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const data = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claims);
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), SA.private_key).toString('base64url');
}
let token = null, tokenExp = 0;
async function auth() {
  if (token && Date.now() < tokenExp) return token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer', aud: OAUTH, iat: now, exp: now + 3600 });
  const r = await fetch(OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google refuse le compte de service (' + (d.error_description || d.error || r.status) + ')');
  token = d.access_token; tokenExp = Date.now() + (d.expires_in - 120) * 1000; return token;
}
async function call(method, path, body) {
  const r = await fetch(API + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + await auth(), 'Content-Type': 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Google Wallet : ' + (d.error?.message || r.status)); e.status = r.status; throw e; }
  return d;
}

const classId = (shop) => `${ISSUER}.fidelio_shop_${shop.id}`;
const objectId = (card) => `${ISSUER}.fidelio_card_${crypto.createHash('sha256').update(card.id).digest('hex').slice(0, 32)}`;

function buildClass(shop, info) {
  return {
    id: classId(shop), issuerName: shop.name.slice(0, 40), programName: 'Carte de fidélité',
    programLogo: { sourceUri: { uri: info.baseUrl + '/wallet-logo.png' }, contentDescription: { defaultValue: { language: 'fr', value: shop.name } } },
    hexBackgroundColor: info.color, reviewStatus: 'UNDER_REVIEW', countryCode: 'FR',
    localizedProgramName: { defaultValue: { language: 'fr', value: 'Carte de fidélité' } },
    homepageUri: { uri: `${info.baseUrl}/s/${shop.slug}`, description: 'Ma carte en ligne' },
  };
}
function buildObject(shop, card, info) {
  const ready = card.points >= info.goal;
  return {
    id: objectId(card), classId: classId(shop), state: 'ACTIVE',
    accountId: card.code, accountName: 'Carte ' + card.code,
    loyaltyPoints: { label: info.label.charAt(0).toUpperCase() + info.label.slice(1) + 's', balance: { string: `${Math.min(card.points, 999)} / ${info.goal}` } },
    secondaryLoyaltyPoints: { label: 'Récompenses obtenues', balance: { int: card.rewards } },
    barcode: { type: 'QR_CODE', value: card.code, alternateText: card.code },
    textModulesData: [
      { id: 'reward', header: ready ? 'Récompense disponible !' : 'Votre récompense', body: `${info.goal} ${info.label}s = ${info.reward}` },
      ...(info.period ? [{ id: 'period', header: info.period.title, body: info.period.message || `Points x${info.period.multiplier} jusqu'au ${info.period.end_date.split('-').reverse().join('/')}` }] : []),
    ],
    linksModuleData: { uris: [{ uri: `${info.baseUrl}/s/${shop.slug}`, description: 'Ouvrir ma carte', id: 'card' }] },
  };
}

// Crée ou met à jour la classe d'une boutique
async function syncClass(shop, info) {
  const c = buildClass(shop, info);
  try { await call('PUT', `/loyaltyClass/${encodeURIComponent(c.id)}`, c); }
  catch (e) { if (e.status === 404) await call('POST', '/loyaltyClass', c); else throw e; }
}
// Lien « Ajouter à Google Wallet » (la carte est créée chez Google quand le client l'enregistre)
function saveUrl(shop, card, info) {
  const now = Math.floor(Date.now() / 1000);
  return 'https://pay.google.com/gp/v/save/' + jwt({
    iss: SA.client_email, aud: 'google', typ: 'savetowallet', iat: now, origins: [info.baseUrl],
    payload: { loyaltyClasses: [buildClass(shop, info)], loyaltyObjects: [buildObject(shop, card, info)] },
  });
}
// Met à jour les tampons d'une carte déjà enregistrée dans le Wallet (404 = pas enregistrée : on ignore)
async function updateObject(shop, card, info) {
  const o = buildObject(shop, card, info);
  try { await call('PUT', `/loyaltyObject/${encodeURIComponent(o.id)}`, o); }
  catch (e) { if (e.status !== 404) throw e; }
}
// Message affiché sur toutes les cartes de la boutique, avec notification
async function messageAll(shop, title, body) {
  await call('POST', `/loyaltyClass/${encodeURIComponent(classId(shop))}/addMessage`,
    { message: { header: title, body, messageType: 'TEXT_AND_NOTIFY', id: 'm' + Date.now() } });
}

module.exports = { enabled, ISSUER, email: SA?.client_email || '', syncClass, saveUrl, updateObject, messageAll };
