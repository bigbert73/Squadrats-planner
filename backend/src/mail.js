/**
 * mail.js — the one e-mail the app sends: the "set a new password" link.
 *
 * Configured with SMTP_URL (smtp[s]://user:password@host:port) and optionally
 * MAIL_FROM. Without SMTP_URL nothing is sent and the app hides the feature.
 */

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* image built before the dependency was added */ }

let transport = null;
const configured = () => !!(nodemailer && (process.env.SMTP_URL || '').trim());
function tx() {
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL.trim());
  return transport;
}

const TEXTS = {
  pl: { s: 'Nowe hasło', b: (app, link) => `Ktoś poprosił o ustawienie nowego hasła do konta w ${app}.\n\nOtwórz ten link, aby je ustawić (ważny 1 godzinę, działa raz):\n${link}\n\nJeśli to nie Ty, zignoruj tę wiadomość — hasło pozostanie bez zmian.` },
  en: { s: 'New password', b: (app, link) => `Someone asked to set a new password for an account at ${app}.\n\nOpen this link to set it (valid for 1 hour, works once):\n${link}\n\nIf that was not you, ignore this message — the password stays as it is.` },
  de: { s: 'Neues Passwort', b: (app, link) => `Jemand hat darum gebeten, ein neues Passwort für ein Konto bei ${app} festzulegen.\n\nÖffne diesen Link, um es festzulegen (1 Stunde gültig, einmal verwendbar):\n${link}\n\nWenn du das nicht warst, ignoriere diese Nachricht — das Passwort bleibt unverändert.` },
  nl: { s: 'Nieuw wachtwoord', b: (app, link) => `Iemand heeft gevraagd om een nieuw wachtwoord in te stellen voor een account bij ${app}.\n\nOpen deze link om het in te stellen (1 uur geldig, werkt één keer):\n${link}\n\nWas jij dit niet? Negeer dan dit bericht — het wachtwoord blijft ongewijzigd.` },
  fr: { s: 'Nouveau mot de passe', b: (app, link) => `Quelqu’un a demandé à définir un nouveau mot de passe pour un compte sur ${app}.\n\nOuvrez ce lien pour le définir (valable 1 heure, utilisable une seule fois) :\n${link}\n\nSi ce n’était pas vous, ignorez ce message — le mot de passe reste inchangé.` },
  cs: { s: 'Nové heslo', b: (app, link) => `Někdo požádal o nastavení nového hesla k účtu v ${app}.\n\nOtevřete tento odkaz a nastavte ho (platí 1 hodinu, funguje jednou):\n${link}\n\nPokud jste to nebyli vy, tuto zprávu ignorujte — heslo zůstane beze změny.` },
};

function from(appName, appBase) {
  if ((process.env.MAIL_FROM || '').trim()) return process.env.MAIL_FROM.trim();
  let host = 'localhost';
  try { host = new URL(appBase).hostname; } catch {}
  return `"${appName.replace(/["\\\r\n]/g, '')}" <no-reply@${host}>`;
}

async function sendReset({ to, link, lang, appName, appBase }) {
  const t = TEXTS[lang] || TEXTS.en;
  await tx().sendMail({ from: from(appName, appBase), to, subject: `${appName}: ${t.s}`, text: t.b(appName, link) });
}

module.exports = { configured, sendReset, LANGS: Object.keys(TEXTS) };
