const STATUS = {
  pqc: {
    label: 'Kvantesikker', color: 'var(--good)',
    icon: '<path d="M3.5 8.5l3 3 6-7"/>',
    desc: 'Støtter post-kvante nøkkelutveksling (hybrid ML-KEM).',
    advice: 'Trafikken er beskyttet mot «høst nå, dekrypter senere». Neste steg er å følge med på post-kvante-sertifikater når de blir tilgjengelige.',
  },
  tls13: {
    label: 'Ikke kvantesikker', color: 'var(--warning)',
    icon: '<path d="M8 3.5v5.5"/><path d="M8 12.5v.01"/>',
    desc: 'Bruker moderne TLS 1.3, men bare klassisk nøkkelutveksling.',
    advice: 'Det er ofte enkelt å fikse: slå på X25519MLKEM768 i webserver, lastbalanserer eller CDN. Det støttes blant annet av OpenSSL 3.5+, nyere nginx og Apache, Cloudflare, Akamai og AWS.',
  },
  legacy: {
    label: 'Utdatert TLS', color: 'var(--serious)',
    icon: '<path d="M8 3l5.5 10h-11z"/><path d="M8 7.5v2"/>',
    desc: 'Støtter høyest TLS 1.2 eller eldre.',
    advice: 'Oppgrader til TLS 1.3 og slå samtidig på hybrid ML-KEM. Post-kvante nøkkelutveksling krever TLS 1.3.',
  },
  nohttps: {
    label: 'Uten HTTPS', color: 'var(--critical)',
    icon: '<rect x="3.5" y="7.5" width="9" height="6" rx="1.2"/><path d="M5.5 7.5V5.2a2.5 2.5 0 0 1 4.8-1"/>',
    desc: 'Nettstedet svarer bare på ukryptert http.',
    advice: 'Innfør HTTPS med TLS 1.3, hybrid ML-KEM og HSTS. All trafikk kan i dag leses av alle på veien.',
  },
  error: {
    label: 'Utilgjengelig', color: 'var(--neutral)',
    icon: '<path d="M6 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.3"/><path d="M8 12.3v.01"/>',
    desc: 'Vi fikk ikke kontakt med nettstedet.',
    advice: 'Domenet kan være nedlagt eller feilregistrert. Er hjemmesiden i Enhetsregisteret riktig?',
  },
};
const ORDER = ['pqc', 'tls13', 'legacy', 'nohttps', 'error'];
const CATS = {
  stat: 'Statlige virksomheter',
  kommune: 'Kommuner',
  fylkeskommune: 'Fylkeskommuner',
  'kommunal-annen': 'Kommunale foretak og IKS',
  kirke: 'Kirke',
};
// Bare disse får egne sektorkort; resten kan filtreres i listen.
const MAIN_CATS = ['stat', 'kommune', 'fylkeskommune'];

// Oslo er både kommune og fylke, og regnes med i begge.
const isOslo = (r) => r.orgs[0]?.orgForm === 'KOMM' && r.orgs[0]?.name === 'OSLO KOMMUNE';
const inCat = (r, cat) => r.category === cat || (cat === 'fylkeskommune' && isOslo(r));
const PAGE = 60;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nb = (n) => n.toLocaleString('nb-NO');
const pct = (n, total) => (total ? (100 * n) / total : 0);
const fmtPct = (v, d = 0) => v.toLocaleString('nb-NO', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtDate = (d) => new Date(d).toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d) => new Date(d).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const icon = (st) => `<svg class="ic" viewBox="0 0 16 16" style="--c:${STATUS[st].color}" aria-hidden="true">${STATUS[st].icon}</svg>`;
const badge = (st) => `<span class="badge" style="--c:${STATUS[st].color}">${icon(st)}${esc(STATUS[st].label)}</span>`;
const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';

let data = null;
let hist = [];
const state = { q: '', cat: '', status: '', sort: 'status', limit: PAGE };

/* ---------- Oppstart ---------- */

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function init() {
  setupTheme();
  setupTooltips();
  setupDialog();

  try {
    data = await getJSON('data/latest.json');
  } catch {
    $('meta').textContent = '';
    $('empty').hidden = false;
    return;
  }
  hist = await getJSON('data/history.json').catch(() => []);
  for (const r of data.results) r._search = searchText(r);

  $('meta').textContent = `Sist målt ${fmtDate(data.generated)} · ${nb(data.total)} nettsteder`;
  $('hero').hidden = false;
  $('content').hidden = false;

  readHash();
  renderHero();
  renderSectors();
  renderTrend();
  setupFilters();
  setupSuggest();
  renderList();

  const p = new URLSearchParams(location.hash.slice(1));
  const site = p.get('site');
  if (site) openDetail(site);
}

function searchText(r) {
  return [r.host, r.finalHost, ...r.orgs.flatMap((o) => [o.name, o.parent, o.orgnr, o.municipality])]
    .filter(Boolean).join(' ').toLowerCase();
}

/* ---------- Tema ---------- */

function setupTheme() {
  const btn = $('theme');
  const icons = {
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  };
  const current = () => document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const paint = () => {
    const t = current();
    btn.innerHTML = t === 'dark' ? icons.light : icons.dark;
    btn.setAttribute('aria-label', t === 'dark' ? 'Bytt til lyst tema' : 'Bytt til mørkt tema');
  };
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ks-theme', next); } catch {}
    paint();
    renderTrend();
  });
  paint();
}

/* ---------- Verktøytips ---------- */

function setupTooltips() {
  const tip = $('tip');
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    placeTip(e.clientX, e.clientY);
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}

function placeTip(x, y) {
  const tip = $('tip');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8) + 'px';
  tip.style.top = (y - h - 14 < 8 ? y + 18 : y - h - 14) + 'px';
}

/* ---------- Toppseksjon ---------- */

function stackBar(counts, total, cls = '') {
  const segs = ORDER.filter((st) => counts[st]).map((st) => {
    const tip = `<b>${esc(STATUS[st].label)}</b><br>${nb(counts[st])} nettsteder · ${fmtPct(pct(counts[st], total), 1)} %`;
    return `<div style="flex:${counts[st]};background:${STATUS[st].color}" data-tip="${esc(tip)}"></div>`;
  }).join('');
  return `<div class="stack ${cls}">${segs}</div>`;
}

function renderHero() {
  const { counts, total } = data;
  const value = pct(counts.pqc || 0, total);
  countUp($('heroPct'), value);

  if (hist.length >= 2) {
    const first = hist[0];
    const diff = value - pct(first.counts.pqc || 0, first.total);
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
    $('heroDelta').innerHTML = `<span class="${diff > 0 ? 'up' : ''}">${sign}${fmtPct(Math.abs(diff), 1)} prosentpoeng</span> siden ${fmtDate(first.date)}`;
  } else {
    $('heroDelta').textContent = `${nb(counts.pqc || 0)} av ${nb(total)} nettsteder`;
  }

  $('overallBar').outerHTML = stackBar(counts, total).replace('class="stack ', 'id="overallBar" class="stack ');
  $('overallChips').innerHTML = statusChips(counts);
  $('overallChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    setFilter({ status: b.dataset.status });
    $('sites').scrollIntoView();
  });
}

function countUp(el, target) {
  if (reducedMotion) { el.textContent = fmtPct(target); return; }
  const start = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, Math.max(0, (t - start) / dur));
    el.textContent = fmtPct(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(() => { el.textContent = fmtPct(target); }, dur + 100); // i tilfelle rAF strupes
}

function statusChips(counts, active = '') {
  return ORDER.map((st) => `
    <button class="chip" type="button" data-status="${st}" aria-pressed="${active === st}">
      <span class="dot" style="--c:${STATUS[st].color}"></span>${esc(STATUS[st].label)}<span class="n">${nb(counts[st] || 0)}</span>
    </button>`).join('');
}

/* ---------- Sektorer ---------- */

function renderSectors() {
  $('sectorGrid').innerHTML = MAIN_CATS.map((c) => {
    const counts = {};
    for (const r of data.results) if (inCat(r, c)) counts[r.status] = (counts[r.status] || 0) + 1;
    const total = ORDER.reduce((s, st) => s + (counts[st] || 0), 0);
    return `<button class="sector" type="button" data-cat="${c}">
      <h3>${esc(CATS[c])}</h3>
      <div class="big">${fmtPct(pct(counts.pqc || 0, total))}<small>%</small></div>
      ${stackBar(counts, total, 'sm')}
      <div class="sub"><span>${nb(counts.pqc || 0)} av ${nb(total)} kvantesikre</span><span class="go">Se alle →</span></div>    </button>`;
  }).join('');
  $('sectorGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    setFilter({ cat: b.dataset.cat, status: '' });
    $('sites').scrollIntoView();
  });
}

/* ---------- Trend ---------- */

function renderTrend() {
  if (!data) return;
  const el = $('trend');
  if (hist.length < 2) {
    $('trendNote').textContent = '';
    el.innerHTML = `<div class="trend-empty"><div><strong>Grafen fylles på dag for dag</strong><br>Den første målingen ble gjort ${fmtDate(hist[0]?.date || data.date)}. Kurven vises fra og med dag to.</div></div>`;
    return;
  }
  const W = 720, H = 220, L = 40, R = 16, T = 16, B = 28;
  const pts = hist.map((h) => ({ date: h.date, v: pct(h.counts.pqc || 0, h.total), n: h.counts.pqc || 0, total: h.total }));
  const max = Math.min(100, Math.max(10, Math.ceil(Math.max(...pts.map((p) => p.v)) / 10) * 10));
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const last = pts[pts.length - 1];
  $('trendNote').textContent = `Andel kvantesikre, ${hist.length} målinger`;
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Andel kvantesikre nettsteder over tid, fra ${fmtPct(pts[0].v, 1)} til ${fmtPct(last.v, 1)} prosent">
      <defs><linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="var(--good)" stop-opacity="0.28"/><stop offset="1" stop-color="var(--good)" stop-opacity="0"/>
      </linearGradient></defs>
      ${ticks.map((t) => `<line class="${t ? 'grid' : 'base'}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t} %</text>`).join('')}
      <path d="${area}" fill="url(#fade)"/>
      <path d="${line}" fill="none" stroke="var(--good)" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${x(pts.length - 1)}" cy="${y(last.v)}" r="4.5" fill="var(--good)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${L}" y="${H - 6}">${esc(shortDate(pts[0].date))}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(shortDate(last.date))}</text>
      <g id="cross" visibility="hidden"><line class="cross" y1="${T}" y2="${y(0)}"/><circle r="5" fill="var(--good)" stroke="var(--surface)" stroke-width="2"/></g>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="hover"/>
    </svg>`;
  const svg = el.querySelector('svg'), cross = svg.querySelector('#cross'), tip = $('tip');
  svg.querySelector('#hover').addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - L) / (W - L - R)) * (pts.length - 1))));
    const p = pts[i];
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('line').setAttribute('x1', x(i));
    cross.querySelector('line').setAttribute('x2', x(i));
    cross.querySelector('circle').setAttribute('cx', x(i));
    cross.querySelector('circle').setAttribute('cy', y(p.v));
    tip.innerHTML = `<b>${esc(fmtDate(p.date))}</b><br>${fmtPct(p.v, 1)} % kvantesikre (${nb(p.n)} av ${nb(p.total)})`;
    tip.hidden = false;
    placeTip(r.left + (x(i) / W) * r.width, r.top + (y(p.v) / H) * r.height);
    e.stopPropagation();
  });
  svg.querySelector('#hover').addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

/* ---------- Filtre ---------- */

function setupFilters() {
  $('cat').innerHTML = '<option value="">Alle sektorer</option>' +
    Object.entries(CATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  syncControls();

  $('q').addEventListener('input', (e) => setFilter({ q: e.target.value }, false));
  $('cat').addEventListener('change', (e) => setFilter({ cat: e.target.value }));
  $('sort').addEventListener('change', (e) => setFilter({ sort: e.target.value }));
  $('statusChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) setFilter({ status: state.status === b.dataset.status ? '' : b.dataset.status });
  });
  $('reset').addEventListener('click', () => setFilter({ q: '', cat: '', status: '' }));
  $('noHits').addEventListener('click', (e) => {
    if (e.target.closest('[data-reset]')) setFilter({ q: '', cat: '', status: '' });
  });
  $('more').addEventListener('click', () => { state.limit += PAGE; renderList(); });
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-host]');
    if (tr && !e.target.closest('a')) openDetail(tr.dataset.host);
  });
  $('rows').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-host]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(tr.dataset.host); }
  });
}

function setFilter(patch, sync = true) {
  Object.assign(state, patch, { limit: PAGE });
  if (sync) syncControls();
  writeHash();
  renderList();
}

function syncControls() {
  $('q').value = state.q;
  $('cat').value = state.cat;
  $('sort').value = state.sort;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of ['q', 'cat', 'status', 'sort']) if (p.get(k)) state[k] = p.get(k);
}

function writeHash(site) {
  const p = new URLSearchParams();
  for (const k of ['q', 'cat', 'status']) if (state[k]) p.set(k, state[k]);
  if (state.sort !== 'status') p.set('sort', state.sort);
  if (site) p.set('site', site);
  history.replaceState(null, '', p.toString() ? '#' + p : location.pathname + location.search);
}

// Et nettsted er "felles" når flere virksomheter deler det uten en klar eier,
// f.eks. kirken.no (333 sokn) eller politiet.no (alle politidistriktene).
function isShared(r) {
  const [main, ...rest] = r.orgs || [];
  if (!main || rest.length < 2) return false;
  if (main.source === 'manuell' || main.orgForm === 'KOMM' || main.orgForm === 'FYLK') return false;
  if (main.orgForm === 'STAT' && !rest.some((o) => o.orgForm === 'STAT')) return false;
  return true;
}
const siteName = (r) => (r.finalHost || r.host).replace(/^www\./, '');
const nameOf = (r) => (isShared(r) ? siteName(r) : prettyName(r.orgs?.[0]?.name)) || r.host;

// Enhetsregisteret bruker STORE BOKSTAVER. Gjør om til vanlig skrivemåte,
// men behold forkortelser som HF, IKS og (NVE).
const ACRONYMS = new Set(['AS', 'ASA', 'SA', 'SF', 'HF', 'RHF', 'IKS', 'KF', 'FKF', 'BA', 'DA', 'NAV', 'NTNU', 'NMBU', 'NHH', 'OSLOMET', 'UIT', 'IPR', 'IUA', 'IKT', 'NKS', 'SIKT', 'NRK', 'KS']);
const LOWER = new Set(['og', 'i', 'for', 'av', 'på', 'til', 'med', 'under', 'kommune', 'fylkeskommune', 'herad', 'sokn', 'menighet', 'kirkelige', 'fellesråd', 'kyrkjelege', 'sokneråd', 'menighetsråd', 'departementet', 'direktorat', 'direktoratet']);
const nameCache = new Map();
function prettyName(name) {
  if (!name || name !== name.toUpperCase()) return name;
  if (nameCache.has(name)) return nameCache.get(name);
  const out = name.toLowerCase().split(/(\s+|-|\/|\(|\))/).map((w, i) => {
    if (!/\p{L}/u.test(w)) return w;
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    if (i > 0 && LOWER.has(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  }).join('').replace(/\((\p{L}{2,5})\)/gu, (_, a) => `(${a.toUpperCase()})`);
  nameCache.set(name, out);
  return out;
}
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'nb');

function filtered(ignoreStatus = false) {
  const words = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = data.results.filter((r) =>
    (!state.cat || inCat(r, state.cat)) &&
    (ignoreStatus || !state.status || r.status === state.status) &&
    words.every((w) => r._search.includes(w)));
  const cmp = {
    status: (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || byName(a, b),
    name: byName,
    host: (a, b) => (a.finalHost || a.host).localeCompare(b.finalHost || b.host),
    since: (a, b) => (b.since || '').localeCompare(a.since || '') || byName(a, b),
  }[state.sort] || byName;
  return rows.sort(cmp);
}

/* ---------- Liste ---------- */

function renderList() {
  const base = filtered(true);
  const counts = {};
  for (const r of base) counts[r.status] = (counts[r.status] || 0) + 1;
  $('statusChips').innerHTML = statusChips(counts, state.status);

  const rows = state.status ? base.filter((r) => r.status === state.status) : base;
  const filteredOn = state.q || state.cat || state.status;
  $('count').textContent = filteredOn
    ? `${nb(rows.length)} av ${nb(data.total)} nettsteder`
    : `${nb(data.total)} nettsteder`;
  $('reset').hidden = !filteredOn;
  $('noHits').hidden = rows.length > 0;
  if (!rows.length) {
    $('noHits').innerHTML = state.q.trim() && !base.length
      ? notFound(state.q.trim())
      : 'Ingen treff med disse filtrene. <button class="link-btn" type="button" data-reset>Nullstill filtre</button>';
  }

  $('rows').innerHTML = rows.slice(0, state.limit).map((r) => {
    const org = r.orgs[0] || {};
    let sub = org.parent ? `under ${prettyName(org.parent)}` : [org.municipality && titleCase(org.municipality), CATS[r.category]].filter(Boolean)[0] || '';
    const shared = isShared(r);
    if (shared) sub = `Felles nettsted for ${nb(r.orgs.length)} virksomheter`;
    const others = !shared && r.orgs.length > 1 ? ` · +${nb(r.orgs.length - 1)} andre` : '';
    return `<tr data-host="${esc(r.host)}" tabindex="0" aria-label="${esc(nameOf(r))}, ${esc(STATUS[r.status].label)}">
      <td><div class="name">${esc(nameOf(r))}</div><div class="sub">${esc(sub)}${others}</div></td>
      <td class="host">${esc(r.finalHost || r.host)}</td>
      <td class="c-status">${badge(r.status)}</td>
      <td class="c-group mono">${esc(r.group || '–')}</td>
      <td class="c-since sub">${r.since ? esc(shortDate(r.since)) : ''}</td>
      <td class="chev">${chevron}</td>
    </tr>`;
  }).join('');
  $('more').hidden = rows.length <= state.limit;
  $('more').textContent = `Vis flere (${nb(rows.length - state.limit)} igjen)`;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

/* ---------- Ikke funnet ---------- */

const DOMAIN_RE = /^(https?:\/\/)?([a-z0-9æøå-]+\.)+[a-z]{2,}(\/.*)?$/i;

function notFound(q) {
  const domain = DOMAIN_RE.test(q) ? q.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() : '';
  const cmd = domain ? `openssl s_client -connect ${domain}:443 -groups X25519MLKEM768 -brief` : '';
  return `
    <p><strong>Fant ikke «${esc(q)}»</strong></p>
    <p>Vi måler nettstedene til statlige virksomheter, kommuner og fylkeskommuner, og tjenester knyttet til dem.
      Andre nettsteder kan du sjekke selv:</p>
    <p><a href="https://www.digicert.com/pqc-checker" target="_blank" rel="noopener">Sjekk med DigiCert PQC Checker ↗</a></p>
    ${cmd ? `<p class="sub">Eller med OpenSSL 3.5+:</p><div class="cmd"><code>${esc(cmd)}</code><button class="btn" type="button" data-copy="${esc(cmd)}">Kopier</button></div>` : ''}`;
}

document.addEventListener('click', (e) => {
  const copy = e.target.closest('.s-empty [data-copy], .no-hits [data-copy]');
  if (copy) copyText(copy.dataset.copy, copy);
});

/* ---------- Hurtigsøk ---------- */

function setupSuggest() {
  const input = $('heroSearch'), box = $('suggest');
  const PICKABLE = 'button[data-i], button[data-all]';
  let items = [], sel = -1;
  const show = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; return; }
    const words = q.split(/\s+/);
    items = data.results.filter((r) => words.every((w) => r._search.includes(w)))
      .sort((a, b) => (nameOf(a).toLowerCase().startsWith(q) ? 0 : 1) - (nameOf(b).toLowerCase().startsWith(q) ? 0 : 1) || byName(a, b))
      .slice(0, 7);
    sel = -1;
    box.innerHTML = items.length
      ? items.map((r, i) => `
        <button type="button" data-i="${i}" role="option">${icon(r.status)}<span class="s-name">${esc(nameOf(r))}</span><span class="s-host">${esc(r.finalHost || r.host)}</span></button>`).join('') +
        `<button type="button" data-all="1" class="s-all">Vis alle treff for «${esc(input.value.trim())}» →</button>`
      : `<div class="s-empty">${notFound(input.value.trim())}</div>`;
    box.hidden = false;
  };
  const pick = (btn) => {
    if (!btn) return;
    box.hidden = true;
    if (btn.dataset.all) {
      setFilter({ q: input.value.trim(), cat: '', status: '' });
      $('sites').scrollIntoView();
    } else {
      openDetail(items[+btn.dataset.i].host);
    }
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', (e) => {
    const btns = [...box.querySelectorAll(PICKABLE)];
    if (!btns.length) { if (e.key === 'Escape') box.hidden = true; return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.setAttribute('aria-selected', i === sel));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(sel >= 0 ? btns[sel] : btns[btns.length - 1]);
    } else if (e.key === 'Escape') {
      box.hidden = true;
    }
  });
  box.addEventListener('click', (e) => pick(e.target.closest(PICKABLE)));
  document.addEventListener('click', (e) => { if (!e.target.closest('.hero-side')) box.hidden = true; });
}

/* ---------- Detaljpanel ---------- */

const closeBtn = '<button class="icon-btn" type="button" data-close aria-label="Lukk"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';

function setupDialog() {
  const dlg = $('detail');
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) closeDetail();
    const copy = e.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy, copy);
    const share = e.target.closest('[data-share]');
    if (share) copyText(location.href, share);
  });
  dlg.addEventListener('close', () => writeHash());
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDetail(); }); // Esc lukker med animasjon
}

function showDialog(html) {
  const dlg = $('detail');
  $('detailBody').innerHTML = html;
  dlg.classList.remove('closing');
  if (!dlg.open) dlg.showModal();
  dlg.focus(); // fokus på selve vinduet, ikke første lenke/knapp
  dlg.scrollTop = 0;
}

function openDetail(host) {
  const r = data.results.find((x) => x.host === host);
  if (!r) return;
  showDialog(detailHTML(r));
  writeHash(r.host);
}

function detailHTML(r) {
  const s = STATUS[r.status];
  const site = r.finalHost || r.host;
  const expired = r.certExpires && new Date(r.certExpires) < new Date();
  const fact = (k, v, cls = '') => v ? `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>` : '';
  const orgItem = (o) => {
    const link = o.orgnr ? ` · <a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${esc(o.orgnr)}" target="_blank" rel="noopener">${esc(o.orgnr)}</a>` : '';
    const sub = [o.parent && `under ${esc(prettyName(o.parent))}`, o.municipality && esc(titleCase(o.municipality))].filter(Boolean).join(' · ');
    return `<li>${esc(prettyName(o.name))}${link}${sub ? `<div class="sub">${sub}</div>` : ''}</li>`;
  };
  const orgs = r.orgs || [];
  const shared = isShared(r);
  const [main, ...rest] = shared ? [null, ...orgs] : orgs;
  const MAX_OTHERS = 50;
  const others = rest.length ? `
    <details class="more-orgs"${shared ? ' open' : ''}>
      <summary>${shared ? `Felles nettsted for ${nb(rest.length)} virksomheter`
        : `${rest.length === 1 ? 'Én annen virksomhet' : `${nb(rest.length)} andre virksomheter`} bruker samme nettsted`}</summary>
      <ul class="orgs">${rest.slice(0, MAX_OTHERS).map(orgItem).join('')}${rest.length > MAX_OTHERS ? `<li class="sub">… og ${nb(rest.length - MAX_OTHERS)} til</li>` : ''}</ul>
    </details>` : '';
  const cmd = `openssl s_client -connect ${site}:443 -groups X25519MLKEM768 -brief`;

  return `
    <div class="d-top">
      <div>
        <h2 id="dTitle">${esc(nameOf(r))}</h2>
        <a href="https://${esc(site)}/" target="_blank" rel="noopener">${esc(site)} ↗</a>
        ${r.finalHost ? `<div class="muted">videresendt fra ${esc(r.host)}</div>` : ''}
      </div>
      ${closeBtn}
    </div>

    <div class="d-verdict" style="--c:${s.color}">
      ${badge(r.status)}
      <p><strong>${esc(s.desc)}</strong>${r.error ? ` (${esc(r.error)})` : ''}</p>
      <p>${esc(s.advice)}</p>
    </div>

    <dl class="facts">
      ${fact('Nøkkelutveksling', esc(r.group))}
      ${fact('TLS-versjon', esc(r.tlsVersion))}
      ${fact('Chiffer', esc(r.cipher))}
      ${fact('HSTS', r.tlsVersion ? (r.hsts ? 'Ja' : 'Nei') : '')}
      ${fact('Sertifikat', [r.certKey, r.certIssuer].filter(Boolean).map(esc).join(' · '))}
      ${fact('Utløper', r.certExpires ? esc(r.certExpires) + (expired ? ' (utløpt)' : '') : '', expired ? 'warn' : '')}
      ${fact('Gyldig sertifikat', r.certExpires ? (r.certValid ? 'Ja' : 'Nei') : '', r.certExpires && !r.certValid ? 'warn' : '')}
      ${fact('CDN', esc(r.cdn))}
      ${fact('Status siden', r.since ? esc(fmtDate(r.since)) : '')}
      ${fact('Sektor', esc(CATS[r.category] || r.category))}
    </dl>

    <div class="d-section">
      <h3>${shared ? 'Virksomheter' : 'Virksomhet'}</h3>
      ${main ? `<ul class="orgs">${orgItem(main)}</ul>` : ''}
      ${others}
    </div>

    <div class="d-section">
      <h3>Sjekk selv</h3>
      <div class="cmd"><code>${esc(cmd)}</code><button class="btn" type="button" data-copy="${esc(cmd)}">Kopier</button></div>
    </div>

    <div class="d-actions">
      <button class="btn primary" type="button" data-share>Kopier lenke til nettstedet</button>
    </div>`;
}

function closeDetail() {
  const dlg = $('detail');
  if (!dlg.open || dlg.classList.contains('closing')) return;
  if (reducedMotion) { dlg.close(); return; }
  dlg.classList.add('closing');
  dlg.addEventListener('animationend', () => {
    dlg.classList.remove('closing');
    dlg.close();
  }, { once: true });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Kopiert ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch {}
}

init();
