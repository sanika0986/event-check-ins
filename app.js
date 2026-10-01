'use strict';
/* EventCheck SPA — vanilla JS, History-API router. Heavy libs (QR, charts, scanner) are lazy-loaded. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssUrl = u => String(u).replace(/[^\w:\/.\-?=&%+#;,~@!$*]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = t => { const [h, m] = t.split(':'); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const fmtDT = i => (i ? new Date(i).toLocaleString() : '—');
const LIB = {
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
  chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  scan: 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
};
let me = null; const charts = [], cleanups = [], loaded = {};
const loadScript = u => loaded[u] ||= new Promise((ok, no) => { const s = document.createElement('script'); s.src = u; s.onload = ok; s.onerror = () => { delete loaded[u]; no(new Error('Could not load a required library. Check your connection.')); }; document.head.append(s); });

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try { r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw Object.assign(new Error('Network error. Please check your connection and try again.'), { data: { code: 'NETWORK' } }); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) me = null; throw Object.assign(new Error(d.error || 'Server error'), { status: r.status, data: d }); }
  return d;
}
function toast(msg, type = '') { const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 4500); }
function modal(html) {
  const o = document.createElement('div'); o.className = 'ov'; o.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const k = e => e.key === 'Escape' && o.close(); o.close = () => { o.remove(); document.removeEventListener('keydown', k); };
  document.addEventListener('keydown', k); o.addEventListener('click', e => e.target === o && o.close()); document.body.append(o); return o;
}
const confirmBox = (title, msg, ok = 'Confirm', danger = true) => new Promise(res => {
  const o = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p><div class="row mt" style="justify-content:flex-end"><button class="btn sec" data-n>Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-y>${esc(ok)}</button></div>`);
  $('[data-n]', o).onclick = () => { o.close(); res(false); }; $('[data-y]', o).onclick = () => { o.close(); res(true); }; $('[data-y]', o).focus();
});
const debounce = (f, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

// ---------- shells ----------
const skel = '<div class="card"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>';
const empty = (ic, title, extra = '') => `<div class="empty card"><div class="ic">${ic}</div><h3>${esc(title)}</h3>${extra}</div>`;
const setView = html => { $('#app').innerHTML = html; window.scrollTo(0, 0); };
const pubShell = (inner, pre = '') => `<nav class="pubnav"><a class="brand" href="/"><span class="logo"></span>EventCheck</a><a href="/events">Events</a><span class="grow"></span>${me ? '<a class="btn sm" href="/dashboard">Dashboard</a>' : '<a href="/login">Log in</a><a class="btn sm" href="/register">Sign up</a>'}</nav>${pre}<div class="wrap">${inner}</div>`;
const authShell = inner => `<div class="narrow"><a class="brand mb" href="/"><span class="logo"></span>EventCheck</a><div class="card">${inner}</div></div>`;
const NAV = [['overview', '/dashboard', '📊 Overview'], ['events', '/dashboard/events', '🎫 Events'], ['registrations', '/dashboard/registrations', '👥 Registrations'], ['scanner', '/dashboard/scanner', '📷 Scanner'], ['reports', '/dashboard/reports', '📈 Reports'], ['profile', '/dashboard/profile', '⚙️ Profile']];
function dashView(active, inner) {
  setView(`<div class="shell"><aside class="side" id="side"><a class="brand" href="/dashboard"><span class="logo"></span>EventCheck</a><nav aria-label="Main">${NAV.map(([k, h, l]) => `<a href="${h}" class="${k === active ? 'on' : ''}">${l}</a>`).join('')}</nav><div class="muted small mb">${esc(me.name)}</div><button class="btn sec" id="logout">Log out</button></aside><div class="main"><header class="topbar"><button class="icon-btn menu" id="menu" aria-label="Open menu">☰</button><span class="grow"></span><span class="muted small">${esc(me.email)}</span></header><main class="content">${inner}</main></div></div>`);
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); me = null; toast('Logged out'); go('/login'); };
}

// ---------- forms ----------
const fld = (label, name, o = {}) => `<div class="field"><label for="f-${name}">${label}${o.req ? ' *' : ''}</label><input id="f-${name}" name="${name}" type="${o.type || 'text'}" value="${esc(o.value ?? '')}" ${o.req ? 'required' : ''} ${o.attrs || ''} ${o.ph ? `placeholder="${esc(o.ph)}"` : ''}></div>`;
const formData = f => Object.fromEntries(new FormData(f));
function showErrors(form, err) {
  $$('.err-t', form).forEach(x => x.remove()); $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
  for (const [k, v] of Object.entries(err.data?.fields || {})) { const i = form.elements[k]; if (i) { i.classList.add('invalid'); i.insertAdjacentHTML('afterend', `<div class="err-t" role="alert">${esc(v)}</div>`); } }
}
async function submit(form, fn) {
  const b = $('[type=submit]', form), t = b.textContent; b.disabled = true; b.textContent = 'Please wait…';
  try { await fn(); } catch (err) { showErrors(form, err); toast(err.message, 'err'); } finally { b.disabled = false; b.textContent = t; }
}
const pager = d => `<div class="pager"><span class="muted small">${d.total} result${d.total === 1 ? '' : 's'} · Page ${d.page} of ${d.pages}</span><button class="btn sec sm" data-pg="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sec sm" data-pg="${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>Next</button></div>`;
const stat = (l, v, sub = '') => `<div class="card stat"><div class="l">${l}</div><div class="v">${v}</div>${sub}</div>`;
const errorView = e => {
  if (e.status === 401) return go('/login?next=' + encodeURIComponent(location.pathname), true);
  const h = `<div class="empty card"><div class="ic">⚠️</div><h3>${esc(e.status === 404 ? 'Not found' : 'Something went wrong')}</h3><p>${esc(e.message)}</p><button class="btn" onclick="render()">Try again</button> <a class="btn sec" href="/">Home</a></div>`;
  me && location.pathname.startsWith('/dashboard') ? dashView('', h) : setView(pubShell(h));
};

// ---------- QR + charts ----------
async function qrCanvas(text, size = 560) {
  await loadScript(LIB.qr); const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, cs = Math.max(2, Math.floor(size / (n + 2 * m))), s = cs * (n + 2 * m);
  const c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect((k + m) * cs, (r + m) * cs, cs, cs);
  return c;
}
async function chart(id, cfg) {
  try { await loadScript(LIB.chart); } catch { return; }
  const el = document.getElementById(id); if (!el) return;
  charts.push(new Chart(el, { ...cfg, options: { responsive: true, maintainAspectRatio: false, ...cfg.options } }));
}
const IND = '#4f46e5', GRN = '#16a34a', GRY = '#e5e7eb';
const lineCfg = (rows, label, color) => ({ type: 'line', data: { labels: rows.map(r => r.label), datasets: [{ label, data: rows.map(r => r.count), borderColor: color, backgroundColor: color + '22', fill: true, tension: .3 }] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { display: false } } } });
const donutCfg = (a, b) => ({ type: 'doughnut', data: { labels: ['Checked in', 'Not checked in'], datasets: [{ data: [a, b], backgroundColor: [GRN, GRY] }] }, options: { cutout: '65%' } });
const chartCard = (t, id) => `<div class="card"><h3>${t}</h3><div class="chart"><canvas id="${id}" role="img" aria-label="${t}"></canvas></div></div>`;

// ---------- router ----------
const routes = []; const route = (re, fn, auth) => routes.push([re, fn, auth]);
let rid = 0;
async function render() {
  cleanups.splice(0).forEach(f => { try { f(); } catch {} }); charts.splice(0).forEach(c => c.destroy());
  const p = location.pathname.replace(/\/+$/, '') || '/', my = ++rid;
  for (const [re, fn, auth] of routes) {
    const m = p.match(re); if (!m) continue;
    if (auth && !me) return go('/login?next=' + encodeURIComponent(location.pathname), true);
    try { await fn(m.slice(1)); } catch (e) { if (my === rid) errorView(e); }
    return;
  }
  setView(pubShell(empty('🔍', 'Page not found', '<a class="btn" href="/">Go home</a>')));
}
function go(path, replace) { history[replace ? 'replaceState' : 'pushState'](null, '', path); return render(); }
window.addEventListener('popstate', render);
document.addEventListener('click', e => {
  const a = e.target.closest('a'); if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || a.origin !== location.origin || a.pathname.startsWith('/api/') || (a.getAttribute('href') || '').startsWith('#')) return;
  e.preventDefault(); $('#side')?.classList.remove('open'); go(a.pathname + a.search);
});

// ---------- public pages ----------
const eventCard = e => `<a class="card ecard" href="/events/${e.id}" style="text-decoration:none;color:inherit"><div class="img" ${e.imageUrl ? `style="background-image:url('${cssUrl(e.imageUrl)}')"` : ''}></div><div class="b"><span><span class="badge p">${fmtDate(e.date)}</span></span><h3>${esc(e.name)}</h3><div class="muted small">📍 ${esc(e.venue)} · ${fmtTime(e.startTime)}</div><div class="small ${e.closedReason ? 'err-t' : 'muted'}">${e.closedReason ? esc(e.closedReason) : e.availableSeats + ' seats left'}</div></div></a>`;

route(/^\/$/, async () => {
  setView(pubShell(skel));
  const { events } = await api('/events');
  const hero = `<section class="hero"><h1>Event check-in, without the queue.</h1><p>Create events, register attendees, and check them in at the door with secure QR codes — all in one place.</p><a class="btn" href="${me ? '/dashboard/events/create' : '/register'}">${me ? 'Create an event' : 'Get started free'}</a> <a class="btn sec" href="/events">Browse events</a></section>`;
  setView(pubShell(`<h2>Upcoming events</h2>${events.length ? `<div class="grid g3">${events.slice(0, 6).map(eventCard).join('')}</div>` : empty('🎟️', 'No upcoming events yet')}`, hero));
});

route(/^\/events$/, async () => {
  setView(pubShell(`<div class="row between mb"><h1>Events</h1><input id="q" type="search" placeholder="Search events or venues…" aria-label="Search events" style="max-width:320px"></div><div id="list">${skel}</div>`));
  const load = async () => {
    try { const { events } = await api('/events?q=' + encodeURIComponent($('#q').value)); $('#list').innerHTML = events.length ? `<div class="grid g3">${events.map(eventCard).join('')}</div>` : empty('🔍', 'No events found', '<p>Try a different search.</p>'); }
    catch (e) { $('#list').innerHTML = empty('⚠️', e.message); }
  };
  $('#q').oninput = debounce(load); load();
});

route(/^\/events\/([\w-]+)$/, async ([id]) => {
  setView(pubShell(skel));
  const { event: e } = await api('/events/' + id);
  setView(pubShell(`<div class="banner" ${e.imageUrl ? `style="background-image:url('${cssUrl(e.imageUrl)}')"` : ''} role="img" aria-label="Event banner"></div>
  <div class="grid g2 mt" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="card" style="grid-column:span 1"><h1>${esc(e.name)}</h1><p class="muted">Organized by ${esc(e.organizerName)}</p><p style="white-space:pre-wrap">${esc(e.description) || 'No description provided.'}</p></div>
  <div class="card"><h3>Details</h3><p>📅 ${fmtDate(e.date)}<br>🕒 ${fmtTime(e.startTime)} – ${fmtTime(e.endTime)}<br>📍 ${esc(e.venue)}<br><span class="muted">${esc(e.address)}</span></p>
  <p><strong>${e.availableSeats}</strong> of ${e.capacity} seats available</p><div class="bar mb"><i style="width:${Math.min(100, e.registered / e.capacity * 100)}%"></i></div>
  ${e.closedReason ? `<div class="alert">${esc(e.closedReason)}</div>` : `<a class="btn block" href="/events/${e.id}/register">Register now</a>`}</div></div>`));
});

route(/^\/events\/([\w-]+)\/register$/, async ([id]) => {
  setView(pubShell(skel));
  const { event: e } = await api('/events/' + id);
  if (e.closedReason) return setView(pubShell(`<div class="card"><h2>${esc(e.name)}</h2><div class="alert">${esc(e.closedReason)}</div><a class="btn sec" href="/events/${e.id}">Back to event</a></div>`));
  setView(pubShell(`<div style="max-width:560px;margin:0 auto"><a href="/events/${e.id}" class="muted small">← ${esc(e.name)}</a><div class="card mt"><h1>Register</h1><p class="muted">${fmtDate(e.date)} · ${esc(e.venue)}</p><form id="f" novalidate>
  ${fld('Full name', 'name', { req: 1, attrs: 'autocomplete="name"' })}${fld('Email', 'email', { type: 'email', req: 1, attrs: 'autocomplete="email"' })}${fld('Phone number', 'phone', { type: 'tel', req: 1, attrs: 'autocomplete="tel"' })}${fld('Organization / College', 'organization', { req: 1 })}
  ${e.customFields.map((c, i) => fld(esc(c), 'cf' + i)).join('')}<button class="btn block" type="submit">Complete registration</button></form></div></div>`));
  $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => {
    const d = formData(ev.target), customAnswers = {}; e.customFields.forEach((c, i) => customAnswers[c] = d['cf' + i] || '');
    const r = await api(`/events/${e.id}/register`, { method: 'POST', body: { name: d.name, email: d.email, phone: d.phone, organization: d.organization, customAnswers } });
    toast('Registration successful!', 'ok'); go('/registration/success/' + r.registrationId);
  }); };
});

route(/^\/registration\/success\/([\w-]+)$/, async ([id]) => {
  setView(pubShell(skel));
  const { registration: r, event: e } = await api('/registrations/' + id);
  const canvas = await qrCanvas(JSON.stringify(r.qrPayload)), url = canvas.toDataURL('image/png');
  setView(pubShell(`<div style="max-width:620px;margin:0 auto" class="card center"><div style="font-size:2.5rem">🎉</div><h1>You're registered!</h1><p class="muted">Show this QR code at the entrance of <strong>${esc(e.name)}</strong>.</p>
  <div class="printable"><h2 class="mt">${esc(e.name)}</h2><div class="qrbox"><img src="${url}" alt="Your check-in QR code" width="240" height="240"></div>
  <p><strong>${esc(r.name)}</strong><br>${esc(r.email)}<br><span class="badge p">${esc(r.attendeeId)}</span></p><p class="muted small">${fmtDate(e.date)} · ${fmtTime(e.startTime)} · ${esc(e.venue)}</p></div>
  <div class="row mt" style="justify-content:center"><a class="btn" download="eventcheck-${esc(r.attendeeId)}.png" href="${url}">⬇ Download QR</a><button class="btn sec" id="print">🖨 Print</button></div>
  <p class="muted small mt">Keep this page bookmarked — your QR code is personal. Don't share it.</p></div>`));
  $('#print').onclick = () => window.print();
});

// ---------- auth pages ----------
route(/^\/login$/, async () => {
  if (me) return go('/dashboard', true);
  setView(authShell(`<h1>Welcome back</h1><p class="muted">Log in to manage your events.</p><form id="f" novalidate>${fld('Email', 'email', { type: 'email', req: 1, attrs: 'autocomplete="email"' })}${fld('Password', 'password', { type: 'password', req: 1, attrs: 'autocomplete="current-password"' })}<button class="btn block" type="submit">Log in</button></form><p class="small mt"><a href="/forgot-password">Forgot password?</a> · <a href="/register">Create account</a></p>`));
  $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => { me = (await api('/auth/login', { method: 'POST', body: formData(ev.target) })).user; toast('Welcome back, ' + me.name, 'ok'); go(safeNext(new URLSearchParams(location.search).get('next'))); }); };
});
route(/^\/register$/, async () => {
  if (me) return go('/dashboard', true);
  setView(authShell(`<h1>Create your account</h1><p class="muted">Start running smoother events.</p><form id="f" novalidate>${fld('Full name', 'name', { req: 1, attrs: 'autocomplete="name"' })}${fld('Email', 'email', { type: 'email', req: 1, attrs: 'autocomplete="email"' })}${fld('Password (min 8 characters)', 'password', { type: 'password', req: 1, attrs: 'autocomplete="new-password" minlength="8"' })}<button class="btn block" type="submit">Sign up</button></form><p class="small mt">Already have an account? <a href="/login">Log in</a></p>`));
  $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => { me = (await api('/auth/register', { method: 'POST', body: formData(ev.target) })).user; toast('Account created!', 'ok'); go('/dashboard'); }); };
});
route(/^\/forgot-password$/, async () => {
  const token = new URLSearchParams(location.search).get('token');
  if (token) {
    setView(authShell(`<h1>Set a new password</h1><form id="f" novalidate>${fld('New password', 'password', { type: 'password', req: 1, attrs: 'autocomplete="new-password" minlength="8"' })}<button class="btn block" type="submit">Reset password</button></form>`));
    $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => { await api('/auth/reset', { method: 'POST', body: { token, password: ev.target.password.value } }); toast('Password updated. Please log in.', 'ok'); go('/login'); }); };
    return;
  }
  setView(authShell(`<h1>Forgot password?</h1><p class="muted">Enter your email and we'll send a reset link.</p><div id="msg"></div><form id="f" novalidate>${fld('Email', 'email', { type: 'email', req: 1 })}<button class="btn block" type="submit">Send reset link</button></form><p class="small mt"><a href="/login">Back to login</a></p>`));
  $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => {
    const d = await api('/auth/forgot', { method: 'POST', body: { email: ev.target.email.value } });
    $('#msg').innerHTML = `<div class="alert ok">${esc(d.message)}${d.devLink ? `<br><small>Dev mode: <a href="${esc(d.devLink)}">open reset link</a></small>` : ''}</div>`;
  }); };
});

// ---------- dashboard ----------
const evHead = (e, tab) => `<a class="muted small" href="/dashboard/events">← All events</a><h1>${esc(e.name)} <span class="badge ${e.status === 'published' ? 'ok' : ''}">${e.status}</span></h1><div class="muted">${fmtDate(e.date)} · ${fmtTime(e.startTime)}–${fmtTime(e.endTime)} · ${esc(e.venue)}</div>
<div class="tabs">${[['', 'Overview'], ['/registrations', 'Registrations'], ['/check-ins', 'Check-ins'], ['/scanner', 'Scanner'], ['/edit', 'Edit']].map(([p, l]) => `<a href="/dashboard/events/${e.id}${p}" class="${tab === p ? 'on' : ''}">${l}</a>`).join('')}</div>`;
const sumCards = d => `<div class="grid g4 mb">${stat('Total events', d.totalEvents)}${stat('Upcoming events', d.upcomingEvents)}${stat('Total registrations', d.totalRegistrations)}${stat('Checked in', d.totalCheckIns, `<div class="small muted">${d.checkInRate}% of registrations</div>`)}</div>`;

route(/^\/dashboard$/, async () => {
  dashView('overview', skel); const d = await api('/dashboard');
  dashView('overview', `<div class="row between mb"><h1>Overview</h1><a class="btn" href="/dashboard/events/create">+ Create event</a></div>${sumCards(d)}<div class="grid g2">${chartCard('Registrations over time', 'c1')}${chartCard('Check-ins over time', 'c2')}</div>`);
  chart('c1', lineCfg(d.registrationsByDay, 'Registrations', IND)); chart('c2', lineCfg(d.checkinsByDay, 'Check-ins', GRN));
}, 1);

route(/^\/dashboard\/events$/, async () => {
  dashView('events', `<div class="row between mb"><h1>Events</h1><a class="btn" href="/dashboard/events/create">+ Create event</a></div><div class="card"><div class="row mb"><input id="q" type="search" class="grow" placeholder="Search events…" aria-label="Search events" style="max-width:340px"><select id="st" aria-label="Filter by status" style="max-width:180px"><option value="">All statuses</option><option value="published">Published</option><option value="draft">Draft</option></select></div><div id="tbl">${skel}</div></div>`);
  const load = async () => {
    try {
      const { events } = await api(`/events?mine=1&q=${encodeURIComponent($('#q').value)}&status=${$('#st').value}`);
      $('#tbl').innerHTML = events.length ? `<div class="tw"><table><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Registered</th><th>Checked in</th><th></th></tr></thead><tbody>${events.map(e => `<tr><td><a href="/dashboard/events/${e.id}"><strong>${esc(e.name)}</strong></a><div class="muted small">${esc(e.venue)}</div></td><td>${fmtDate(e.date)}</td><td><span class="badge ${e.status === 'published' ? 'ok' : ''}">${e.status}</span></td><td>${e.registered}/${e.capacity}</td><td>${e.checkedIn}</td><td class="row"><a class="btn sec sm" href="/dashboard/events/${e.id}/scanner">Scan</a><a class="btn sec sm" href="/dashboard/events/${e.id}/edit">Edit</a><button class="btn sec sm" data-pub="${e.id}" data-s="${e.status}">${e.status === 'published' ? 'Unpublish' : 'Publish'}</button><button class="btn sec sm" data-del="${e.id}" data-n="${esc(e.name)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : empty('🎫', 'No events yet', '<p>Create your first event to get started.</p><a class="btn" href="/dashboard/events/create">Create event</a>');
    } catch (e) { $('#tbl').innerHTML = empty('⚠️', e.message); }
  };
  $('#q').oninput = debounce(load); $('#st').onchange = load;
  $('#tbl').onclick = async ev => {
    const b = ev.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.pub) { await api(`/events/${b.dataset.pub}/status`, { method: 'PUT', body: { status: b.dataset.s === 'published' ? 'draft' : 'published' } }); toast('Event updated', 'ok'); load(); }
      if (b.dataset.del && await confirmBox('Delete event?', `"${b.dataset.n}" and all its registrations and check-ins will be permanently deleted.`, 'Delete')) { await api('/events/' + b.dataset.del, { method: 'DELETE' }); toast('Event deleted', 'ok'); load(); }
    } catch (e) { toast(e.message, 'err'); }
  };
  load();
}, 1);

async function eventForm(id) {
  const e = id ? (await api('/events/' + id)).event : { status: 'draft', registrationOpen: true, customFields: [], capacity: 100, organizerName: me.name };
  const cur = { img: e.imageUrl || '' };
  const body = `${id ? evHead(e, '/edit') : '<h1>Create event</h1>'}<form id="f" class="card" novalidate><div class="form-grid">${fld('Event name', 'name', { value: e.name, req: 1 })}${fld('Organizer name', 'organizerName', { value: e.organizerName })}${fld('Date', 'date', { type: 'date', value: e.date, req: 1 })}${fld('Maximum capacity', 'capacity', { type: 'number', value: e.capacity, req: 1, attrs: 'min="1" max="100000"' })}${fld('Start time', 'startTime', { type: 'time', value: e.startTime, req: 1 })}${fld('End time', 'endTime', { type: 'time', value: e.endTime, req: 1 })}${fld('Venue', 'venue', { value: e.venue, req: 1 })}${fld('Address', 'address', { value: e.address })}</div>
  <div class="field"><label for="f-description">Description</label><textarea id="f-description" name="description" rows="5">${esc(e.description)}</textarea></div>
  ${fld('Custom registration fields (comma separated, max 5)', 'customFields', { value: (e.customFields || []).join(', '), ph: 'T-shirt size, Dietary needs' })}
  <div class="field"><label for="f-imageUrl">Banner image</label><input id="f-imageUrl" name="imageUrl" placeholder="Paste an image URL…" value="${cur.img.startsWith('data:') ? '' : esc(cur.img)}"><div class="row mt"><input type="file" id="file" accept="image/*" aria-label="Upload banner" style="max-width:300px"><span class="muted small">or upload (auto-resized)</span></div><div id="prev" class="banner mt" style="height:140px;${cur.img ? `background-image:url('${cssUrl(cur.img)}')` : 'display:none'}"></div></div>
  <div class="form-grid"><div class="field"><label for="f-status">Status</label><select id="f-status" name="status"><option value="draft" ${e.status === 'draft' ? 'selected' : ''}>Draft (hidden)</option><option value="published" ${e.status === 'published' ? 'selected' : ''}>Published (public)</option></select></div>
  <div class="field"><label>Registration</label><label style="font-weight:400"><input type="checkbox" name="registrationOpen" ${e.registrationOpen ? 'checked' : ''}> Registration open</label></div></div>
  <div class="row"><button class="btn" type="submit">${id ? 'Save changes' : 'Create event'}</button><a class="btn sec" href="/dashboard/events">Cancel</a></div></form>`;
  dashView('events', body);
  const f = $('#f');
  f.imageUrl.oninput = () => { cur.img = f.imageUrl.value; $('#prev').style.cssText = cur.img ? `height:140px;background-image:url('${cssUrl(cur.img)}')` : 'display:none'; };
  $('#file').onchange = ev => {
    const file = ev.target.files[0]; if (!file) return;
    const img = new Image(); img.onload = () => {
      const s = Math.min(1, 1200 / img.width), c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cur.img = c.toDataURL('image/jpeg', .8); f.imageUrl.value = ''; $('#prev').style.cssText = `height:140px;background-image:url('${cur.img}')`;
    }; img.onerror = () => toast('That file is not a valid image.', 'err'); img.src = URL.createObjectURL(file);
  };
  f.onsubmit = ev => { ev.preventDefault(); submit(f, async () => {
    const d = formData(f), payload = { ...d, imageUrl: f.imageUrl.value.trim() || (cur.img.startsWith('data:') ? cur.img : ''), registrationOpen: f.registrationOpen.checked, customFields: d.customFields.split(',').map(s => s.trim()).filter(Boolean) };
    const r = await api(id ? '/events/' + id : '/events', { method: id ? 'PUT' : 'POST', body: payload });
    toast(id ? 'Event updated' : 'Event created', 'ok'); go('/dashboard/events/' + r.event.id);
  }); };
}
route(/^\/dashboard\/events\/create$/, () => eventForm(), 1);
route(/^\/dashboard\/events\/([\w-]+)\/edit$/, ([id]) => eventForm(id), 1);

route(/^\/dashboard\/events\/([\w-]+)$/, async ([id]) => {
  dashView('events', skel); const s = await api(`/events/${id}/statistics`), e = s.event, link = `${location.origin}/events/${e.id}`;
  dashView('events', `${evHead(e, '')}<div class="grid g4 mb">${stat('Registered', s.registered, `<div class="small muted">of ${s.capacity} seats</div>`)}${stat('Checked in', s.checkedIn)}${stat('Not checked in', s.notCheckedIn)}${stat('Check-in rate', s.checkInRate + '%')}</div>
  <div class="card mb"><div class="row between"><div><h3>Capacity utilization — ${s.utilization}%</h3><div class="bar" style="width:min(420px,70vw)"><i style="width:${Math.min(100, s.utilization)}%"></i></div></div><div class="row"><button class="btn sec sm" id="pub">${e.status === 'published' ? 'Unpublish' : 'Publish'}</button><a class="btn sm" href="/dashboard/events/${e.id}/scanner">Open scanner</a></div></div>
  ${e.status === 'published' ? `<p class="small mt">Public page: <a href="/events/${e.id}">${esc(link)}</a> <button class="btn ghost sm" id="copy">Copy link</button></p>` : '<p class="small muted mt">This event is a draft. Publish it to open the public registration page.</p>'}</div>
  <div class="grid g3">${chartCard('Registrations over time', 'c1')}${chartCard('Check-ins over time (hourly)', 'c2')}${chartCard('Checked in vs not', 'c3')}</div>`);
  $('#pub').onclick = async () => { try { await api(`/events/${e.id}/status`, { method: 'PUT', body: { status: e.status === 'published' ? 'draft' : 'published' } }); toast('Event updated', 'ok'); render(); } catch (x) { toast(x.message, 'err'); } };
  $('#copy')?.addEventListener('click', () => navigator.clipboard?.writeText(link).then(() => toast('Link copied', 'ok')));
  chart('c1', lineCfg(s.registrationsByDay, 'Registrations', IND)); chart('c2', lineCfg(s.checkinsByHour.map(r => ({ ...r, label: r.label.replace('T', ' ') + ':00' })), 'Check-ins', GRN)); chart('c3', donutCfg(s.checkedIn, s.notCheckedIn));
}, 1);

// attendee table, used per-event and across all events
async function regsPage(eventId) {
  const ev = eventId ? (await api('/events/' + eventId)).event : null, events = eventId ? [] : (await api('/events?mine=1')).events;
  const st = { q: '', status: '', sort: 'registered', dir: 'desc', page: 1, eventId: eventId || '' }; let rows = [];
  dashView(eventId ? 'events' : 'registrations', `${ev ? evHead(ev, '/registrations') : '<h1>Registrations</h1>'}<div class="card"><div class="row mb"><input id="q" type="search" class="grow" placeholder="Search name, email, phone, ID…" aria-label="Search attendees" style="max-width:320px">${ev ? '' : `<select id="ev" aria-label="Filter by event" style="max-width:220px"><option value="">All events</option>${events.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>`}<select id="stt" aria-label="Filter by check-in status" style="max-width:180px"><option value="">All attendees</option><option value="checked">Checked in</option><option value="pending">Not checked in</option></select><a class="btn sec sm" id="csv" href="#">⬇ Export CSV</a></div><div id="tbl">${skel}</div></div>`);
  const qs = (extra = {}) => new URLSearchParams({ ...st, pageSize: 10, ...extra }).toString();
  const load = async () => {
    try {
      const d = await api('/registrations?' + qs()); rows = d.registrations; $('#csv').href = '/api/registrations?' + qs({ format: 'csv' });
      const th = (k, l) => `<th class="s" data-s="${k}" aria-sort="${st.sort === k ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${l}${st.sort === k ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
      $('#tbl').innerHTML = rows.length ? `<div class="tw"><table><thead><tr>${th('name', 'Name')}${th('email', 'Email')}<th>Phone</th>${eventId ? '' : th('event', 'Event')}${th('registered', 'Registered')}<th>Status</th>${th('checkin', 'Check-in time')}<th></th></tr></thead><tbody>${rows.map((r, i) => `<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td>${eventId ? '' : `<td>${esc(r.eventName)}</td>`}<td>${fmtDT(r.registeredAt)}</td><td><span class="badge ${r.checkedIn ? 'ok' : 'warn'}">${r.checkedIn ? 'Checked in' : 'Not checked in'}</span></td><td>${fmtDT(r.checkedInAt)}</td><td><button class="btn sec sm" data-i="${i}">View</button></td></tr>`).join('')}</tbody></table></div>${pager(d)}` : empty('👥', 'No attendees found', '<p>Registrations will show up here.</p>');
    } catch (e) { $('#tbl').innerHTML = empty('⚠️', e.message); }
  };
  const reset = () => { st.page = 1; load(); };
  $('#q').oninput = debounce(() => { st.q = $('#q').value; reset(); }); $('#stt').onchange = () => { st.status = $('#stt').value; reset(); };
  $('#ev')?.addEventListener('change', () => { st.eventId = $('#ev').value; reset(); });
  $('#tbl').onclick = ev => {
    const th = ev.target.closest('th[data-s]'), pg = ev.target.closest('[data-pg]'), v = ev.target.closest('[data-i]');
    if (th) { st.dir = st.sort === th.dataset.s && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = th.dataset.s; reset(); }
    if (pg) { st.page = +pg.dataset.pg; load(); }
    if (v) { const r = rows[+v.dataset.i]; modal(`<h2>${esc(r.name)}</h2><dl style="display:grid;grid-template-columns:auto 1fr;gap:.4rem 1rem"><dt class="muted">Attendee ID</dt><dd>${esc(r.attendeeId)}</dd><dt class="muted">Registration ID</dt><dd style="word-break:break-all">${esc(r.id)}</dd><dt class="muted">Email</dt><dd>${esc(r.email)}</dd><dt class="muted">Phone</dt><dd>${esc(r.phone)}</dd><dt class="muted">Organization</dt><dd>${esc(r.organization)}</dd><dt class="muted">Event</dt><dd>${esc(r.eventName)}</dd><dt class="muted">Registered</dt><dd>${fmtDT(r.registeredAt)}</dd><dt class="muted">Check-in</dt><dd>${r.checkedIn ? fmtDT(r.checkedInAt) : 'Not checked in'}</dd>${Object.entries(r.customAnswers).map(([k, a]) => `<dt class="muted">${esc(k)}</dt><dd>${esc(a)}</dd>`).join('')}</dl><div class="row mt" style="justify-content:flex-end"><a class="btn" href="/registration/success/${r.id}">View QR</a></div>`); }
  };
  load();
}
route(/^\/dashboard\/registrations$/, () => regsPage(), 1);
route(/^\/dashboard\/events\/([\w-]+)\/registrations$/, ([id]) => regsPage(id), 1);

route(/^\/dashboard\/events\/([\w-]+)\/check-ins$/, async ([id]) => {
  dashView('events', skel); const [{ event: e }, { checkins }] = await Promise.all([api('/events/' + id), api(`/events/${id}/checkins`)]);
  dashView('events', `${evHead(e, '/check-ins')}<div class="card">${checkins.length ? `<div class="tw"><table><thead><tr><th>Attendee</th><th>Email</th><th>Attendee ID</th><th>Date</th><th>Time</th><th>Scanned by</th><th>Status</th></tr></thead><tbody>${checkins.map(k => { const d = new Date(k.checkedInAt); return `<tr><td><strong>${esc(k.name)}</strong></td><td>${esc(k.email)}</td><td>${esc(k.attendeeId)}</td><td>${d.toLocaleDateString()}</td><td>${d.toLocaleTimeString()}</td><td>${esc(k.scanner)}</td><td><span class="badge ok">${esc(k.status.replace('_', ' '))}</span></td></tr>`; }).join('')}</tbody></table></div>` : empty('✅', 'No check-ins yet', '<p>Scanned attendees will appear here.</p>')}</div>`);
}, 1);

route(/^\/dashboard\/scanner$/, async () => {
  dashView('scanner', skel); const { events } = await api('/events?mine=1');
  dashView('scanner', `<h1>Scanner</h1><div class="card" style="max-width:520px">${events.length ? `<label for="ev">Select event</label><select id="ev">${events.map(e => `<option value="${e.id}">${esc(e.name)} — ${fmtDate(e.date)}</option>`).join('')}</select><button class="btn mt" id="go">Open scanner</button>` : empty('📷', 'Create an event first', '<a class="btn" href="/dashboard/events/create">Create event</a>')}</div>`);
  $('#go') && ($('#go').onclick = () => go(`/dashboard/events/${$('#ev').value}/scanner`));
}, 1);

route(/^\/dashboard\/events\/([\w-]+)\/scanner$/, async ([id]) => {
  const { event: e } = await api('/events/' + id);
  dashView('events', `${evHead(e, '/scanner')}<div class="card"><div id="reader" aria-label="Camera preview"></div><div id="camerr"></div><div class="row mt" style="justify-content:center"><button class="btn sec sm" id="restart">Restart camera</button></div><div id="result" aria-live="assertive"><p class="muted center mt">Point the camera at an attendee's QR code.</p></div>
  <details class="mt"><summary class="muted">Enter code manually</summary><form id="manual" class="row mt"><input name="code" class="grow" placeholder="Paste QR contents" required aria-label="QR contents"><button class="btn" type="submit">Check in</button></form></details></div>`);
  await loadScript(LIB.scan);
  let sc = null, running = false, busy = false, last = '', lastT = 0;
  const show = (kind, title, rows = [], extra = '') => {
    $('#result').innerHTML = `<div class="result ${kind}"><h2>${kind === 'success' ? '✅' : kind === 'warn' ? '⚠️' : '❌'} ${esc(title)}</h2>${extra ? `<p>${esc(extra)}</p>` : ''}${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}</div>`;
    navigator.vibrate?.(kind === 'success' ? 80 : [60, 40, 60]);
  };
  const rowsOf = (d, label) => [['Attendee', d.attendee.name], ['Email', d.attendee.email], ['Event', d.eventName], [label, fmtDT(d.checkedInAt)], ['Registration ID', d.registrationId]];
  const handle = async text => {
    if (busy || (text === last && Date.now() - lastT < 4000)) return; // cooldown / debounce
    busy = true; last = text; lastT = Date.now();
    try { const d = await api(`/events/${id}/checkin`, { method: 'POST', body: { code: text } }); show('success', 'Check-in Successful', rowsOf(d, 'Check-in time')); }
    catch (err) {
      const c = err.data?.code;
      if (c === 'ALREADY') show('warn', 'Already Checked In', rowsOf(err.data, 'Originally checked in at'));
      else if (c === 'INVALID') show('error', 'Invalid QR Code', [], 'This code is not recognized.');
      else if (c === 'WRONG_EVENT') show('error', 'Wrong Event', [], 'This QR code belongs to another event.');
      else show('error', c === 'NETWORK' ? 'Network error' : 'Error', [], err.message);
    }
    setTimeout(() => { busy = false; }, 1200);
  };
  const start = async () => {
    $('#camerr').innerHTML = ''; if (running) return;
    try {
      sc ||= new Html5Qrcode('reader');
      await sc.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * .7); return { width: s, height: s }; } }, handle, () => {});
      running = true;
    } catch (err) {
      const denied = /permission|denied|notallowed/i.test(String(err));
      $('#camerr').innerHTML = `<div class="alert mt">${denied ? 'Camera permission denied. Allow camera access in your browser settings, then tap “Restart camera”.' : 'Could not start the camera: ' + esc(err.message || err)}</div>`;
    }
  };
  cleanups.push(() => { if (sc && running) sc.stop().then(() => sc.clear()).catch(() => {}); });
  $('#restart').onclick = start; $('#manual').onsubmit = ev => { ev.preventDefault(); busy = false; last = ''; handle(ev.target.code.value.trim()); ev.target.reset(); };
  start();
}, 1);

route(/^\/dashboard\/reports$/, async () => {
  dashView('reports', skel); const d = await api('/dashboard');
  dashView('reports', `<h1>Reports</h1>${sumCards(d)}<div class="grid g4 mb">${stat('Not checked in', d.notCheckedIn)}${stat('Check-in rate', d.checkInRate + '%')}</div><div class="grid g2 mb">${chartCard('Registrations over time', 'c1')}${chartCard('Check-ins over time', 'c2')}${chartCard('Checked in vs not checked in', 'c3')}${chartCard('Capacity utilization by event', 'c4')}</div>
  <div class="card"><h3>By event</h3>${d.events.length ? `<div class="tw"><table><thead><tr><th>Event</th><th>Date</th><th>Capacity</th><th>Registered</th><th>Checked in</th><th>Not checked in</th><th>Check-in %</th></tr></thead><tbody>${d.events.map(e => `<tr><td><a href="/dashboard/events/${e.id}">${esc(e.name)}</a></td><td>${fmtDate(e.date)}</td><td>${e.capacity}</td><td>${e.registered}</td><td>${e.checkedIn}</td><td>${e.notCheckedIn}</td><td>${e.checkInRate}%</td></tr>`).join('')}</tbody></table></div>` : empty('📈', 'No data yet')}</div>`);
  chart('c1', lineCfg(d.registrationsByDay, 'Registrations', IND)); chart('c2', lineCfg(d.checkinsByDay, 'Check-ins', GRN)); chart('c3', donutCfg(d.totalCheckIns, d.notCheckedIn));
  const top = d.events.slice(0, 8);
  chart('c4', { type: 'bar', data: { labels: top.map(e => e.name.slice(0, 18)), datasets: [{ label: 'Utilization %', data: top.map(e => e.utilization), backgroundColor: IND }] }, options: { scales: { y: { beginAtZero: true, max: 100 } }, plugins: { legend: { display: false } } } });
}, 1);

route(/^\/dashboard\/profile$/, async () => {
  dashView('profile', `<h1>Profile</h1><form id="f" class="card" style="max-width:520px" novalidate>${fld('Name', 'name', { value: me.name, req: 1 })}${fld('Email', 'email', { type: 'email', value: me.email, req: 1 })}<h3 class="mt">Change password <span class="muted small">(optional)</span></h3>${fld('Current password', 'currentPassword', { type: 'password', attrs: 'autocomplete="current-password"' })}${fld('New password', 'newPassword', { type: 'password', attrs: 'autocomplete="new-password" minlength="8"' })}<button class="btn" type="submit">Save profile</button></form>`);
  $('#f').onsubmit = ev => { ev.preventDefault(); submit(ev.target, async () => { const d = formData(ev.target); if (!d.newPassword) { delete d.newPassword; delete d.currentPassword; } me = (await api('/auth/profile', { method: 'PUT', body: d })).user; toast('Profile saved', 'ok'); render(); }); };
}, 1);

// ---------- boot ----------
api('/auth/me').then(d => { me = d.user; }).catch(() => {}).finally(render);
