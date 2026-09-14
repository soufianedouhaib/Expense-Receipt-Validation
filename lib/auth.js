/**
 * Google sign-in, restricted to one Workspace domain.
 *
 * Authorization-code flow, done by hand so there is no SDK to keep current:
 *   1. /api/auth/google    → bounce to Google with a signed state cookie
 *   2. /api/auth/callback  → swap the code for tokens, read the id_token,
 *                            check it really is ours and really is in-domain,
 *                            then set a signed session cookie
 *
 * The session cookie is HttpOnly and signed with SESSION_SECRET. It carries no
 * secret of its own — just who the person is and what they may do — so a stolen
 * cookie is the whole exposure, and it expires on its own.
 *
 * Required environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   from the Google Cloud OAuth client
 *   SESSION_SECRET                            any long random string
 *   APP_URL                                   e.g. https://your-app.vercel.app
 *   ALLOWED_EMAIL_DOMAIN                      e.g. aaico.com
 *   ADMIN_EMAILS, MANAGER_EMAILS              comma-separated, optional
 */

const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();

const SESSION_COOKIE = 'aaico_session';
const STATE_COOKIE = 'aaico_oauth_state';
const SESSION_HOURS = 12;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const ready = () => Boolean(CLIENT_ID && CLIENT_SECRET && SESSION_SECRET && APP_URL);

function emailList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMINS = emailList(process.env.ADMIN_EMAILS);
const MANAGERS = emailList(process.env.MANAGER_EMAILS);

/** Everyone in the domain may submit. Manager and admin are by allowlist. */
function rolesFor(email) {
  var e = String(email || '').toLowerCase();
  var roles = ['employee'];
  if (MANAGERS.indexOf(e) !== -1) roles.push('manager');
  if (ADMINS.indexOf(e) !== -1) roles.push('admin');
  return roles;
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
  if (!ready()) return null;
  return unseal(parseCookies(req)[SESSION_COOKIE]);
}

function startSession(res, profile) {
  var payload = {
    email: profile.email,
    name: profile.name || profile.email,
    picture: profile.picture || '',
    roles: rolesFor(profile.email),
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
    if (!ready()) {
      return res.status(503).json({
        error: 'Sign-in is not configured on this deployment.',
        code: 'auth_not_configured',
      });
    }
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

function redirectUri() {
  return APP_URL + '/api/auth/callback';
}

function beginLogin(req, res) {
  if (!ready()) {
    return res.status(503).send('Sign-in is not configured on this deployment.');
  }
  var state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, seal({ state: state, exp: Date.now() + 10 * 60 * 1000 }), 600);

  var params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    prompt: 'select_account',
    access_type: 'online',
  });
  // A hint to Google, not a guarantee — the domain is checked again below.
  if (DOMAIN) params.set('hd', DOMAIN);

  res.redirect(AUTH_ENDPOINT + '?' + params.toString());
}

async function completeLogin(req, res) {
  if (!ready()) return res.status(503).send('Sign-in is not configured on this deployment.');

  var fail = function (reason) {
    clearCookie(res, STATE_COOKIE);
    res.redirect('/?error=' + encodeURIComponent(reason));
  };

  if (req.query.error) return fail('Google returned: ' + req.query.error);

  var stored = unseal(parseCookies(req)[STATE_COOKIE]);
  if (!stored || !req.query.state || !safeEqual(stored.state, req.query.state)) {
    return fail('That sign-in attempt expired. Please try again.');
  }
  if (!req.query.code) return fail('No authorisation code came back from Google.');

  try {
    var tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });

    var tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) {
      console.error('[auth] token exchange failed', tokens);
      return fail('Google would not complete the sign-in.');
    }

    // The id_token arrived directly from Google over TLS on a request
    // authenticated with our client secret, so reading the payload is safe.
    // These checks confirm it was minted for this app and this domain.
    var payload = JSON.parse(b64urlDecode(tokens.id_token.split('.')[1]));

    if (payload.aud !== CLIENT_ID) return fail('That token was not issued for this app.');
    if (['accounts.google.com', 'https://accounts.google.com'].indexOf(payload.iss) === -1) {
      return fail('Unexpected token issuer.');
    }
    if (payload.exp && payload.exp * 1000 < Date.now()) return fail('That sign-in already expired.');
    if (payload.email_verified === false) return fail('That Google account has no verified email.');

    var email = String(payload.email || '').toLowerCase();
    if (DOMAIN) {
      var inDomain = payload.hd === DOMAIN || email.endsWith('@' + DOMAIN);
      if (!inDomain) {
        return fail('Use your ' + DOMAIN + ' account to sign in.');
      }
    }

    startSession(res, { email: email, name: payload.name, picture: payload.picture });
    clearCookie(res, STATE_COOKIE);
    res.redirect('/');
  } catch (err) {
    console.error('[auth] callback failed', err);
    fail('Something went wrong completing the sign-in.');
  }
}

module.exports = {
  ready,
  rolesFor,
  sessionFrom,
  endSession,
  require: require_,
  beginLogin,
  completeLogin,
  config: {
    domain: DOMAIN || null,
    admins: ADMINS.length,
    managers: MANAGERS.length,
    appUrl: APP_URL || null,
  },
};
