/* ============================================================
   Заполняет «Описание» категорий и подкатегорий текстами из
   deploy/seed/category-descriptions.json (сгенерирован из экспорта
   Satu.kz скриптом scripts/build-descriptions.py).

   Сопоставление — по точному названию.
   По умолчанию пишет ТОЛЬКО в пустое поле description
   (ручные правки в админке не затираются).

   Запуск на сервере:
     node scripts/import-descriptions.js          # только пустые
     node scripts/import-descriptions.js --force   # перезаписать все совпадения
   затем:  sudo pm2 restart sigma-shop
   ============================================================ */
const fs = require('fs');
const path = require('path');
const db = require('../database');

const FORCE = process.argv.includes('--force');
const SEED = path.join(__dirname, '..', 'deploy', 'seed', 'category-descriptions.json');

(async () => {
  await new Promise(r => setTimeout(r, 2500)); // дать database.js домигрировать

  if (!fs.existsSync(SEED)) { console.error('❌ Нет файла', SEED); process.exit(1); }
  const map = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const names = Object.keys(map);
  console.log(`📄 В сиде ${names.length} описаний. Режим: ${FORCE ? 'перезапись всех' : 'только пустые'}\n`);

  let done = 0, skip = 0, miss = 0;
  for (const [table, label] of [['categories', 'категория'], ['subcategories', 'подкатегория']]) {
    for (const name of names) {
      const row = await db.getAsync(`SELECT id, description FROM ${table} WHERE name = ?`, [name]);
      if (!row) continue;
      const empty = !row.description || !String(row.description).trim();
      if (!FORCE && !empty) { skip++; console.log(`  = ${label}: «${name}» — уже заполнено, пропуск`); continue; }
      await db.runAsync(`UPDATE ${table} SET description = ? WHERE id = ?`, [map[name], row.id]);
      done++;
      console.log(`  ✔ ${label}: «${name}» ← ${map[name].replace(/<[^>]+>/g, '').length} симв.`);
    }
  }
  // чего не нашлось в БД
  for (const name of names) {
    const inCat = await db.getAsync('SELECT 1 FROM categories WHERE name = ?', [name]);
    const inSub = await db.getAsync('SELECT 1 FROM subcategories WHERE name = ?', [name]);
    if (!inCat && !inSub) { miss++; console.log(`  ? нет в БД: «${name}»`); }
  }

  console.log(`\n✅ Обновлено: ${done}. Пропущено (заполнено): ${skip}. Нет в БД: ${miss}.`);
  console.log('   Не забудьте: sudo pm2 restart sigma-shop');
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
