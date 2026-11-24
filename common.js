// Outils partagés entre les pages
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (opts.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(url, o); let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(d.error || 'Erreur ' + r.status); e.status = r.status; throw e; }
  return d;
}
let toastT;
function toast(msg, err) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}
const fr = (d) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const frt = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const STAMP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// Dessine une carte à tampons dans un élément
function renderCard(el, shop, points, newFrom = -1) {
  const c = shop.period?.color || shop.color, goal = shop.goal, shown = Math.min(points, goal);
  el.style.setProperty('--c', c); el.style.setProperty('--a', shop.accent);
  el.style.setProperty('--cols', goal <= 8 ? 4 : goal <= 10 ? 5 : goal <= 12 ? 6 : 7);
  el.innerHTML = `<div class="cn">${esc(shop.name)}</div><div class="ct">${esc(shop.period ? shop.period.title : shop.tagline)}</div>
  <div class="stamps">${Array.from({ length: goal }, (_, i) => i < shown
    ? `<div class="st on${i >= newFrom && newFrom >= 0 ? ' new' : ''}">${STAMP_SVG}</div>`
    : `<div class="st">${i + 1}</div>`).join('')}</div>
  <div class="foot"><span>${points >= goal ? '<b>Récompense disponible</b>' : `Encore <b>${goal - points}</b> ${esc(shop.stampLabel)}${goal - points > 1 ? 's' : ''}`}</span><span>${esc(shop.reward)}</span></div>`;
}
