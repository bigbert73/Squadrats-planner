/**
 * oauth.js — Google Sign In handler
 */

const axios = require('axios');
const db    = require('./db');

const APP_BASE = (process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback')
  .replace(/\/auth\/callback$/, '');

// `email` is only passed when the provider has confirmed that the address
// belongs to this person: an existing account is joined by e-mail, so an
// unconfirmed address would let anyone into somebody else's account.
async function findOrCreate(provider, oauthId, email, displayName) {
  let user = db.getUserByOAuth(provider, oauthId);
  if (user) return user;

  if (email) {
    user = db.getUserByEmail(email);
    if (user) {
      db.linkOAuth(user.id, provider, oauthId);
      return db.getUserById(user.id);
    }
  }

  const fallback = `${provider}_${oauthId}`;
  const username = email && !db.getUserByUsername(email) ? email : fallback;
  const result = db.createOAuthUser(provider, oauthId, email, username);
  return db.getUserById(result.lastInsertRowid);
}

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
  const { sub, email, name, email_verified } = info.data;
  if (typeof sub !== 'string' || !sub) throw new Error('Google nie zwróciło identyfikatora konta');
  const verified = email_verified === true || email_verified === 'true';
  return findOrCreate('google', sub, verified && typeof email === 'string' ? email : null, name || email);
}

module.exports = { googleAuthUrl, googleCallback, findOrCreate, APP_BASE };
