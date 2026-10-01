// End-to-end API test: starts the server on a temp DB and runs the full flow.
const { spawn } = require('child_process'), path = require('path'), os = require('os'), fs = require('fs');
const assert = require('assert');
const port = 3900 + Math.floor(Math.random() * 90), base = `http://localhost:${port}`;
const dbf = path.join(os.tmpdir(), `ec-${Date.now()}.db`);
const srv = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, DATABASE_FILE: dbf }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() {
  let cookie = '';
  return async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
}
const ok = (n) => console.log('  ✓', n);
(async () => {
  for (let i = 0; i < 30; i++) { try { await fetch(base + '/api/auth/me'); break; } catch { await sleep(200); } }
  const org = client(), other = client(), guest = client();
  let r = await org('POST', '/api/auth/register', { name: 'Olivia Organizer', email: 'olivia@example.com', password: 'password123' });
  assert.equal(r.status, 201); ok('organizer signs up');
  r = await org('POST', '/api/auth/register', { name: 'X', email: 'olivia@example.com', password: 'password123' }); assert.equal(r.status, 400);
  r = await org('GET', '/api/dashboard'); assert.equal(r.status, 200);
  r = await guest('GET', '/api/dashboard'); assert.equal(r.status, 401); ok('dashboard is protected');
  const ev = { name: 'DevFest 2026', description: 'A great event', date: '2099-01-01', startTime: '10:00', endTime: '16:00', venue: 'Main Hall', address: '1 Road', capacity: 2, status: 'published', customFields: ['T-shirt size'] };
  r = await org('POST', '/api/events', ev); assert.equal(r.status, 201); const eid = r.data.event.id; ok('event created');
  r = await org('POST', '/api/events', { ...ev, endTime: '09:00' }); assert.equal(r.status, 400);
  r = await org('POST', '/api/events', { ...ev, name: 'Other Event' }); const eid2 = r.data.event.id;
  r = await guest('GET', '/api/events'); assert.equal(r.data.events.length, 2); ok('public listing');
  const reg = { name: 'Alice Attendee', email: 'alice@example.com', phone: '+91 98765 43210', organization: 'MIT', customAnswers: { 'T-shirt size': 'M' } };
  r = await guest('POST', `/api/events/${eid}/register`, reg); assert.equal(r.status, 201); const rid = r.data.registrationId; ok('attendee registers');
  r = await guest('POST', `/api/events/${eid}/register`, reg); assert.equal(r.status, 409); assert.equal(r.data.code, 'DUPLICATE'); ok('duplicate blocked');
  r = await guest('POST', `/api/events/${eid}/register`, { ...reg, email: 'bad' }); assert.equal(r.status, 400);
  r = await guest('GET', `/api/registrations/${rid}`); const qr = r.data.registration.qrPayload;
  assert.ok(qr.token.length >= 40 && qr.eventId === eid && qr.registrationId === rid); assert.ok(!JSON.stringify(qr).includes('alice')); ok('unique secure QR token (no PII)');
  r = await guest('POST', `/api/events/${eid2}/register`, { ...reg, email: 'bob@example.com' }); const qr2 = (await guest('GET', `/api/registrations/${r.data.registrationId}`)).data.registration.qrPayload;
  r = await guest('POST', `/api/events/${eid}/checkin`, { code: JSON.stringify(qr) }); assert.equal(r.status, 401); ok('guests cannot check in');
  r = await other('POST', '/api/auth/register', { name: 'Mallory', email: 'm@example.com', password: 'password123' });
  r = await other('POST', `/api/events/${eid}/checkin`, { code: JSON.stringify(qr) }); assert.equal(r.status, 404); ok("other organizer can't touch my event");
  r = await org('POST', `/api/events/${eid}/checkin`, { code: 'garbage' }); assert.equal(r.data.code, 'INVALID'); ok('Invalid QR Code');
  r = await org('POST', `/api/events/${eid}/checkin`, { code: JSON.stringify(qr2) }); assert.equal(r.data.code, 'WRONG_EVENT'); ok('QR from another event rejected');
  r = await org('POST', `/api/events/${eid}/checkin`, { code: JSON.stringify(qr) }); assert.equal(r.status, 201); assert.equal(r.data.message, 'Check-in Successful'); const t1 = r.data.checkedInAt; ok('Check-in Successful');
  r = await org('POST', `/api/events/${eid}/checkin`, { code: JSON.stringify(qr) }); assert.equal(r.status, 409); assert.equal(r.data.code, 'ALREADY'); assert.equal(r.data.checkedInAt, t1); ok('second scan → Already Checked In');
  const par = await Promise.all([1, 2, 3].map(() => org('POST', `/api/events/${eid2}/checkin`, { code: JSON.stringify(qr2) }))); assert.equal(par.filter(x => x.status === 201).length, 1); ok('concurrent scans produce one check-in');
  r = await org('GET', `/api/events/${eid}/statistics`); assert.equal(r.data.registered, 1); assert.equal(r.data.checkedIn, 1); assert.equal(r.data.checkInRate, 100);
  r = await org('GET', '/api/dashboard'); assert.equal(r.data.totalRegistrations, 2); assert.equal(r.data.totalCheckIns, 2); ok('statistics update');
  await guest('POST', `/api/events/${eid}/register`, { ...reg, email: 'carol@example.com' });
  r = await guest('POST', `/api/events/${eid}/register`, { ...reg, email: 'dan@example.com' }); assert.equal(r.status, 409); assert.equal(r.data.code, 'EVENT_FULL'); assert.ok(r.data.error.includes('Event is Full')); ok('capacity enforced');
  r = await org('GET', `/api/events/${eid}/registrations?q=alice&status=checked`); assert.equal(r.data.total, 1);
  r = await org('GET', `/api/events/${eid}/registrations?format=csv`); assert.ok(r.data.includes('alice@example.com')); ok('search/filter/CSV export');
  r = await org('GET', `/api/events/${eid}/checkins`); assert.equal(r.data.checkins.length, 1);
  r = await org('PUT', `/api/events/${eid}/status`, { status: 'draft' }); r = await guest('GET', `/api/events/${eid}`); assert.equal(r.status, 404); ok('unpublish hides event');
  r = await guest('POST', '/api/auth/forgot', { email: 'olivia@example.com' }); const tok = new URL(r.data.devLink).searchParams.get('token');
  r = await guest('POST', '/api/auth/reset', { token: tok, password: 'newpassword1' }); assert.equal(r.status, 200);
  r = await guest('POST', '/api/auth/login', { email: 'olivia@example.com', password: 'newpassword1' }); assert.equal(r.status, 200); ok('password reset + login');
  r = await org('DELETE', `/api/events/${eid}`); assert.equal(r.status, 200); ok('event deleted');
  console.log('\nALL TESTS PASSED');
})().catch(e => { console.error('\nFAILED:', e); process.exitCode = 1; }).finally(() => { srv.kill(); for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(dbf + s); } catch {} });
