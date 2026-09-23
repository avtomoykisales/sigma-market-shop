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

// Отправка в произвольный WhatsApp-номер через её же Green API — используется и
// для уведомления о заказе (на её номер), и для кода входа клиента (на его номер).
async function sendWhatsAppTo(phone, text) {
  const id = process.env.GREEN_API_ID, token = process.env.GREEN_API_TOKEN;
  if (!id || !token) throw new Error('Green API не настроен');
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
  if (!cfg || !cfg.green_api_id || !cfg.green_api_token || !cfg.notify_phone) return;
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
      .then(() => cfg.green_api_id && console.log('WhatsApp: заказ №' + order.id + ' отправлен на ' + cfg.notify_phone))
      .catch(e => logFail('notify_whatsapp', 'заказ №' + order.id + ': ' + e.message)),
    sendEmail(cfg, `Новый заказ №${order.id || ''} — b2btech.kz`, text)
      .then(() => cfg.smtp_host && console.log('Email: заказ №' + order.id + ' отправлен на ' + cfg.notify_email))
      .catch(e => logFail('notify_email', 'заказ №' + order.id + ': ' + e.message)),
  ]);
}

module.exports = { notifyOrder, sendWhatsAppTo, hasWhatsApp, logFail };
