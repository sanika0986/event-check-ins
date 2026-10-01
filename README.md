# EventCheck — QR Code Event Registration & Check-in

Create events, register attendees, issue a unique QR code per attendee, and scan them at the door with the phone camera.
Zero npm dependencies: Node.js 22.5+ (built-in `node:sqlite`, `crypto`, `http`). Frontend is vanilla JS; QR generation (qrcode-generator), charts (Chart.js) and scanning (html5-qrcode) are lazy-loaded from a CDN.


## Screenshots


> Captured from the running app with demo data. Camera preview is black because the capture environment has no camera; the scan results shown are real server responses.

### Public pages
| Landing | Events list |
|---|---|
| ![Home](docs/screenshots/01-home.png) | ![Events](docs/screenshots/02-events.png) |

| Event page | Registration form |
|---|---|
| ![Event page](docs/screenshots/03-event-page.png) | ![Registration](docs/screenshots/04-registration-form.png) |

| Login | Mobile event page |
|---|---|
| ![Login](docs/screenshots/05-login.png) | ![Mobile](docs/screenshots/13-mobile-event-page.png) |

### Organizer dashboard
![Dashboard overview](docs/screenshots/06-dashboard-overview.png)
![Events management](docs/screenshots/07-events-management.png)
![Create event](docs/screenshots/08-create-event.png)
![Attendees](docs/screenshots/09-attendees.png)

### QR scanner & check-ins
![Check-in successful](docs/screenshots/10-scanner-success.png)
![Already checked in](docs/screenshots/11-scanner-already-checked-in.png)
![Check-in records](docs/screenshots/12-checkins.png)

## Quick start
```bash
cp .env.example .env        # then set SESSION_SECRET to a long random string
npm start                   # http://localhost:3000
npm test                    # end-to-end API test (signup → event → register → scan → duplicate scan → stats)
```
Requires Node >= 22.5. The database file and tables are created automatically on first start (`./data/eventcheck.db`).

## Environment variables
| Name | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `SESSION_SECRET` | Signs session cookies. **Required in production** |
| `DATABASE_FILE` | SQLite path (default `./data/eventcheck.db`) |
| `APP_URL` | Public base URL used in password-reset links |
| `NODE_ENV` | `production` enables Secure cookies and hides dev reset links |
| `TRUST_PROXY` | `true` behind a reverse proxy so rate limits use the real client IP |

## Database
SQLite, schema in `server/db.js` (applied automatically): `users`, `password_resets`, `events`, `registrations`, `checkins`.
Key constraints: `UNIQUE(event_id, email)` blocks duplicate registration; `UNIQUE(qr_token)`; `UNIQUE(registration_id)` on `checkins` guarantees one check-in per attendee even under concurrent scans; foreign keys cascade deletes; indexes on organizer/date, event/registered_at, event/checked_in_at.

## How the QR check-in flow works
1. Attendee registers on `/events/:id/register`. The server (in one transaction) checks capacity, event status and duplicates, then stores the registration with a random 256-bit `qr_token`.
2. The QR encodes only `{"eventId","registrationId","token"}` — no personal data. It is shown on `/registration/success/:registrationId` (download PNG / print).
3. The organizer opens `/dashboard/events/:id/scanner`; the browser asks for camera permission and scans continuously (4-second same-code cooldown).
4. The raw QR text is POSTed to `POST /api/events/:id/checkin`. The **server** verifies: logged-in organizer owns the event → token exists → registration belongs to this event → not already checked in. It then inserts the check-in with the server timestamp.
5. Responses: **Check-in Successful**, **Already Checked In** (with original time), **Invalid QR Code**, or *belongs to another event*. Nothing is trusted from the client.

## API
`POST /api/auth/{register,login,logout,forgot,reset}`, `GET /api/auth/me`, `PUT /api/auth/profile` ·
`GET/POST /api/events`, `GET/PUT/DELETE /api/events/:id`, `PUT /api/events/:id/status` ·
`POST /api/events/:id/register` · `GET /api/events/:id/registrations[?q&status&sort&dir&page&format=csv]` ·
`POST /api/events/:id/checkin` · `GET /api/events/:id/checkins` · `GET /api/events/:id/statistics` · `GET /api/dashboard` · `GET /api/registrations/:registrationId`

## Security notes
scrypt password hashing · HMAC-signed HttpOnly SameSite=Lax session cookie · server-side validation & control-character stripping, all output HTML-escaped on the client · ownership checks on every organizer route (404 for other people's events) · CSV export is formula-injection safe · in-memory rate limits on auth, registration, forgot-password and check-in (swap for Redis if you run several instances) · security headers set.

## Deploy
Any host that runs Node 22.5+ with a **persistent disk** (Render, Railway, Fly.io, a VPS):
1. Set `NODE_ENV=production`, `SESSION_SECRET`, `APP_URL`, `TRUST_PROXY=true`, and point `DATABASE_FILE` at the mounted volume.
2. Start command: `npm start`. Serve over **HTTPS** — mobile browsers only allow camera access on HTTPS (or localhost).

## Optional email
Password-reset links are printed to the server log (and returned in dev mode). To email reset links or QR confirmations, call your provider (Resend, SendGrid, SMTP) at the `console.log('[password reset]…')` line in `server/routes.js` and after the insert in the register route.

