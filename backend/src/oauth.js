/**
 * oauth.js — Google Sign In handler
 */

const axios = require('axios');
const db    = require('./db');

const APP_BASE = (process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback')
  .replace(/\/auth\/callback$/, '');

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

  const username = email || `${provider}_${oauthId}`;
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
  const { sub, email, name } = info.data;
  return findOrCreate('google', sub, email, name || email);
}

module.exports = { googleAuthUrl, googleCallback };
