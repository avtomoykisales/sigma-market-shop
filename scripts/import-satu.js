/* ============================================================
   Импорт каталога из Satu.kz-экспорта.
   1) node scripts/extract-satu.py  (создаёт /tmp/satu-import.json)
   2) node scripts/import-satu.js
   ЗАМЕНЯЕТ все товары / категории / подкатегории.
   Скачивает картинки товаров и категорий в public/icons/.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const db = require('../database');

const DATA = JSON.parse(fs.readFileSync('/tmp/satu-import.json', 'utf8'));
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function slugify(s, max = 48) {
  let out = String(s || '').toLowerCase().trim()
    .replace(/[а-яё]/g, c => RU[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return out || 'x';
}
const CAT_SLUG = {
  'Оборудование для автомойки': 'avtomojka',
  'Оборудование для СТО и автосервиса': 'sto',
  'Оборудование для клининга': 'klining',
};

const usedIcon = new Set(fs.readdirSync(ICONS_DIR));
function iconName(url) {
  let base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'img.jpg');
  base = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '');
  if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) base += '.jpg';
  let name = base, n = 1;
  while (usedIcon.has(name)) name = base.replace(/(\.[^.]+)$/, `-${n++}$1`);
  usedIcon.add(name);
  return name;
}

let dlOk = 0, dlFail = 0;
async function download(url) {
  const name = iconName(url);
  const dest = path.join(ICONS_DIR, name);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) throw new Error('not image: ' + ct);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) throw new Error('too small');
    fs.writeFileSync(dest, buf);
    dlOk++;
    return name;
  } catch (e) {
    dlFail++;
    usedIcon.delete(name);
    return null;
  }
}
async function pool(items, worker, size = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }));
  return out;
}

(async () => {
  await new Promise(r => setTimeout(r, 2500)); // дать database.js домигрировать

  console.log('🗑  Очистка каталога…');
  await db.runAsync('DELETE FROM products');
  await db.runAsync('DELETE FROM subcategories');
  await db.runAsync('DELETE FROM categories');
  await db.runAsync("DELETE FROM sqlite_sequence WHERE name IN ('products','subcategories','categories')");

  // ---- КАТЕГОРИИ ----
  console.log('📂 Категории…');
  const catId = {};            // num -> id
  const catSlugUsed = new Set();
  for (const c of DATA.categories) {
    let icon = null;
    if (c.image) icon = await download(c.image);
    let slug = CAT_SLUG[c.name] || slugify(c.name);
    while (catSlugUsed.has(slug)) slug += '-x';
    catSlugUsed.add(slug);
    const r = await db.runAsync(
      'INSERT INTO categories (name, slug, description, icon) VALUES (?,?,?,?)',
      [c.name, slug, '', icon]);
    catId[c.num] = r.lastID;
  }

  // ---- ПОДКАТЕГОРИИ ----
  console.log('🗂  Подкатегории…');
  const subId = {};
  const subSlugPerCat = {};
  let ord = 0;
  for (const s of DATA.subcategories) {
    const cid = catId[s.category_num];
    if (!cid) continue;
    let slug = slugify(s.name);
    subSlugPerCat[cid] = subSlugPerCat[cid] || new Set();
    while (subSlugPerCat[cid].has(slug)) slug += '-x';
    subSlugPerCat[cid].add(slug);
    const r = await db.runAsync(
      'INSERT INTO subcategories (category_id, name, slug, description, sort) VALUES (?,?,?,?,?)',
      [cid, s.name, slug, '', ord++]);
    subId[s.num] = r.lastID;
  }

  // ---- КАРТИНКИ ТОВАРОВ ----
  console.log(`🖼  Скачивание картинок (${DATA.products.reduce((n, p) => n + p.image_urls.length, 0)} шт.)…`);
  const allImgJobs = [];
  DATA.products.forEach(p => p.image_urls.forEach(url => allImgJobs.push({ p, url })));
  const results = await pool(allImgJobs, j => download(j.url), 10);
  const fileByUrl = new Map();
  allImgJobs.forEach((j, i) => { if (results[i]) fileByUrl.set(j.url, results[i]); });
  console.log(`   ок: ${dlOk}, не удалось: ${dlFail}`);

  // ---- ТОВАРЫ ----
  console.log('📦 Товары…');
  let n = 0;
  for (const p of DATA.products) {
    const files = p.image_urls.map(u => fileByUrl.get(u)).filter(Boolean);
    const cid = catId[p.category_num] || Object.values(catId)[0];
    const sid = p.subcategory_num ? (subId[p.subcategory_num] || null) : null;
    const perfSpec = p.specs['Поток воздуха'] || p.specs['Производительность'] || '';
    const perf = (String(perfSpec).match(/\d+/) || [])[0] || null;
    await db.runAsync(
      `INSERT INTO products
        (category_id, subcategory_id, name, article, brand, description, price, price_on_request,
         unit, icon, in_stock, featured, specs, subtype, perf, perf_unit, related_ids, bundle_ids, images, youtube, subtitle)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, sid, p.name, p.article, p.brand, p.description || '', p.price, p.price_on_request,
       p.unit || 'шт', files[0] || null, p.in_stock, 0, JSON.stringify(p.specs || {}),
       p.specs['Тип'] || null, perf, 'ед./час', '[]', '[]',
       JSON.stringify(files.slice(1)), null, null]);
    n++;
  }

  const cnt = await db.getAsync('SELECT (SELECT COUNT(*) FROM categories) c, (SELECT COUNT(*) FROM subcategories) s, (SELECT COUNT(*) FROM products) p');
  console.log(`\n✅ Готово: ${cnt.c} категорий, ${cnt.s} подкатегорий, ${cnt.p} товаров. Картинок: ${dlOk}.`);
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
