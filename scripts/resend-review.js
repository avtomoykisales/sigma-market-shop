// Повторная отправка просьбы оставить отзыв по одному заказу — вручную, раз.
// Запуск на сервере, из папки проекта:
//   node scripts/resend-review.js 32
// Токены (META_WA_TOKEN и т.д.) берём прямо из deploy/ecosystem.config.js — там же,
// откуда их берёт pm2 для самого сервера — отдельно их где-то прописывать не нужно.
Object.assign(process.env, require('../deploy/ecosystem.config.js').apps[0].env);
const db = require('../database');
const notify = require('../notify');

const orderId = Number(process.argv[2]);
if (!orderId) {
  console.error('Укажите номер заказа: node scripts/resend-review.js 32');
  process.exit(1);
}

(async () => {
  const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    console.error('Заказ №' + orderId + ' не найден');
    process.exit(1);
  }

  const sent = await notify.sendReviewRequest(order);
  await db.runAsync(`UPDATE orders SET review_requested_at = datetime('now') WHERE id = ?`, [orderId]);

  const productLabel = sent && sent.productName ? `${sent.productName} — ` : '';
  await db.runAsync(
    `INSERT INTO admin_log (admin, action, label, detail, order_id) VALUES (?,?,?,?,?)`,
    ['система', 'notify', `Отзыв: запрос отправлен повторно — ${order.name || ''} (${order.phone})`,
     `WhatsApp review_request: ${productLabel}${sent && sent.link}`, orderId]
  );

  console.log('Готово: отзыв по заказу №' + orderId + ' отправлен на ' + order.phone);
  process.exit(0);
})().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
