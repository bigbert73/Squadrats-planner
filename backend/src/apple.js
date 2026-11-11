/**
 * apple.js — Sign in with Apple (web flow).
 *
 * Needs an Apple Developer account. In the environment:
 *   APPLE_CLIENT_ID    the Services ID (e.g. com.example.planner.web)
 *   APPLE_TEAM_ID      the team's 10-character id
 *   APPLE_KEY_ID       id of the "Sign in with Apple" key
 *   APPLE_PRIVATE_KEY  the .p8 key itself (line breaks may be written as \n),
 *                      or APPLE_PRIVATE_KEY_FILE with a path to it
 * and, at Apple, the return address <app address>/auth/apple/callback.
 * Without them the button is not shown.
 */

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// Both are replaced by a local stand-in in the test suite
const API  = process.env.APPLE_API_BASE  || 'https://appleid.apple.com';   // token exchange and keys
const AUTH = process.env.APPLE_AUTH_BASE || 'https://appleid.apple.com';   // the screen the person is sent to
const ISSUER = 'https://appleid.apple.com';

function privateKey() {
  let k = process.env.APPLE_PRIVATE_KEY || '';
  if (!k && process.env.APPLE_PRIVATE_KEY_FILE) { try { k = fs.readFileSync(process.env.APPLE_PRIVATE_KEY_FILE, 'utf8'); } catch { k = ''; } }
  return k.replace(/\\n/g, '\n').trim();
}
const cfg = () => ({
  clientId: (process.env.APPLE_CLIENT_ID || '').trim(), teamId: (process.env.APPLE_TEAM_ID || '').trim(),
  keyId: (process.env.APPLE_KEY_ID || '').trim(), key: privateKey(),
});
const configured = () => { const c = cfg(); return !!(c.clientId && c.teamId && c.keyId && c.key); };

// Apple only hands out the e-mail address when the answer comes back as a
// form POST, so that is how it comes back (see /auth/apple/callback).
function authUrl(state, redirectUri) {
  return `${AUTH}/auth/authorize?` + new URLSearchParams({
    client_id: cfg().clientId, redirect_uri: redirectUri, response_type: 'code', response_mode: 'form_post', scope: 'email', state,
  });
}

// Apple's "client secret" is a short-lived token signed with the .p8 key
function clientSecret(c) {
  return jwt.sign({}, c.key, { algorithm: 'ES256', keyid: c.keyId, issuer: c.teamId, audience: ISSUER, subject: c.clientId, expiresIn: '5m' });
}

let keys = null, keysAt = 0;
async function signingKey(kid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!keys || Date.now() - keysAt > 3600 * 1000 || attempt) {
      keys = (await axios.get(`${API}/auth/keys`, { timeout: 10000 })).data?.keys || [];
      keysAt = Date.now();
    }
    const k = keys.find(j => j.kid === kid);
    if (k) return crypto.createPublicKey({ key: k, format: 'jwk' });
  }
  throw new Error('Apple: nieznany klucz podpisu');
}

// code → { sub, email (only when Apple confirms it belongs to the person) }
async function exchange(code, redirectUri) {
  const c = cfg();
  const r = await axios.post(`${API}/auth/token`, new URLSearchParams({
    client_id: c.clientId, client_secret: clientSecret(c), code, grant_type: 'authorization_code', redirect_uri: redirectUri,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  const idToken = r.data?.id_token;
  if (typeof idToken !== 'string') throw new Error('Apple nie zwróciło tokenu');
  const head = jwt.decode(idToken, { complete: true })?.header;
  if (!head?.kid) throw new Error('Apple: nieprawidłowy token');
  const d = jwt.verify(idToken, await signingKey(head.kid), { algorithms: ['RS256'], issuer: ISSUER, audience: c.clientId });
  if (typeof d.sub !== 'string' || !d.sub) throw new Error('Apple nie zwróciło identyfikatora konta');
  const verified = d.email_verified === true || d.email_verified === 'true';
  return { sub: d.sub, email: verified && typeof d.email === 'string' ? d.email : null };
}

module.exports = { configured, authUrl, exchange };
