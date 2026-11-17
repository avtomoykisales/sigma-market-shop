/* ============================================================
   Вход клиентов по email+паролю и/или Telegram (см. database.js:
   customers.password_hash/telegram_id, email_codes, email_verified_tokens).
   Пароли хешируем встроенным crypto.scrypt — без лишней npm-зависимости.
   ============================================================ */
const crypto = require('crypto');
const db = require('./database');
const notify = require('./notify');

const CODE_TTL_MIN = 10;
const REG_TOKEN_TTL_MIN = 15;
const RESEND_COOLDOWN_SEC = 60;
const MAX_ATTEMPTS = 5;

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры
}

// ---- пароли ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  let hashBuf, testBuf;
  try {
    hashBuf = Buffer.from(hash, 'hex');
    testBuf = crypto.scryptSync(password, salt, 64);
  } catch (e) { return false; }
  return hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf);
}

// ---- код на email ----
async function requestEmailCode(email) {
  await db.runAsync(`DELETE FROM email_codes WHERE expires_at < datetime('now')`);
  const recent = await db.getAsync(
    `SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1`, [email]
  );
  if (recent) {
    const age = (Date.now() - new Date(recent.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (age < RESEND_COOLDOWN_SEC) throw new Error('Подождите ' + Math.ceil(RESEND_COOLDOWN_SEC - age) + ' сек. перед повторной отправкой');
  }
  const code = genCode();
  await notify.sendEmailCode(email, code);
  await db.runAsync(
    `INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, datetime('now', '+${CODE_TTL_MIN} minutes'))`,
    [email, code]
  );
}

// Возвращает одноразовый regToken, разрешающий шаг "телефон + пароль" без повторного кода.
async function verifyEmailCode(email, code) {
  const row = await db.getAsync(`SELECT * FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1`, [email]);
  if (!row) throw new Error('Код не запрашивался или истёк — запросите новый');
  if (row.attempts >= MAX_ATTEMPTS) throw new Error('Слишком много попыток — запросите новый код');
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    throw new Error('Код истёк — запросите новый');
  }
  if (String(code) !== row.code) {
    await db.runAsync(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    throw new Error('Неверный код');
  }
  await db.runAsync(`DELETE FROM email_codes WHERE id = ?`, [row.id]);
  const token = crypto.randomBytes(24).toString('base64url');
  await db.runAsync(
    `INSERT INTO email_verified_tokens (token, email, expires_at) VALUES (?, ?, datetime('now', '+${REG_TOKEN_TTL_MIN} minutes'))`,
    [token, email]
  );
  return token;
}

// Проверяет и "сжигает" regToken — вызывается на шаге завершения регистрации
// (телефон + пароль), чтобы нельзя было пройти этот шаг без подтверждённого email.
async function consumeRegToken(email, token) {
  await db.runAsync(`DELETE FROM email_verified_tokens WHERE expires_at < datetime('now')`);
  if (!token) throw new Error('Сессия подтверждения истекла — начните заново');
  const row = await db.getAsync(`SELECT * FROM email_verified_tokens WHERE token = ? AND email = ?`, [token, email]);
  if (!row) throw new Error('Сессия подтверждения истекла — начните заново');
  await db.runAsync(`DELETE FROM email_verified_tokens WHERE token = ?`, [token]);
}

// ---- Telegram Login Widget ----
// Проверка подписи данных от виджета (https://core.telegram.org/widgets/login#checking-authorization).
// secretKey = SHA256(botToken); данные проверяются HMAC-SHA256 по всем полям кроме hash,
// отсортированным по ключу и склеенным как "key=value\n".
function verifyTelegramAuth(data, botToken) {
  if (!botToken) throw new Error('Telegram-бот не настроен');
  const { hash, ...fields } = data || {};
  if (!hash) throw new Error('Некорректные данные от Telegram');
  const checkString = Object.keys(fields)
    .filter(k => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  const hashBuf = Buffer.from(String(hash), 'hex');
  const computedBuf = Buffer.from(computedHash, 'hex');
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    throw new Error('Подпись Telegram не совпадает');
  }
  // auth_date — не старше суток, иначе чужой перехваченный запрос можно было бы переиграть позже.
  const authDate = Number(fields.auth_date) * 1000;
  if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) {
    throw new Error('Данные от Telegram устарели — войдите ещё раз');
  }
  return true;
}

module.exports = {
  hashPassword, verifyPassword,
  requestEmailCode, verifyEmailCode, consumeRegToken,
  verifyTelegramAuth,
};
