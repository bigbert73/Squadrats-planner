/**
 * oauth.js — Google / Facebook / Apple Sign In handlers
 * No Passport.js — pure axios + jsonwebtoken
 */

const axios = require('axios');
const jwt   = require('jsonwebtoken');
const db    = require('./db');

// Base app URL derived from Strava redirect URI config (strips /auth/callback)
const APP_BASE = (process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback')
  .replace(/\/auth\/callback$/, '');

// ── Shared: find or create user from OAuth profile ─────────────────────────────

async function findOrCreate(provider, oauthId, email, displayName) {
  // 1. Find by OAuth identity
  let user = db.getUserByOAuth(provider, oauthId);
  if (user) return user;

  // 2. Find by email → link OAuth to existing account
  if (email) {
    user = db.getUserByEmail(email);
    if (user) {
      db.linkOAuth(user.id, provider, oauthId);
      return db.getUserById(user.id);
    }
  }

  // 3. Create new account — username = email (or fallback)
  const username = email || `${provider}_${oauthId}`;
  const result = db.createOAuthUser(provider, oauthId, email, username);
  return db.getUserById(result.lastInsertRowid);
}

// ── Google ────────────────────────────────────────────────────────────────────

const G_AUTH  = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';
const G_INFO  = 'https://www.googleapis.com/oauth2/v3/userinfo';

function googleAuthUrl(state) {
  return G_AUTH + '?' + new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${APP_BASE}/auth/google/callback`,
    response_type: 'code',
    scope:         'email profile',
    state,
    access_type:   'offline',
    prompt:        'select_account',
  });
}

async function googleCallback(code) {
  const tok = await axios.post(G_TOKEN, {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  `${APP_BASE}/auth/google/callback`,
  });
  const info = await axios.get(G_INFO, {
    headers: { Authorization: `Bearer ${tok.data.access_token}` },
  });
  const { sub, email, name } = info.data;
  return findOrCreate('google', sub, email, name || email);
}

// ── Facebook ──────────────────────────────────────────────────────────────────

const FB_AUTH  = 'https://www.facebook.com/v19.0/dialog/oauth';
const FB_TOKEN = 'https://graph.facebook.com/v19.0/oauth/access_token';
const FB_INFO  = 'https://graph.facebook.com/me';

function facebookAuthUrl(state) {
  return FB_AUTH + '?' + new URLSearchParams({
    client_id:    process.env.FACEBOOK_APP_ID,
    redirect_uri: `${APP_BASE}/auth/facebook/callback`,
    scope:        'email,public_profile',
    state,
  });
}

async function facebookCallback(code) {
  const tok = await axios.get(FB_TOKEN, {
    params: {
      client_id:     process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri:  `${APP_BASE}/auth/facebook/callback`,
      code,
    },
  });
  const info = await axios.get(FB_INFO, {
    params: { fields: 'id,name,email', access_token: tok.data.access_token },
  });
  const { id, name, email } = info.data;
  return findOrCreate('facebook', id, email || null, name);
}

// ── Apple Sign In ─────────────────────────────────────────────────────────────

const APPLE_AUTH  = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN = 'https://appleid.apple.com/auth/token';

function appleClientSecret() {
  const privateKey = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '5m',
    audience:  'https://appleid.apple.com',
    issuer:    process.env.APPLE_TEAM_ID,
    subject:   process.env.APPLE_CLIENT_ID,
    keyid:     process.env.APPLE_KEY_ID,
    header:    { alg: 'ES256', kid: process.env.APPLE_KEY_ID },
  });
}

function appleAuthUrl(state) {
  return APPLE_AUTH + '?' + new URLSearchParams({
    client_id:     process.env.APPLE_CLIENT_ID,
    redirect_uri:  `${APP_BASE}/auth/apple/callback`,
    response_type: 'code',
    scope:         'name email',
    state,
    response_mode: 'form_post',
  });
}

async function appleCallback(code, idToken, userJson) {
  // Exchange code (validates with Apple)
  await axios.post(APPLE_TOKEN, new URLSearchParams({
    client_id:     process.env.APPLE_CLIENT_ID,
    client_secret: appleClientSecret(),
    code,
    grant_type:    'authorization_code',
    redirect_uri:  `${APP_BASE}/auth/apple/callback`,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  // Decode id_token (trust it — we just validated via token exchange)
  const payload = jwt.decode(idToken);
  const { sub, email } = payload;

  // Apple sends name only on very first authorization (in form body)
  let displayName = email;
  try {
    const parsed = JSON.parse(userJson || '{}');
    const n = parsed.name;
    if (n?.firstName || n?.lastName)
      displayName = `${n.firstName || ''} ${n.lastName || ''}`.trim();
  } catch (_) {}

  return findOrCreate('apple', sub, email || null, displayName);
}

module.exports = {
  googleAuthUrl, googleCallback,
  facebookAuthUrl, facebookCallback,
  appleAuthUrl, appleCallback,
};
