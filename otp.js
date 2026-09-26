/* ============================================================
   Вход клиентов по одноразовому коду — WhatsApp, при отсутствии
   WhatsApp у номера — SMS через Mobizon. Без паролей.
   Ключи — переменные окружения (см. notify.js).
   ============================================================ */
const db = require('./database');
const notify = require('./notify');

const CODE_TTL_MIN = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_ATTEMPTS = 5;

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры
}

async function sendSms(phone, text) {
  const apiKey = process.env.MOBIZON_API_KEY;
  if (!apiKey) throw new Error('Mobizon не настроен');
  const digits = String(phone).replace(/\D/g, '');
  const url = 'https://api.mobizon.kz/service/message/sendsmsmessage';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ apiKey, recipient: digits, text }).toString(),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || Number(data.code) !== 0) {
    throw new Error('Mobizon: ' + (data && data.message || r.status));
  }
}

// Возвращает {sent:true, channel:'whatsapp'|'sms'} или бросает ошибку, если оба канала недоступны.
async function requestCode(phone) {
  await db.runAsync(`DELETE FROM otp_codes WHERE expires_at < datetime('now')`);
  const recent = await db.getAsync(
    `SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`, [phone]
  );
  if (recent) {
    const age = (Date.now() - new Date(recent.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (age < RESEND_COOLDOWN_SEC) throw new Error('Подождите ' + Math.ceil(RESEND_COOLDOWN_SEC - age) + ' сек. перед повторной отправкой');
  }

  const code = genCode();
  const text = `Код для входа на SIGMA MARKET: ${code}`;
  let channel = null;

  try {
    // У Green API есть проверка "есть ли WhatsApp у номера" — у Meta такой проверки
    // нет, поэтому если настроен именно Meta, просто пробуем отправить: до одобрения
    // шаблона это сработает только в течение 24ч после того, как номер сам написал
    // тестовому номеру в WhatsApp (для проверки Мирой на своём телефоне — этого
    // достаточно), а для чужих клиентов упадёт и тихо уйдёт на SMS — это ожидаемо
    // и безопасно, пока шаблон login_code не одобрен.
    const hasMeta = process.env.META_WA_TOKEN && process.env.META_WA_PHONE_ID;
    if (hasMeta || await notify.hasWhatsApp(phone)) {
      await notify.sendWhatsAppTo(phone, text);
      channel = 'whatsapp';
    }
  } catch (e) { notify.logFail('otp_whatsapp', phone + ': ' + e.message); }

  if (!channel) {
    try {
      await sendSms(phone, text);
      channel = 'sms';
    } catch (e) {
      notify.logFail('otp_sms', phone + ': ' + e.message);
      throw new Error('Не удалось отправить код. Попробуйте позже или свяжитесь с нами.');
    }
  }

  await db.runAsync(
    `INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, datetime('now', '+${CODE_TTL_MIN} minutes'))`,
    [phone, code]
  );
  return { sent: true, channel };
}

// consume=false — проверить код, но не удалять (когда для нового клиента ещё не знаем
// имя: код должен остаться годным для повторной отправки формы вместе с именем).
async function verifyCode(phone, code, consume) {
  if (consume === undefined) consume = true;
  const row = await db.getAsync(
    `SELECT * FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`, [phone]
  );
  if (!row) throw new Error('Код не запрашивался или истёк — запросите новый');
  if (row.attempts >= MAX_ATTEMPTS) throw new Error('Слишком много попыток — запросите новый код');
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    throw new Error('Код истёк — запросите новый');
  }
  if (String(code) !== row.code) {
    await db.runAsync(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    throw new Error('Неверный код');
  }
  if (consume) await db.runAsync(`DELETE FROM otp_codes WHERE id = ?`, [row.id]);
  return true;
}

module.exports = { requestCode, verifyCode };
