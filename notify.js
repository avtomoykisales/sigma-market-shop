/* ============================================================
   Уведомления о заказах — WhatsApp (Green API) и Email.
   Настройки — переменные окружения (deploy/ecosystem.config.js на сервере),
   не в базе: это пароли и токены, в админке им не место. Пустые → канал не срабатывает.
   ============================================================ */
const nodemailer = require('nodemailer');
const db = require('./database');

// Ошибку отправки видно в админке → «Ошибки сайта» — там же, где баги у посетителей,
// чтобы Мира не просила смотреть логи сервера каждый раз.
function logFail(context, message) {
  console.error(context + ' notify failed:', message);
  db.runAsync(
    `INSERT INTO client_errors (message, context, url) VALUES (?,?,?)`,
    [String(message).slice(0, 2000), context, '']
  ).catch(() => {});
}

function envConfig() {
  return {
    meta_wa_token: process.env.META_WA_TOKEN || '',
    meta_wa_phone_id: process.env.META_WA_PHONE_ID || '',
    green_api_id: process.env.GREEN_API_ID || '',
    green_api_token: process.env.GREEN_API_TOKEN || '',
    notify_phone: process.env.NOTIFY_PHONE || '',
    smtp_host: process.env.SMTP_HOST || '',
    smtp_port: process.env.SMTP_PORT || '',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    notify_email: process.env.NOTIFY_EMAIL || '',
  };
}

function orderText(o) {
  let items = [];
  try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []); } catch {}
  const itemsText = items.length
    ? items.map(i => `• ${i.name || i.title || 'товар'} — ${i.qty || 1} шт`).join('\n')
    : '';
  return [
    `Новый заказ №${o.id || ''}`,
    `Имя: ${o.name}`,
    `Телефон: ${o.phone}`,
    o.email ? `Email: ${o.email}` : '',
    o.city ? `Город: ${o.city}` : '',
    itemsText,
    o.total ? `Итого: ${Number(o.total).toLocaleString('ru-KZ')} ₸` : '',
    o.message ? `Комментарий: ${o.message}` : '',
  ].filter(Boolean).join('\n');
}

// Отправка через официальный Meta Business API (Graph API). Важное ограничение
// самой платформы (не наш баг): свободным текстом Meta разрешает писать только в
// течение 24 часов после того, как ЭТОТ номер сам первым написал боту, либо в рамках
// тестовых 5 номеров, подтверждённых в Meta for Developers. Вне этого — нужен
// заранее одобренный Meta шаблон сообщения (Message Templates в кабинете WhatsApp).
// ВРЕМЕННО, только для проверки: у Миры в списке разрешённых тестовых получателей
// Meta её номер почему-то сохранился с лишней "8" в начале (похоже на баг маски
// номера для Казахстана в самой Meta) — подставляем эту же "8" только для ЕЁ номера,
// чтобы он совпал с тем, что реально подтверждено. На остальных номерах не сказывается.
// Убрать, когда список разрешённых получателей перестанет быть нужен (см. notify.js).
const TEST_RECIPIENT_DIGIT_FIX = { '77027900709': '787027900709' };

async function sendWhatsAppMeta(phone, text) {
  const token = process.env.META_WA_TOKEN, phoneId = process.env.META_WA_PHONE_ID;
  if (!token || !phoneId) throw new Error('Meta WhatsApp API не настроен');
  let digits = String(phone).replace(/\D/g, '');
  digits = TEST_RECIPIENT_DIGIT_FIX[digits] || digits;
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: text } }),
  });
  if (!r.ok) throw new Error('Meta WhatsApp API: ' + r.status + ' ' + (await r.text()));
}

// Отправка в произвольный WhatsApp-номер — сначала пробуем Meta (если настроен),
// иначе Green API. Используется и для уведомления о заказе (на её номер), и для
// кода входа клиента (на его номер, только через Green API — см. hasWhatsApp).
async function sendWhatsAppTo(phone, text) {
  if (process.env.META_WA_TOKEN && process.env.META_WA_PHONE_ID) return sendWhatsAppMeta(phone, text);
  const id = process.env.GREEN_API_ID, token = process.env.GREEN_API_TOKEN;
  if (!id || !token) throw new Error('WhatsApp не настроен');
  const digits = String(phone).replace(/\D/g, '');
  const url = `https://api.green-api.com/waInstance${id}/sendMessage/${token}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: `${digits}@c.us`, message: text }),
  });
  if (!r.ok) throw new Error('Green API: ' + r.status + ' ' + (await r.text()));
}

// Есть ли у номера WhatsApp вообще — чтобы не слать код в пустоту, а сразу по SMS.
async function hasWhatsApp(phone) {
  const id = process.env.GREEN_API_ID, token = process.env.GREEN_API_TOKEN;
  if (!id || !token) return false;
  const digits = String(phone).replace(/\D/g, '');
  const url = `https://api.green-api.com/waInstance${id}/checkWhatsapp/${token}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: Number(digits) }),
  });
  if (!r.ok) return false;
  const data = await r.json().catch(() => null);
  return !!(data && data.existsWhatsapp);
}

async function sendWhatsApp(cfg, text) {
  if (!cfg || !cfg.notify_phone) return;
  const hasMeta = cfg.meta_wa_token && cfg.meta_wa_phone_id;
  const hasGreen = cfg.green_api_id && cfg.green_api_token;
  if (!hasMeta && !hasGreen) return;
  await sendWhatsAppTo(cfg.notify_phone, text);
}

async function sendEmail(cfg, subject, text) {
  if (!cfg || !cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass || !cfg.notify_email) return;
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_port) || 465,
    secure: Number(cfg.smtp_port) !== 587,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
  });
  await transporter.sendMail({
    from: cfg.smtp_user,
    to: cfg.notify_email,
    subject,
    text,
  });
}

async function notifyOrder(order) {
  const cfg = envConfig();
  const text = orderText(order);
  await Promise.all([
    sendWhatsApp(cfg, text)
      .then(() => (cfg.meta_wa_token || cfg.green_api_id) && console.log('WhatsApp: заказ №' + order.id + ' отправлен на ' + cfg.notify_phone))
      .catch(e => logFail('notify_whatsapp', 'заказ №' + order.id + ': ' + e.message)),
    sendEmail(cfg, `Новый заказ №${order.id || ''} — b2btech.kz`, text)
      .then(() => cfg.smtp_host && console.log('Email: заказ №' + order.id + ' отправлен на ' + cfg.notify_email))
      .catch(e => logFail('notify_email', 'заказ №' + order.id + ': ' + e.message)),
  ]);
}

module.exports = { notifyOrder, sendWhatsAppTo, hasWhatsApp, logFail };
