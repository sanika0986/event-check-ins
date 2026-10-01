'use strict';
const crypto = require('crypto');
const { db, uid, now, tx } = require('./db');
const { HttpError: E, Raw, R, hashPw, verifyPw, limit, sessionCookie, clearCookie, PROD } = require('./core');

// ---------- validation helpers ----------
const clean = s => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const str = (v, max = 200) => (typeof v === 'string' ? clean(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max = 5000) => (typeof v === 'string' ? clean(v).trim().slice(0, max) : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PHONE = /^[0-9+()\-\s]{7,20}$/, DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const today = () => new Date().toISOString().slice(0, 10);
const bad = (errors) => { throw new E(400, Object.values(errors)[0], 'INVALID_DATA', { fields: errors }); };

const evBase = `SELECT e.*,
  (SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id AND r.status='registered') AS registered,
  (SELECT COUNT(*) FROM checkins c WHERE c.event_id=e.id) AS checked_in FROM events e`;

function closedReason(e) {
  if (e.status !== 'published') return 'Registration is not available for this event.';
  if (!e.registration_open) return 'Registration is closed for this event.';
  if (e.date < today()) return 'This event has already taken place.';
  if (e.registered >= e.capacity) return 'Registration Closed — Event is Full';
  return null;
}
const evOut = e => ({
  id: e.id, name: e.name, description: e.description, date: e.date, startTime: e.start_time, endTime: e.end_time,
  venue: e.venue, address: e.address, organizerName: e.organizer_name, capacity: e.capacity, imageUrl: e.image_url,
  status: e.status, registrationOpen: !!e.registration_open, customFields: JSON.parse(e.custom_fields || '[]'),
  registered: e.registered, checkedIn: e.checked_in, availableSeats: Math.max(0, e.capacity - e.registered),
  closedReason: closedReason(e), createdAt: e.created_at,
});
const getEvent = id => db.prepare(evBase + ' WHERE e.id=?').get(id);
function ownEvent(c, id) {
  const u = c.requireUser();
  const e = getEvent(id);
  if (!e || e.organizer_id !== u.id) throw new E(404, 'Event not found', 'NOT_FOUND'); // same response: don't leak existence
  return e;
}

function eventInput(b) {
  const err = {};
  const o = {
    name: str(b.name, 120), description: text(b.description), date: str(b.date, 10), start_time: str(b.startTime, 5),
    end_time: str(b.endTime, 5), venue: str(b.venue, 150), address: str(b.address, 250),
    organizer_name: str(b.organizerName, 100), capacity: Number.parseInt(b.capacity, 10),
    image_url: typeof b.imageUrl === 'string' ? b.imageUrl.trim() : '', registration_open: b.registrationOpen === false ? 0 : 1,
    status: b.status === 'published' ? 'published' : 'draft',
    custom_fields: JSON.stringify((Array.isArray(b.customFields) ? b.customFields : []).map(x => str(x, 50)).filter(Boolean).slice(0, 5)),
  };
  if (o.name.length < 3) err.name = 'Event name must be at least 3 characters.';
  if (!DATE.test(o.date)) err.date = 'Please enter a valid event date.';
  if (!TIME.test(o.start_time)) err.startTime = 'Please enter a valid start time.';
  if (!TIME.test(o.end_time)) err.endTime = 'Please enter a valid end time.';
  else if (TIME.test(o.start_time) && o.end_time <= o.start_time) err.endTime = 'End time must be after start time.';
  if (!o.venue) err.venue = 'Venue is required.';
  if (!(o.capacity >= 1 && o.capacity <= 100000)) err.capacity = 'Capacity must be between 1 and 100,000.';
  if (o.image_url && !/^(https?:\/\/[^\s]+|data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+)$/.test(o.image_url) || o.image_url.length > 1.5e6)
    err.imageUrl = 'Banner must be an http(s) URL or an uploaded image.';
  if (Object.keys(err).length) bad(err);
  return o;
}

// ---------- auth ----------
R('POST', '/api/auth/register', c => {
  limit(c, 'auth', 10, 60000);
  const name = str(c.body.name, 100), email = str(c.body.email, 254).toLowerCase(), pw = typeof c.body.password === 'string' ? c.body.password : '';
  const err = {};
  if (name.length < 2) err.name = 'Please enter your name.';
  if (!EMAIL.test(email)) err.email = 'Please enter a valid email address.';
  if (pw.length < 8 || pw.length > 200) err.password = 'Password must be at least 8 characters.';
  if (Object.keys(err).length) bad(err);
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new E(409, 'An account with this email already exists.', 'DUPLICATE');
  const id = uid(), t = now();
  db.prepare('INSERT INTO users (id,name,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, name, email, hashPw(pw), t, t);
  c.headers['Set-Cookie'] = sessionCookie(id); c.status = 201;
  return { user: { id, name, email, role: 'organizer' } };
});

R('POST', '/api/auth/login', c => {
  limit(c, 'auth', 10, 60000);
  const email = str(c.body.email, 254).toLowerCase(), pw = typeof c.body.password === 'string' ? c.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !verifyPw(pw, u.password_hash)) throw new E(401, 'Incorrect email or password.', 'BAD_CREDENTIALS');
  c.headers['Set-Cookie'] = sessionCookie(u.id);
  return { user: { id: u.id, name: u.name, email: u.email, role: u.role } };
});

R('POST', '/api/auth/logout', c => { c.headers['Set-Cookie'] = clearCookie(); return { ok: true }; });
R('GET', '/api/auth/me', c => ({ user: c.user }));

R('PUT', '/api/auth/profile', c => {
  const u = c.requireUser();
  const name = str(c.body.name, 100), email = str(c.body.email, 254).toLowerCase(), err = {};
  if (name.length < 2) err.name = 'Please enter your name.';
  if (!EMAIL.test(email)) err.email = 'Please enter a valid email address.';
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  if (c.body.newPassword) {
    if (!c.body.currentPassword || !verifyPw(String(c.body.currentPassword), row.password_hash)) err.currentPassword = 'Current password is incorrect.';
    if (String(c.body.newPassword).length < 8) err.newPassword = 'New password must be at least 8 characters.';
  }
  if (Object.keys(err).length) bad(err);
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email, u.id)) throw new E(409, 'That email is already in use.', 'DUPLICATE');
  db.prepare('UPDATE users SET name=?,email=?,password_hash=?,updated_at=? WHERE id=?')
    .run(name, email, c.body.newPassword ? hashPw(String(c.body.newPassword)) : row.password_hash, now(), u.id);
  return { user: { id: u.id, name, email, role: u.role } };
});

R('POST', '/api/auth/forgot', c => {
  limit(c, 'forgot', 5, 60000);
  const email = str(c.body.email, 254).toLowerCase();
  const u = EMAIL.test(email) && db.prepare('SELECT id FROM users WHERE email=?').get(email);
  const out = { ok: true, message: 'If that email exists, a reset link has been sent.' };
  if (u) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id);
    db.prepare('INSERT INTO password_resets VALUES (?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), u.id, Date.now() + 3600e3);
    const link = `${process.env.APP_URL || 'http://localhost:3000'}/forgot-password?token=${token}`;
    console.log(`[password reset] ${email}: ${link}`); // plug an email provider in here (see README)
    if (!PROD) out.devLink = link;
  }
  return out;
});

R('POST', '/api/auth/reset', c => {
  limit(c, 'forgot', 10, 60000);
  const pw = typeof c.body.password === 'string' ? c.body.password : '';
  if (pw.length < 8) bad({ password: 'Password must be at least 8 characters.' });
  const h = crypto.createHash('sha256').update(String(c.body.token || '')).digest('hex');
  const r = db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(h);
  if (!r || r.expires_at < Date.now()) throw new E(400, 'This reset link is invalid or has expired.', 'BAD_TOKEN');
  db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hashPw(pw), now(), r.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id=?').run(r.user_id);
  return { ok: true };
});

// ---------- events ----------
R('GET', '/api/events', c => {
  const q = `%${str(c.query.q || '', 80)}%`;
  if (c.query.mine) {
    const u = c.requireUser();
    const st = ['draft', 'published'].includes(c.query.status) ? c.query.status : null;
    const rows = db.prepare(evBase + ` WHERE e.organizer_id=? AND (e.name LIKE ? OR e.venue LIKE ?) ${st ? 'AND e.status=?' : ''} ORDER BY e.date DESC, e.start_time DESC`)
      .all(...[u.id, q, q, ...(st ? [st] : [])]);
    return { events: rows.map(evOut) };
  }
  const rows = db.prepare(evBase + ` WHERE e.status='published' AND e.date>=? AND (e.name LIKE ? OR e.venue LIKE ?) ORDER BY e.date, e.start_time LIMIT 100`).all(today(), q, q);
  return { events: rows.map(evOut) };
});

R('POST', '/api/events', c => {
  const u = c.requireUser(), o = eventInput(c.body), id = uid(), t = now();
  if (!o.organizer_name) o.organizer_name = u.name;
  db.prepare(`INSERT INTO events (id,organizer_id,name,description,date,start_time,end_time,venue,address,organizer_name,capacity,image_url,status,registration_open,custom_fields,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, u.id, o.name, o.description, o.date, o.start_time, o.end_time, o.venue, o.address, o.organizer_name, o.capacity, o.image_url, o.status, o.registration_open, o.custom_fields, t, t);
  c.status = 201; return { event: evOut(getEvent(id)) };
});

R('GET', '/api/events/:id', c => {
  const e = getEvent(c.params.id);
  const mine = e && c.user && e.organizer_id === c.user.id;
  if (!e || (e.status !== 'published' && !mine)) throw new E(404, 'Event not found', 'NOT_FOUND');
  return { event: evOut(e), isOwner: !!mine };
});

R('PUT', '/api/events/:id', c => {
  const e = ownEvent(c, c.params.id), o = eventInput(c.body);
  if (o.capacity < e.registered) bad({ capacity: `Capacity cannot be lower than current registrations (${e.registered}).` });
  db.prepare(`UPDATE events SET name=?,description=?,date=?,start_time=?,end_time=?,venue=?,address=?,organizer_name=?,capacity=?,image_url=?,status=?,registration_open=?,custom_fields=?,updated_at=? WHERE id=?`)
    .run(o.name, o.description, o.date, o.start_time, o.end_time, o.venue, o.address, o.organizer_name || c.user.name, o.capacity, o.image_url, o.status, o.registration_open, o.custom_fields, now(), e.id);
  return { event: evOut(getEvent(e.id)) };
});

R('PUT', '/api/events/:id/status', c => { // publish / unpublish
  const e = ownEvent(c, c.params.id);
  const status = c.body.status === 'published' ? 'published' : 'draft';
  db.prepare('UPDATE events SET status=?,updated_at=? WHERE id=?').run(status, now(), e.id);
  return { event: evOut(getEvent(e.id)) };
});

R('DELETE', '/api/events/:id', c => { const e = ownEvent(c, c.params.id); db.prepare('DELETE FROM events WHERE id=?').run(e.id); return { ok: true }; });

// ---------- public registration ----------
R('POST', '/api/events/:id/register', c => {
  limit(c, 'register', 10, 60000);
  const b = c.body, o = {
    name: str(b.name ?? b.attendeeName, 100), email: str(b.email, 254).toLowerCase(), phone: str(b.phone, 20), organization: str(b.organization, 150),
  };
  const err = {};
  if (o.name.length < 2) err.name = 'Please enter your full name.';
  if (!EMAIL.test(o.email)) err.email = 'Please enter a valid email address.';
  if (!PHONE.test(o.phone)) err.phone = 'Please enter a valid phone number.';
  if (!o.organization) err.organization = 'Organization / college is required.';
  if (Object.keys(err).length) bad(err);

  return tx(() => {
    const e = getEvent(c.params.id);
    if (!e || e.status !== 'published') throw new E(404, 'Event not found', 'NOT_FOUND');
    const reason = closedReason(e);
    if (reason) throw new E(409, reason, e.registered >= e.capacity ? 'EVENT_FULL' : 'REG_CLOSED');
    const fields = JSON.parse(e.custom_fields), answers = {};
    for (const f of fields) answers[f] = str((b.customAnswers || {})[f], 300);
    if (db.prepare('SELECT 1 FROM registrations WHERE event_id=? AND email=?').get(e.id, o.email))
      throw new E(409, 'This email is already registered for this event.', 'DUPLICATE');
    const id = uid(), token = crypto.randomBytes(32).toString('base64url'), attendeeId = 'ATT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO registrations (id,event_id,attendee_id,attendee_name,email,phone,organization,custom_answers,qr_token,registered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, e.id, attendeeId, o.name, o.email, o.phone, o.organization, JSON.stringify(answers), token, now());
    c.status = 201;
    return { registrationId: id, attendeeId };
  });
});

const regOut = (r, withQr) => ({
  id: r.id, attendeeId: r.attendee_id, name: r.attendee_name, email: r.email, phone: r.phone, organization: r.organization,
  customAnswers: JSON.parse(r.custom_answers || '{}'), registeredAt: r.registered_at, status: r.status,
  checkedIn: !!r.checkin_id, checkedInAt: r.checked_in_at || null, eventId: r.event_id, eventName: r.event_name,
  ...(withQr ? { qrPayload: { eventId: r.event_id, registrationId: r.id, token: r.qr_token } } : {}),
});

// registration confirmation (capability URL: unguessable UUID)
R('GET', '/api/registrations/:id', c => {
  const r = db.prepare(`SELECT r.*, e.name AS event_name, k.id AS checkin_id, k.checked_in_at FROM registrations r JOIN events e ON e.id=r.event_id LEFT JOIN checkins k ON k.registration_id=r.id WHERE r.id=?`).get(c.params.id);
  if (!r) throw new E(404, 'Registration not found', 'NOT_FOUND');
  return { registration: regOut(r, true), event: evOut(getEvent(r.event_id)) };
});

// ---------- attendee list (per event or across all of an organizer's events) ----------
const SORTS = { name: 'r.attendee_name', email: 'r.email', registered: 'r.registered_at', checkin: 'k.checked_in_at', event: 'e.name' };
function listRegs(c, eventId) {
  const u = c.requireUser();
  if (eventId) ownEvent(c, eventId);
  const w = ['e.organizer_id=?'], p = [u.id];
  if (eventId) { w.push('r.event_id=?'); p.push(eventId); }
  const q = str(c.query.q || '', 80);
  if (q) { w.push('(r.attendee_name LIKE ? OR r.email LIKE ? OR r.phone LIKE ? OR r.attendee_id LIKE ?)'); p.push(...Array(4).fill(`%${q}%`)); }
  if (c.query.status === 'checked') w.push('k.id IS NOT NULL'); else if (c.query.status === 'pending') w.push('k.id IS NULL');
  const from = `FROM registrations r JOIN events e ON e.id=r.event_id LEFT JOIN checkins k ON k.registration_id=r.id WHERE ${w.join(' AND ')}`;
  const order = `ORDER BY ${SORTS[c.query.sort] || SORTS.registered} ${c.query.dir === 'asc' ? 'ASC' : 'DESC'}`;
  const sel = 'SELECT r.*, e.name AS event_name, k.id AS checkin_id, k.checked_in_at ' + from + ' ' + order;
  if (c.query.format === 'csv') {
    const rows = db.prepare(sel).all(...p);
    const cell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; // CSV-injection safe
    const lines = [['Attendee ID', 'Name', 'Email', 'Phone', 'Organization', 'Event', 'Registered At', 'Checked In', 'Check-in Time'].map(cell).join(',')]
      .concat(rows.map(r => [r.attendee_id, r.attendee_name, r.email, r.phone, r.organization, r.event_name, r.registered_at, r.checkin_id ? 'Yes' : 'No', r.checked_in_at || ''].map(cell).join(',')));
    return new Raw('text/csv; charset=utf-8', '\ufeff' + lines.join('\r\n'), { 'Content-Disposition': 'attachment; filename="attendees.csv"' });
  }
  const size = Math.min(100, Math.max(5, parseInt(c.query.pageSize, 10) || 10)), page = Math.max(1, parseInt(c.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) n ' + from).get(...p).n;
  const rows = db.prepare(sel + ' LIMIT ? OFFSET ?').all(...p, size, (page - 1) * size);
  return { registrations: rows.map(r => regOut(r)), total, page, pageSize: size, pages: Math.max(1, Math.ceil(total / size)) };
}
R('GET', '/api/registrations', c => listRegs(c, c.query.eventId));
R('GET', '/api/events/:id/registrations', c => listRegs(c, c.params.id));

// ---------- check-in ----------
R('POST', '/api/events/:id/checkin', c => {
  const u = c.requireUser();
  limit(c, 'checkin', 120, 60000);
  const e = ownEvent(c, c.params.id);
  let code = c.body.code, payload = null;
  if (typeof code !== 'string' || code.length > 500) throw new E(400, 'Invalid QR Code', 'INVALID');
  try { payload = JSON.parse(code); } catch { payload = { token: code.trim() }; }
  const token = payload && typeof payload.token === 'string' ? payload.token : '';
  const r = token.length >= 20 && token.length <= 100
    ? db.prepare('SELECT * FROM registrations WHERE qr_token=?').get(token) : null;
  if (!r || r.status !== 'registered' || (payload.registrationId && payload.registrationId !== r.id))
    throw new E(404, 'Invalid QR Code', 'INVALID');
  if (r.event_id !== e.id) throw new E(409, 'This QR code belongs to another event.', 'WRONG_EVENT');
  const info = k => ({ attendee: { name: r.attendee_name, email: r.email, attendeeId: r.attendee_id }, registrationId: r.id, eventName: e.name, checkedInAt: k });
  const prior = db.prepare('SELECT checked_in_at FROM checkins WHERE registration_id=?').get(r.id);
  if (prior) throw new E(409, 'Already Checked In', 'ALREADY', info(prior.checked_in_at));
  const at = now();
  try {
    db.prepare('INSERT INTO checkins (id,event_id,registration_id,attendee_id,checked_in_at,checked_in_by) VALUES (?,?,?,?,?,?)').run(uid(), e.id, r.id, r.attendee_id, at, u.id);
  } catch (x) { // UNIQUE(registration_id) guards concurrent double scans
    const k = db.prepare('SELECT checked_in_at FROM checkins WHERE registration_id=?').get(r.id);
    if (k) throw new E(409, 'Already Checked In', 'ALREADY', info(k.checked_in_at));
    throw x;
  }
  c.status = 201;
  return { ok: true, code: 'OK', message: 'Check-in Successful', ...info(at) };
});

R('GET', '/api/events/:id/checkins', c => {
  const e = ownEvent(c, c.params.id);
  const rows = db.prepare(`SELECT k.*, r.attendee_name, r.email, u.name AS scanner FROM checkins k JOIN registrations r ON r.id=k.registration_id JOIN users u ON u.id=k.checked_in_by WHERE k.event_id=? ORDER BY k.checked_in_at DESC LIMIT 1000`).all(e.id);
  return { checkins: rows.map(k => ({ id: k.id, registrationId: k.registration_id, attendeeId: k.attendee_id, name: k.attendee_name, email: k.email, checkedInAt: k.checked_in_at, scanner: k.scanner, status: k.status })) };
});

// ---------- statistics ----------
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
R('GET', '/api/events/:id/statistics', c => {
  const e = ownEvent(c, c.params.id);
  return {
    event: evOut(e), capacity: e.capacity, registered: e.registered, checkedIn: e.checked_in, notCheckedIn: e.registered - e.checked_in,
    checkInRate: rate(e.checked_in, e.registered), utilization: rate(e.registered, e.capacity),
    registrationsByDay: db.prepare(`SELECT substr(registered_at,1,10) AS label, COUNT(*) AS count FROM registrations WHERE event_id=? GROUP BY label ORDER BY label`).all(e.id),
    checkinsByHour: db.prepare(`SELECT substr(checked_in_at,1,13) AS label, COUNT(*) AS count FROM checkins WHERE event_id=? GROUP BY label ORDER BY label`).all(e.id),
  };
});

R('GET', '/api/dashboard', c => {
  const u = c.requireUser();
  const events = db.prepare(evBase + ' WHERE e.organizer_id=? ORDER BY e.date DESC').all(u.id);
  const regs = events.reduce((a, e) => a + e.registered, 0), chk = events.reduce((a, e) => a + e.checked_in, 0);
  return {
    totalEvents: events.length, upcomingEvents: events.filter(e => e.date >= today()).length,
    totalRegistrations: regs, totalCheckIns: chk, notCheckedIn: regs - chk, checkInRate: rate(chk, regs),
    registrationsByDay: db.prepare(`SELECT substr(r.registered_at,1,10) AS label, COUNT(*) AS count FROM registrations r JOIN events e ON e.id=r.event_id WHERE e.organizer_id=? GROUP BY label ORDER BY label DESC LIMIT 30`).all(u.id).reverse(),
    checkinsByDay: db.prepare(`SELECT substr(k.checked_in_at,1,10) AS label, COUNT(*) AS count FROM checkins k JOIN events e ON e.id=k.event_id WHERE e.organizer_id=? GROUP BY label ORDER BY label DESC LIMIT 30`).all(u.id).reverse(),
    events: events.map(e => ({ id: e.id, name: e.name, date: e.date, status: e.status, capacity: e.capacity, registered: e.registered, checkedIn: e.checked_in, notCheckedIn: e.registered - e.checked_in, checkInRate: rate(e.checked_in, e.registered), utilization: rate(e.registered, e.capacity) })),
  };
});
