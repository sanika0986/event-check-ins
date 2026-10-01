'use strict';
const crypto = require('crypto');
const { db } = require('./db');

const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.SESSION_SECRET) { console.error('SESSION_SECRET is required in production'); process.exit(1); }

class HttpError extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
class Raw { constructor(type, body, headers = {}) { this.type = type; this.body = body; this.headers = headers; } }

// ---- sessions (HMAC-signed, HttpOnly cookie) ----
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeSession = uid => { const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };
function readSession(c) {
  if (!c) return null;
  const [p, s] = c.split('.'); if (!p || !s) return null;
  const e = sign(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url')); return d.exp > Date.now() ? d : null; } catch { return null; }
}
const cookieAttrs = 'Path=/; HttpOnly; SameSite=Lax' + (PROD || process.env.COOKIE_SECURE === 'true' ? '; Secure' : '');
const sessionCookie = uid => `sid=${makeSession(uid)}; ${cookieAttrs}; Max-Age=${7 * 86400}`;
const clearCookie = () => `sid=; ${cookieAttrs}; Max-Age=0`;

// ---- passwords (scrypt) ----
const hashPw = pw => { const salt = crypto.randomBytes(16); return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
function verifyPw(pw, h) {
  const [, salt, hash] = h.split('$');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// ---- rate limiting (in-memory sliding window; use Redis if you scale horizontally) ----
const hits = new Map();
function limit(c, key, max, windowMs) {
  const k = key + ':' + (c.user?.id || c.ip), t = Date.now();
  const a = (hits.get(k) || []).filter(x => t - x < windowMs);
  if (a.length >= max) throw new HttpError(429, 'Too many requests. Please slow down and try again.', 'RATE_LIMIT');
  a.push(t); hits.set(k, a);
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// ---- tiny router ----
const routes = [];
const R = (method, p, handler) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler });

const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', d => { n += d.length; if (n > 2e6) { reject(new HttpError(413, 'Request too large', 'TOO_LARGE')); req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    if (!chunks.length) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new HttpError(400, 'Invalid JSON body', 'BAD_JSON')); }
  });
  req.on('error', reject);
});

async function dispatch(req, res, url) {
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };
  try {
    const hit = routes.map(r => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find(x => x.m);
    if (!hit) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const ct = req.headers['content-type'] || '';
    if (req.method !== 'GET' && Number(req.headers['content-length'] || 0) > 0 && !ct.includes('application/json'))
      throw new HttpError(415, 'JSON required', 'BAD_TYPE');
    const cookies = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
    const sess = readSession(cookies.sid);
    const ip = (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
    const c = {
      req, ip, params: hit.m.groups || {}, query: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' ? {} : await readBody(req),
      user: sess ? db.prepare('SELECT id,name,email,role,created_at FROM users WHERE id=?').get(sess.uid) : null,
      headers: {},
    };
    c.requireUser = () => { if (!c.user) throw new HttpError(401, 'Please log in to continue.', 'UNAUTHENTICATED'); return c.user; };
    const out = await hit.r.handler(c);
    if (out instanceof Raw) { res.writeHead(200, { 'Content-Type': out.type, ...out.headers }); return res.end(out.body); }
    send(c.status || 200, out ?? { ok: true }, c.headers);
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, code: e.code, ...(e.extra || {}) });
    console.error(e); send(500, { error: 'Something went wrong on the server.', code: 'SERVER' });
  }
}
module.exports = { HttpError, Raw, R, dispatch, hashPw, verifyPw, limit, sessionCookie, clearCookie, PROD };
