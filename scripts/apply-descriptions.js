// Заливает новые SEO-описания товаров (scripts/new-descriptions.json) на живой сайт
// через тот же admin API, что использует сама админка — с журналированием изменений.
// Не трогает локальную/боевую базу напрямую.
//
// Запуск (в терминале, токен нигде не сохраняется в файлах):
//   ADMIN_TOKEN='логин:пароль' node scripts/apply-descriptions.js
// По умолчанию бьёт в https://b2btech.kz — можно переопределить SITE_URL.

const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_URL || 'https://b2btech.kz';
const TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) {
  console.error('Укажите токен: ADMIN_TOKEN=\'логин:пароль\' node scripts/apply-descriptions.js');
  process.exit(1);
}

const descriptions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'new-descriptions.json'), 'utf8')
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ids = Object.keys(descriptions);
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      const res = await fetch(`${SITE}/api/admin/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ description: descriptions[id] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) { ok++; }
      else { fail++; console.error(`  #${id}: ${data.error || res.status}`); }
    } catch (e) {
      fail++; console.error(`  #${id}: ${e.message}`);
    }
    if (ok % 20 === 0) console.log(`...${ok}/${ids.length}`);
    await sleep(150); // не долбим сервер слишком часто
  }
  console.log(`Готово: обновлено ${ok}, ошибок ${fail} из ${ids.length}`);
})();
