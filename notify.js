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
    o.paymentMethod ? `Оплата: ${o.paymentMethod}` : '',
    o.deliveryMethod ? `Доставка: ${o.deliveryMethod}` : '',
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

// Отправка одобренного шаблона сообщения (Message Templates в WhatsApp Manager).
// В отличие от sendWhatsAppMeta (свободный текст) работает на любой номер без
// ограничения "тестовых 5 получателей" — именно поэтому TEST_RECIPIENT_DIGIT_FIX
// сюда не подставляем, шлём настоящие цифры номера как есть.
// buttonUrlParam — необязательный: значение для динамической части URL кнопки шаблона
// (если в шаблоне есть кнопка "Посетить сайт" с динамическим URL — её переменная {{1}},
// отдельная от переменных в тексте, не путать). Без неё — компонент кнопки не шлём,
// подходит для шаблонов без такой кнопки (new_order и т.п.).
async function sendWhatsAppTemplate(phone, templateName, langCode, bodyParams, buttonUrlParam) {
  const token = process.env.META_WA_TOKEN, phoneId = process.env.META_WA_PHONE_ID;
  if (!token || !phoneId) throw new Error('Meta WhatsApp API не настроен');
  const digits = String(phone).replace(/\D/g, '');
  const components = [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t || '—') })) }];
  if (buttonUrlParam != null) {
    components.push({
      type: 'button', sub_type: 'url', index: '0',
      parameters: [{ type: 'text', text: String(buttonUrlParam) }],
    });
  }
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: digits,
      type: 'template',
      template: { name: templateName, language: { code: langCode }, components },
    }),
  });
  if (!r.ok) throw new Error('Meta WhatsApp API (template ' + templateName + '): ' + r.status + ' ' + (await r.text()));
}

// Meta отклоняет параметры шаблона с переносами строк/табами или 5+ пробелами подряд
// (ошибка 132018) — склеиваем в одну строку через " | " вместо потери содержимого.
function tplSafe(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' | ').replace(/ {5,}/g, ' ').trim();
}

// Параметры для шаблона new_order (служебный, Meta WhatsApp Manager): №заказа, имя,
// телефон, детали заказа (товары + сумма + оплата + доставка — упаковано в одну
// переменную, чтобы не трогать структуру уже созданного шаблона), комментарий клиента.
function orderTemplateParams(o) {
  let items = [];
  try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []); } catch {}
  const itemsText = items.length
    ? items.map(i => `${i.name || i.title || 'товар'} ×${i.qty || 1}`).join(', ')
    : '—';
  const details = [
    itemsText,
    o.total ? `Итого: ${Number(o.total).toLocaleString('ru-KZ')} ₸` : '',
    o.paymentMethod ? `Оплата: ${o.paymentMethod}` : '',
    o.deliveryMethod ? `Доставка: ${o.deliveryMethod}` : '',
    o.city ? `Город: ${o.city}` : '',
  ].filter(Boolean).join(' | ');
  return [o.id || '', o.name || '', o.phone || '', details, o.message || '—'].map(tplSafe);
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

// order — исходный объект заказа (для шаблона new_order нужны его поля отдельно,
// не только готовый текст); text — тот же текст, что уходит в sendEmail, на случай
// канала без поддержки шаблонов (Green API).
async function sendWhatsApp(cfg, order, text) {
  if (!cfg || !cfg.notify_phone) return;
  const hasMeta = cfg.meta_wa_token && cfg.meta_wa_phone_id;
  const hasGreen = cfg.green_api_id && cfg.green_api_token;
  if (!hasMeta && !hasGreen) return;
  // Через официальный Meta API — только одобренным шаблоном (new_order), свободный
  // текст Meta пропускает лишь в 24-часовом окне/для тестовых номеров (см. sendWhatsAppMeta).
  // Green API — не через Meta, ограничения на шаблон не действуют, шлём как раньше.
  if (hasMeta) return sendWhatsAppTemplate(cfg.notify_phone, 'new_order', 'ru', orderTemplateParams(order));
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

// Код подтверждения email при входе/регистрации клиента (см. auth.js) — в отличие от
// sendEmail() выше (всегда шлёт админу), это письмо самому клиенту на указанный им адрес.
async function sendEmailCode(toEmail, code) {
  const cfg = envConfig();
  if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass) throw new Error('Почта не настроена (SMTP)');
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_port) || 465,
    secure: Number(cfg.smtp_port) !== 587,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
  });
  await transporter.sendMail({
    from: `SIGMA MARKET <${cfg.smtp_user}>`,
    to: toEmail,
    subject: `Код подтверждения: ${code} — SIGMA MARKET`,
    text: `Ваш код для входа на сайт b2btech.kz: ${code}\n\nКод действует 10 минут. Если вы не запрашивали его — просто проигнорируйте это письмо.`,
  });
}

async function notifyOrder(order) {
  const cfg = envConfig();
  const text = orderText(order);
  await Promise.all([
    sendWhatsApp(cfg, order, text)
      .then(() => (cfg.meta_wa_token || cfg.green_api_id) && console.log('WhatsApp: заказ №' + order.id + ' отправлен на ' + cfg.notify_phone))
      .catch(e => logFail('notify_whatsapp', 'заказ №' + order.id + ': ' + e.message)),
    sendEmail(cfg, `Новый заказ №${order.id || ''} — b2btech.kz`, text)
      .then(() => cfg.smtp_host && console.log('Email: заказ №' + order.id + ' отправлен на ' + cfg.notify_email))
      .catch(e => logFail('notify_email', 'заказ №' + order.id + ': ' + e.message)),
  ]);
}

// Просьба оставить отзыв — клиенту, через 3+ дня после того, как заказ отмечен
// выполненным (см. runReviewRequestsIfDue в server.js). Отдельный одобренный шаблон
// (категория Marketing — это не статус транзакции, а просьба о доп. действии),
// не сам Utility-шаблон new_order. Работает только через официальный Meta API —
// у Green API нет собственного понятия "шаблон", туда эта рассылка не идёт.
async function sendReviewRequest(order) {
  const token = process.env.META_WA_TOKEN, phoneId = process.env.META_WA_PHONE_ID;
  if (!token || !phoneId) throw new Error('Meta WhatsApp API не настроен');
  const siteUrl = (process.env.SITE_URL || 'https://b2btech.kz').replace(/\/+$/, '');
  // Ведём на вкладку "Отзывы" КАЖДОГО товара из заказа (см. #reviews в product.js) —
  // раньше брали только самый дорогой и просили отзыв лишь по нему, остальные товары
  // заказа отзыва никогда не получали. Если в заказе вообще нет товара с id (например,
  // собрали вручную текстом в админке) — ведём на общую страницу отзывов о компании.
  let items = [];
  try { items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); } catch {}
  const validItems = items.filter(i => i && i.id);
  // Кнопка "Посетить сайт" умеет вести только по одной ссылке — для неё берём самый
  // дорогой товар (как и раньше), а полный список со ссылками на каждый — в тексте
  // сообщения, он там и так кликабельный без всякой кнопки.
  const mainItem = validItems.length
    ? validItems.reduce((best, i) => (Number(i.price) || 0) > (Number(best.price) || 0) ? i : best)
    : null;
  const reviewLink = mainItem ? `${siteUrl}/product/${mainItem.id}#reviews` : `${siteUrl}/reviews`;
  const productName = mainItem ? (mainItem.name || null) : null;
  // Одобренный в Meta шаблон (см. WhatsApp Manager) — одна переменная в тексте; Meta
  // одобряет структуру шаблона (сколько переменных и где), а не их содержимое, поэтому
  // в неё можно положить не только одну ссылку, а список всех товаров заказа. Переносы
  // строк Meta не пропускает в параметрах (ошибка 132018) — tplSafe() сама склеит через
  // " | ", так что это уже учтено.
  const bodyText = validItems.length
    ? validItems.map(i => `${i.name || 'товар'} — ${siteUrl}/product/${i.id}#reviews`).join('\n')
    : reviewLink;
  // Отдельно у шаблона есть кнопка "Посетить сайт" с динамическим URL — статическая
  // часть "https://b2btech.kz/" уже зашита в самом шаблоне, сюда шлём только "хвост"
  // (то, что после неё), иначе ссылка в кнопке задвоится.
  const buttonSuffix = reviewLink.startsWith(siteUrl + '/') ? reviewLink.slice(siteUrl.length + 1) : reviewLink;
  // Номера для "по всем вопросам звоните" — те же контакты, что в настройках сайта
  // (админка → Настройки → Контакты), а не вшиты в текст шаблона: поменяется номер —
  // поменяется само это значение, шаблон в Meta на повторную проверку отправлять не придётся.
  let contactsPhones = '';
  try {
    const row = await db.getAsync(`SELECT value FROM settings WHERE key = 'contacts'`);
    const contacts = row ? JSON.parse(row.value) : {};
    contactsPhones = [contacts.phone1, contacts.phone2].filter(Boolean).join(', ');
  } catch (e) {}
  await sendWhatsAppTemplate(order.phone, 'review_request', 'ru',
    [tplSafe(bodyText), tplSafe(contactsPhones || siteUrl)], tplSafe(buttonSuffix));
  // Возвращаем, что реально ушло — чтобы вызывающий код (см. runReviewRequestsIfDue
  // в server.js) мог записать это в журнал действий, не пересчитывая ссылку заново.
  return { phone: order.phone, link: reviewLink, productName };
}

module.exports = { notifyOrder, sendReviewRequest, sendEmailCode, sendWhatsAppTo, hasWhatsApp, logFail };
