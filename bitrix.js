/* ============================================================
   Отправка заявок с сайта в Bitrix24 (CRM: Лид).
   Адрес входящего вебхука хранится в settings.crm.bitrix_webhook
   (задаётся в админке → Вовлечённость). Пусто → интеграция выключена.
   ============================================================ */

// Node 18+ имеет глобальный fetch; на всякий случай — фолбэк через https.
async function post(url, body) {
  if (typeof fetch === 'function') {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: r.ok, status: r.status, json };
  }
  const https = require('https');
  const { URL } = require('url');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = { raw: buf }; }
        resolve({ ok: res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function base(webhook) {
  return String(webhook || '').trim().replace(/\/?$/, '/');   // гарантируем хвостовой /
}

function leadFields(p) {
  const items = (() => {
    try {
      const arr = typeof p.items === 'string' ? JSON.parse(p.items) : (p.items || []);
      if (!Array.isArray(arr) || !arr.length) return '';
      return '\n\nТовары:\n' + arr.map(i =>
        `• ${i.name || i.title || 'товар'} — ${i.qty || 1} шт` +
        (i.price ? ` × ${Number(i.price).toLocaleString('ru-KZ')} ₸` : '')).join('\n');
    } catch { return ''; }
  })();
  const comments = [
    p.message || '',
    p.city ? `Город: ${p.city}` : '',
    items,
    p.total ? `\nИтого: ${Number(p.total).toLocaleString('ru-KZ')} ₸` : '',
    p.pageUrl ? `\nСтраница: ${p.pageUrl}` : '',
  ].filter(Boolean).join('\n');

  const f = {
    TITLE: `Заявка с сайта${p.name ? ' — ' + p.name : ''}`,
    NAME: p.name || '',
    SOURCE_ID: 'WEB',
    SOURCE_DESCRIPTION: 'b2btech.kz',
    COMMENTS: comments,
    PHONE: p.phone ? [{ VALUE: String(p.phone), VALUE_TYPE: 'WORK' }] : undefined,
    EMAIL: p.email ? [{ VALUE: String(p.email), VALUE_TYPE: 'WORK' }] : undefined,
  };
  if (p.total) { f.OPPORTUNITY = p.total; f.CURRENCY_ID = 'KZT'; }
  Object.keys(f).forEach(k => f[k] === undefined && delete f[k]);
  return f;
}

// payload: { name, phone, email, city, message, items, total, pageUrl }
async function sendLead(webhook, payload) {
  const url = base(webhook) + 'crm.lead.add.json';
  const res = await post(url, { fields: leadFields(payload), params: { REGISTER_SONET_EVENT: 'Y' } });
  if (!res.ok || (res.json && res.json.error)) {
    throw new Error(res.json && (res.json.error_description || res.json.error) || ('HTTP ' + res.status));
  }
  return res.json && res.json.result;   // id созданного лида
}

module.exports = { sendLead };
