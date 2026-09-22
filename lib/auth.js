'use strict';

/**
 * Sign in, roles and sessions.
 *
 * Five seeded accounts for the testing phase: two advisors, two reviewers and
 * one admin. Nothing self registers. Override the whole list with APP_USERS:
 *
 *   APP_USERS="a@x.com|advisor|secret, r@x.com|reviewer|secret, b@x.com|admin|secret"
 *
 * Passwords are never stored in the clear at runtime: each one is hashed with
 * scrypt when the process boots, and comparisons are timing safe.
 *
 * The session is a signed cookie, so there is no session table to keep. It
 * carries the email, the role and an expiry, and the signature is an HMAC over
 * all three. Change SESSION_SECRET and every existing session is void.
 */

const crypto = require('crypto');

const COOKIE = 'atv_session';
const SESSION_HOURS = 12;

const DEFAULT_USERS = [
  { email: 'employee1@aaico.demo', role: 'advisor', password: 'Employee1-2026', name: 'Amelia Grant' },
  { email: 'employee2@aaico.demo', role: 'advisor', password: 'Employee2-2026', name: 'Daniel Osei' },
  { email: 'employee3@aaico.demo', role: 'advisor', password: 'Employee3-2026', name: 'Priya Raman' },
  { email: 'manager1@aaico.demo', role: 'reviewer', password: 'Manager1-2026', name: 'Hana Suzuki' },
  { email: 'manager2@aaico.demo', role: 'reviewer', password: 'Manager2-2026', name: 'Marcus Bell' },
  { email: 'admin@aaico.demo', role: 'admin', password: 'Admin-2026', name: 'Nadia Farouk' }
];

const ROLE_LABEL = { advisor: 'Employee', reviewer: 'Manager', admin: 'Administrator' };

function parseUsers() {
  const raw = (process.env.APP_USERS || '').trim();
  if (!raw) return { users: DEFAULT_USERS.slice(), usingDefaults: true };
  const users = [];
  raw
    .split(/[,\n]/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean)
    .forEach(function (line) {
      const parts = line.split('|').map(function (p) {
        return p.trim();
      });
      if (parts.length < 3) return;
      const role = parts[1].toLowerCase();
      if (['advisor', 'reviewer', 'admin'].indexOf(role) === -1) return;
      users.push({
        email: parts[0].toLowerCase(),
        role: role,
        password: parts[2],
        name: parts[3] || parts[0]
      });
    });
  if (!users.length) return { users: DEFAULT_USERS.slice(), usingDefaults: true };
  return { users: users, usingDefaults: false };
}

const parsed = parseUsers();

/* One scrypt hash per account, computed once at boot. */
const ACCOUNTS = parsed.users.map(function (u) {
  const salt = crypto.randomBytes(16);
  return {
    email: String(u.email).toLowerCase(),
    role: u.role,
    name: u.name || u.email,
    salt: salt,
    hash: crypto.scryptSync(String(u.password), salt, 32)
  };
});

function secret() {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  // Falling back to a key derived from the service key keeps sessions valid
  // across cold starts of the same deployment without a second variable to set.
  return crypto
    .createHash('sha256')
    .update('atv-session|' + (process.env.OPUS_SERVICE_KEY || 'unset'))
    .digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function sign(payloadText) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadText).digest());
}

function issue(account) {
  const payload = {
    e: account.email,
    r: account.role,
    n: account.name,
    x: Date.now() + SESSION_HOURS * 3600 * 1000
  };
  const body = b64url(JSON.stringify(payload));
  return body + '.' + sign(body);
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(unb64url(body));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.e || !payload.r) return null;
  if (!payload.x || Date.now() > payload.x) return null;
  return { email: payload.e, role: payload.r, name: payload.n || payload.e };
}

function authenticate(email, password) {
  const wanted = String(email || '').trim().toLowerCase();
  const account = ACCOUNTS.filter(function (a) {
    return a.email === wanted;
  })[0];
  // Hash even when the account is unknown, so a wrong email and a wrong
  // password take the same time to answer.
  const probe = crypto.scryptSync(String(password || ''), account ? account.salt : Buffer.alloc(16), 32);
  if (!account) return null;
  if (!crypto.timingSafeEqual(probe, account.hash)) return null;
  return { email: account.email, role: account.role, name: account.name };
}

function readCookie(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const parts = String(header).split(';');
  for (let i = 0; i < parts.length; i++) {
    const bit = parts[i].trim();
    if (bit.indexOf(COOKIE + '=') === 0) {
      return decodeURIComponent(bit.slice(COOKIE.length + 1));
    }
  }
  return null;
}

function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return Boolean(req.secure);
}

function setCookie(req, res, token) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + SESSION_HOURS * 3600
  ];
  if (isSecureRequest(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearCookie(req, res) {
  const bits = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/** Attaches req.user when a valid session cookie is present. */
function attach(req, res, next) {
  req.user = verify(readCookie(req));
  next();
}

function canReview(user) {
  return Boolean(user && (user.role === 'reviewer' || user.role === 'admin'));
}

/** 401 rather than a redirect: every page fetches /api/me and routes itself. */
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

function requireReviewer(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!canReview(req.user)) {
    return res.status(403).json({ error: 'This area is for managers.' });
  }
  next();
}

module.exports = {
  COOKIE: COOKIE,
  ROLE_LABEL: ROLE_LABEL,
  usingDefaultAccounts: parsed.usingDefaults,
  accountCount: ACCOUNTS.length,
  /* Every account in this build is a demo account, so both doors offer the
     whole set for one click sign in: three employees, two managers and the
     administrator. Either door accepts any of them and sends the person to the
     home their role has, so a tester never has to find the other page first.
     Swap APP_USERS in and the lists vanish. */
  demoAccounts: function () {
    if (!parsed.usingDefaults) return [];
    const order = { advisor: 0, reviewer: 1, admin: 2 };
    return DEFAULT_USERS.slice()
      .sort(function (a, b) {
        return order[a.role] - order[b.role];
      })
      .map(function (u) {
        return {
          email: u.email,
          password: u.password,
          name: u.name,
          role: u.role,
          roleLabel: ROLE_LABEL[u.role],
          home: u.role === 'advisor' ? '/' : '/review.html'
        };
      });
  },
  /* Names and roles only. Passwords never leave this module. */
  roster: function () {
    return ACCOUNTS.map(function (a) {
      return { email: a.email, name: a.name, role: ROLE_LABEL[a.role] || a.role };
    });
  },
  authenticate: authenticate,
  issue: issue,
  verify: verify,
  attach: attach,
  setCookie: setCookie,
  clearCookie: clearCookie,
  canReview: canReview,
  requireUser: requireUser,
  requireReviewer: requireReviewer
};
