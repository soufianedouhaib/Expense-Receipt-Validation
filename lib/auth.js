/**
 * Demo sign-in.
 *
 * A fixed set of demo accounts with scrypt-hashed passwords, so the portal can
 * be handed to someone and used immediately with nothing to configure. There is
 * no account creation, no password reset and no directory behind it.
 *
 * This is a demo mechanism, not a security boundary:
 *   - the accounts and their hashes live in this file, in the repository
 *   - anyone with the address and a password can sign in
 *   - SESSION_SECRET falls back to a built-in value when unset, which means
 *     cookies on a default deployment are forgeable by anyone who reads this
 *
 * Set SESSION_SECRET, and replace these accounts with a real identity provider,
 * before anything that matters goes through it.
 *
 * Optional environment:
 *   SESSION_SECRET   any long random string; strongly recommended
 *   ADMIN_EMAILS     comma-separated, adds admin to accounts beyond the demo one
 */

const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET ||
  'demo-session-secret-change-me-in-production';

const SESSION_COOKIE = 'aaico_session';
const SESSION_HOURS = 12;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------------------------- demo accounts ---------------------------- */

const USERS = [
  {
    email: 'mahmoud@demo.aaico.com',
    name: 'Mahmoud Sharshira',
    roles: ['employee'],
    managerName: 'Omar Busaileh',
    salt: 'be37cf05c0ccbaaf2c1f6d83a79d7d51',
    hash: '5a899e2378878d8dd5975255f1069a66729928d664242482cc033dd81f9e116c821dbec2b47ce155d9390c00294484953fc58fef0dbef122c9608b2967d8f5a9',
  },
  {
    email: 'layla@demo.aaico.com',
    name: 'Layla Haddad',
    roles: ['employee'],
    managerName: 'Omar Busaileh',
    salt: '4cf9ef214ceb86dd140a95be6837c3c1',
    hash: 'a6f3705d3ec5fa2661570632a3222b5d754dad71841156db99b6186cda3f7c53bb647ad901aacd732733b90e8fb2c962597a5148a43abf123838e6d6888ae3a9',
  },
  {
    email: 'karim@demo.aaico.com',
    name: 'Karim Nasser',
    roles: ['employee'],
    managerName: 'Sara Khalil',
    salt: '648795a144e1c8d8f4a01edd90a0df50',
    hash: '7cf084b094cb64948a724fa8e0a64a7b7c5e3bd27f8a277908fd4b076817f226fcf1511440af787ebf9a8c0a503737919f2bc5df1d25c7fd3410c705bd29063b',
  },
  {
    email: 'noor@demo.aaico.com',
    name: 'Noor Abdallah',
    roles: ['employee'],
    managerName: 'Sara Khalil',
    salt: '8bb2937b0eff30bf9c00e15b5cbedaea',
    hash: '8dad5276ee89f7df6679e0d191a550bfe023a4d84e2af03ba47ac0a86af116162f2370dd09a3b849acca92861e3b84791e13f1e0c55181108a69bdfdfd7ad502',
  },
  {
    email: 'omar@demo.aaico.com',
    name: 'Omar Busaileh',
    roles: ['employee', 'manager'],
    managerName: '',
    salt: '81ba7811740f5ae4d03c8859a85232d6',
    hash: '74b0b3f2a1b93711a91166c8283dbeda1938df18798e1d600c5fb209a87e2439e57acd3f582d009a89669146da4fb1771ebd947755372e0b9bad350af050ba72',
  },
  {
    email: 'sara@demo.aaico.com',
    name: 'Sara Khalil',
    roles: ['employee', 'manager'],
    managerName: '',
    salt: 'badc0baeda716eda64eec11989723122',
    hash: '521ad4110cfe7d46d4715dcbd58ac47038ee26976866fdef356aa346c88ec1fd62ec2198239403e875629e89e6a3521709183aa2db8030fb3cae513bd6d4e882',
  },
  {
    email: 'admin@demo.aaico.com',
    name: 'Portal Admin',
    roles: ['employee', 'admin'],
    managerName: '',
    salt: '256ee429da5a34da83678ed106f05e10',
    hash: '39ecd963af30e384990993325a1c0874dcfef1c7cb1d62a7016c06e5df2c189a769475c31ecebdbaf5a7646466b6bea473fee314cfb48acad68d94e71f2ce2ce',
  },
];

function emailList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const EXTRA_ADMINS = emailList(process.env.ADMIN_EMAILS);

const ready = () => true;

function findUser(email) {
  const e = String(email || '').trim().toLowerCase();
  return USERS.find((u) => u.email === e) || null;
}

function verifyPassword(user, password) {
  if (!user || !password) return false;
  try {
    const derived = crypto.scryptSync(
      String(password), Buffer.from(user.salt, 'hex'),
      SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }
    );
    return crypto.timingSafeEqual(derived, Buffer.from(user.hash, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Roles an account carries by definition. "manager" can also be earned by being
 * named on a claim — server.js adds that at request time.
 */
function baseRolesFor(email) {
  const user = findUser(email);
  const roles = user ? user.roles.slice() : ['employee'];
  if (EXTRA_ADMINS.indexOf(String(email).toLowerCase()) !== -1 && roles.indexOf('admin') === -1) {
    roles.push('admin');
  }
  return roles;
}

/** The manager a demo employee is set up under, used to prefill the form. */
function defaultManagerFor(email) {
  const user = findUser(email);
  return user ? (user.managerName || '') : '';
}

/* ------------------------------ crypto ------------------------------ */

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function safeEqual(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function seal(payload) {
  var body = b64url(JSON.stringify(payload));
  return body + '.' + hmac(body);
}

function unseal(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  if (!safeEqual(parts[1], hmac(parts[0]))) return null;
  try {
    var payload = JSON.parse(b64urlDecode(parts[0]));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------ cookies ----------------------------- */

function parseCookies(req) {
  var out = {};
  (req.headers.cookie || '').split(';').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i === -1) return;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  var bits = [
    name + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    'Max-Age=' + maxAgeSeconds,
  ];
  var existing = res.getHeader('Set-Cookie') || [];
  if (!Array.isArray(existing)) existing = [existing];
  res.setHeader('Set-Cookie', existing.concat(bits.join('; ')));
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

/* ------------------------------ session ----------------------------- */

function sessionFrom(req) {
  return unseal(parseCookies(req)[SESSION_COOKIE]);
}

function startSession(res, profile) {
  var payload = {
    email: profile.email,
    name: profile.name || profile.email,
    roles: baseRolesFor(profile.email),
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  };
  setCookie(res, SESSION_COOKIE, seal(payload), SESSION_HOURS * 3600);
  return payload;
}

function endSession(res) {
  clearCookie(res, SESSION_COOKIE);
}

/** Express guard. `roles` empty means any signed-in person. */
function require_(roles) {
  var needed = roles || [];
  return function (req, res, next) {
    var session = sessionFrom(req);
    if (!session) {
      return res.status(401).json({ error: 'Please sign in.', code: 'signed_out' });
    }
    if (needed.length && !needed.some(function (r) { return session.roles.indexOf(r) !== -1; })) {
      return res.status(403).json({ error: 'Your account does not have access to this.', code: 'forbidden' });
    }

    req.session = session;
    next();
  };
}

/* -------------------------------- flow ------------------------------ */

function login(req, res) {
  const email = req.body && req.body.email;
  const password = req.body && req.body.password;

  const user = findUser(email);
  const ok = verifyPassword(user, password);

  // One message for both cases, so the form never reveals which addresses exist.
  if (!ok) {
    return res.status(401).json({ error: 'That email and password do not match a demo account.' });
  }

  const session = startSession(res, { email: user.email, name: user.name });
  res.json({ ok: true, email: session.email, name: session.name, roles: session.roles });
}

module.exports = {
  ready,
  baseRolesFor,
  defaultManagerFor,
  sessionFrom,
  endSession,
  require: require_,
  login,
  accounts: USERS.map((u) => ({ email: u.email, name: u.name, roles: u.roles })),
  config: {
    demo: true,
    secretIsDefault: !process.env.SESSION_SECRET,
    accounts: USERS.length,
  },
};
