/* ============================================================
   Общие запросы к БД для каталога/товаров — используются и в
   /api/categories, /api/products (для клиента), и при сборке
   HTML на сервере (seo.js), чтобы не запрашивать одни и те же
   данные дважды и не дублировать логику фильтров/фасетов.
   ============================================================ */
const db = require('./database');

// Нормализация текста поиска: нижний регистр + без пробелов/дефисов — чтобы "одно дисковая"
// находило товар "Однодисковая машина" (и наоборот), независимо от того, слитно или раздельно
// слово написано у Миры в названии и у покупателя в запросе.
function normalizeSearch(s) {
  return String(s || '').toLowerCase().replace(/[\s\-]+/g, '');
}
// SQLite LIKE регистрозависим для кириллицы ("Бензин" не совпадёт с '%бензин%'), поэтому
// поиск матчим в JS через toLowerCase() (как и в квизе, см. server.js) — заодно так же, в
// JS, можно заглянуть и в specs (характеристики), и не зависеть от пробелов/дефисов.
function matchesSearch(p, searchNorm) {
  const fields = [p.name, p.article, p.brand, p.specs].filter(Boolean).join(' ');
  return normalizeSearch(fields).includes(searchNorm);
}

// Скидка — считается на лету из "настоящей" цены (products.price), а не хранится
// готовым числом, чтобы при изменении процента/цены/даты окончания не нужно было ничего
// пересчитывать задним числом. Два взаимоисключающих способа задать скидку в админке:
// discount_percent ("−N%") или discount_price (готовая конечная цена) — если указан
// процент, он в приоритете, цена со скидкой в этом случае игнорируется (так проще для
// админа: не нужно гадать, какое поле "главное", если оба вдруг заполнены).
// Мутирует и возвращает ту же строку: price подменяется на уценённую (её и видят
// корзина/заказ/карточка), old_price — прежняя цена для зачёркнутого показа,
// discount_percent_active — для бейджа "−N%", discount_mode — 'percent'/'price'/''
// (для выбора бейджа: процент → "−N%", готовая цена → "Выгодная цена").
function applyDiscount(row) {
  if (!row) return row;
  const pct = Math.round(Number(row.discount_percent) || 0);
  const fixedPrice = Number(row.discount_price) || 0;
  const until = row.discount_until;
  const today = new Date().toISOString().slice(0, 10);
  const base = Number(row.price) || 0;
  const eligible = !row.price_on_request && base > 0 && (!until || String(until) >= today);

  let newPrice = null;
  let mode = '';
  if (eligible && pct > 0 && pct < 100) {
    newPrice = Math.round(base * (1 - pct / 100));
    mode = 'percent';
  } else if (eligible && fixedPrice > 0 && fixedPrice < base) {
    newPrice = Math.round(fixedPrice);
    mode = 'price';
  }

  if (newPrice != null && newPrice < base) {
    row.old_price = base;
    row.price = newPrice;
    row.discount_mode = mode;
    row.discount_percent_active = mode === 'percent' ? pct : 0;
  } else {
    row.discount_mode = '';
    row.discount_percent_active = 0;
  }
  return row;
}

async function queryCategories() {
  return db.allAsync(
    `SELECT c.*, (SELECT COUNT(DISTINCT pid) FROM (
       SELECT id AS pid FROM products WHERE category_id = c.id AND published = 1
       UNION
       SELECT pec.product_id AS pid FROM product_extra_categories pec
       JOIN products xp ON xp.id = pec.product_id
       WHERE pec.category_id = c.id AND xp.published = 1
     )) AS product_count
     FROM categories c WHERE c.published = 1 ORDER BY c.id`);
}

// Путь для json_extract передаём параметром (не склеиваем в текст SQL) — так название
// характеристики может быть любым (кириллица, пробелы, в принципе и кавычки), без риска
// сломать запрос: это просто строковое значение аргумента, а не часть самого SQL.
const specPath = (key) => `$."${String(key).replace(/"/g, '')}"`;

// Тип фильтра для конкретной характеристики в конкретном наборе подкатегорий определяем
// по самим данным, а не храним отдельно для каждой характеристики: если абсолютно все
// встречающиеся значения начинаются с числа (CAST у SQLite сам отбрасывает текст после
// числа: "6800 кв. м/час" → 6800, а "Да"/"Сеть 220 В" — не начинаются с цифры и дают 0) —
// это диапазон "от-до", иначе — список значений (как у бренда). Возвращает null, если
// фильтровать там всё равно нечем (характеристика ни у кого не заполнена, либо у всех
// одно и то же значение).
async function specKeyFacet(key, subcatIds) {
  if (!subcatIds.length) return null;
  const path = specPath(key);
  const idsIn = subcatIds.map(() => '?').join(',');
  const stats = await db.getAsync(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN CAST(v AS REAL) > 0 THEN 1 ELSE 0 END) as numericCount,
            MIN(CAST(v AS REAL)) as minV, MAX(CAST(v AS REAL)) as maxV
     FROM (SELECT json_extract(p.specs, ?) as v FROM products p
           WHERE p.subcategory_id IN (${idsIn}) AND p.published = 1 AND json_valid(p.specs) AND json_extract(p.specs, ?) IS NOT NULL)`,
    [path, ...subcatIds, path]);
  if (!stats || !stats.total) return null;
  if (stats.numericCount === stats.total) {
    if (!(stats.maxV > stats.minV)) return null;   // одно и то же число у всех — диапазону нечего показать
    return { key, type: 'range', min: stats.minV, max: stats.maxV };
  }
  const valRows = await db.allAsync(
    `SELECT DISTINCT json_extract(p.specs, ?) as v FROM products p
     WHERE p.subcategory_id IN (${idsIn}) AND p.published = 1 AND json_valid(p.specs) AND json_extract(p.specs, ?) IS NOT NULL
     ORDER BY v`,
    [path, ...subcatIds, path]);
  const options = valRows.map(r => r.v).filter(Boolean);
  if (!options.length) return null;
  return { key, type: 'enum', options };
}

async function queryProducts(q) {
  const { category, subcategory, search, featured, page = 1, limit = 24,
          brand, subtype, priceMin, priceMax, perfMin, perfMax, sort, facets,
          specFilters } = q || {};
  const offset = (page - 1) * limit;

  // specFilters — JSON-строка с фильтрами по характеристикам, которые Мира включила
  // для соответствующих подкатегорий в админке (см. GET .../spec-keys и поле
  // subcategories.filter_specs): {"Тип питания":{"type":"enum","values":["Аккумулятор"]},
  // "Вес":{"type":"range","min":10,"max":50}}.
  let specFiltersObj = {};
  try { specFiltersObj = JSON.parse(specFilters || '{}'); } catch {}

  let where = ['p.published = 1'];
  let params = [];

  // Категория/подкатегория товара в products — каноническая (она же в URL и хлебных
  // крошках), но товар может быть ещё и в product_extra_categories — "тоже виден в этой
  // категории" без дублирования самой карточки. Везде ниже матчим primary ИЛИ extra.
  if (category && category !== 'all') {
    where.push(`(c.slug = ? OR p.id IN (
      SELECT pec.product_id FROM product_extra_categories pec
      JOIN categories ec ON pec.category_id = ec.id WHERE ec.slug = ?
    ))`);
    params.push(category, category);
  }
  let subcategoryNotFound = false;
  let subcategoryIds = [];   // переиспользуется ниже в facets
  if (subcategory) {
    const subs = subcategory.split(',').filter(Boolean);
    const idRows = subs.length ? await db.allAsync(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM subcategories WHERE slug IN (${subs.map(() => '?').join(',')})
         UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
       ) SELECT id FROM tree`, subs) : [];
    const ids = idRows.map(r => r.id);
    subcategoryIds = ids;
    if (ids.length) {
      const inList = ids.map(() => '?').join(',');
      where.push(`(p.subcategory_id IN (${inList}) OR p.id IN (
        SELECT product_id FROM product_extra_categories WHERE subcategory_id IN (${inList})
      ))`);
      params.push(...ids, ...ids);
    } else {
      where.push('1=0');
      if (subs.length === 1) subcategoryNotFound = true;
    }
  }
  const searchNorm = search ? normalizeSearch(search) : '';
  if (featured === '1') where.push("p.featured IS NOT NULL AND p.featured != '[]'");
  if (brand) {
    const bList = brand.split(',');
    const bReal = bList.filter(b => b !== '__none__');
    const bParts = [];
    if (bReal.length) { bParts.push('p.brand IN (' + bReal.map(() => '?').join(',') + ')'); params.push(...bReal); }
    if (bList.includes('__none__')) bParts.push("(p.brand IS NULL OR p.brand = '')");
    if (bParts.length) where.push('(' + bParts.join(' OR ') + ')');
  }
  if (subtype) { where.push('p.subtype IN (' + subtype.split(',').map(() => '?').join(',') + ')'); params.push(...subtype.split(',')); }
  if (priceMin) { where.push('p.price >= ?'); params.push(Number(priceMin)); }
  if (priceMax) { where.push('(p.price <= ? AND p.price > 0)'); params.push(Number(priceMax)); }
  if (perfMin)  { where.push('p.perf >= ?'); params.push(Number(perfMin)); }
  if (perfMax)  { where.push('p.perf <= ?'); params.push(Number(perfMax)); }
  for (const [key, f] of Object.entries(specFiltersObj)) {
    if (!f || typeof f !== 'object') continue;
    const path = specPath(key);
    if (f.type === 'range') {
      if (f.min !== undefined && f.min !== null && f.min !== '') {
        where.push(`CAST(json_extract(p.specs, ?) AS REAL) >= ?`); params.push(path, Number(f.min));
      }
      if (f.max !== undefined && f.max !== null && f.max !== '') {
        where.push(`CAST(json_extract(p.specs, ?) AS REAL) <= ?`); params.push(path, Number(f.max));
      }
    } else if (Array.isArray(f.values) && f.values.length) {
      where.push(`json_extract(p.specs, ?) IN (${f.values.map(() => '?').join(',')})`);
      params.push(path, ...f.values);
    }
  }

  const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const orderMap = {
    price_asc: 'p.price ASC', price_desc: 'p.price DESC',
    name_asc: 'p.name ASC', default: "(p.featured IS NOT NULL AND p.featured != '[]') DESC, p.sort_order ASC, p.id DESC"
  };
  const orderStr = orderMap[sort] || orderMap.default;

  const fromJoin = `FROM products p
     JOIN categories c ON p.category_id = c.id
     LEFT JOIN subcategories sc ON p.subcategory_id = sc.id`;

  let total, rows;
  if (searchNorm) {
    // С поиском нельзя фильтровать и постранично резать в самом SQL (см. matchesSearch
    // выше) — забираем все строки, подходящие по остальным фильтрам, без LIMIT, матчим в
    // JS и уже потом режем на страницу сами.
    const allRows = await db.allAsync(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              sc.name as subcategory_name, sc.slug as subcategory_slug
       ${fromJoin}
       ${whereStr} ORDER BY ${orderStr}`,
      params);
    const filtered = allRows.filter(p => matchesSearch(p, searchNorm));
    total = filtered.length;
    rows = filtered.slice(offset, offset + Number(limit));
  } else {
    const countRow = await db.getAsync(`SELECT COUNT(*) as cnt ${fromJoin} ${whereStr}`, params);
    total = countRow.cnt;
    rows = await db.allAsync(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              sc.name as subcategory_name, sc.slug as subcategory_slug
       ${fromJoin}
       ${whereStr} ORDER BY ${orderStr} LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]);
  }
  rows.forEach(applyDiscount);

  let facetsData = null;
  if (facets === '1') {
    const catWhere = category && category !== 'all'
      ? `AND (c.slug = ? OR p.id IN (
          SELECT pec.product_id FROM product_extra_categories pec
          JOIN categories ec ON pec.category_id = ec.id WHERE ec.slug = ?
        ))`
      : '';
    const fParams = category && category !== 'all' ? [category, category] : [];
    // Когда выбрана конкретная подкатегория (не просто "Все" внутри раздела) — фасеты
    // (бренды, тип, диапазон цены/производительности) должны считаться по товарам именно
    // этой подкатегории, а не всего раздела целиком. Без этого в списке брендов попадали
    // бренды из СОСЕДНИХ подкатегорий того же раздела (например, Elsea есть только среди
    // АВД, а не поломоечных машин) — чекбокс показывался, а при выборе давал 0 товаров.
    const subWhere = subcategoryIds.length
      ? `AND (p.subcategory_id IN (${subcategoryIds.map(() => '?').join(',')}) OR p.id IN (
          SELECT product_id FROM product_extra_categories WHERE subcategory_id IN (${subcategoryIds.map(() => '?').join(',')})
        ))`
      : '';
    const subParams = subcategoryIds.length ? [...subcategoryIds, ...subcategoryIds] : [];
    const facetWhere = catWhere + subWhere;
    const facetParams = [...fParams, ...subParams];
    const brands = await db.allAsync(
      `SELECT DISTINCT p.brand FROM products p JOIN categories c ON p.category_id=c.id
       WHERE p.published = 1 AND p.brand != '' ${facetWhere} ORDER BY p.brand`, facetParams);
    const noBrand = await db.getAsync(
      `SELECT COUNT(*) as cnt FROM products p JOIN categories c ON p.category_id=c.id
       WHERE p.published = 1 AND (p.brand IS NULL OR p.brand = '') ${facetWhere}`, facetParams);
    const subtypes = await db.allAsync(
      `SELECT DISTINCT p.subtype FROM products p JOIN categories c ON p.category_id=c.id
       WHERE p.published = 1 AND p.subtype IS NOT NULL AND p.subtype != '' ${facetWhere} ORDER BY p.subtype`, facetParams);
    const range = await db.getAsync(
      `SELECT MIN(NULLIF(p.price,0)) as pmin, MAX(p.price) as pmax,
              MIN(p.perf) as perfmin, MAX(p.perf) as perfmax
       FROM products p JOIN categories c ON p.category_id=c.id WHERE p.published = 1 ${facetWhere}`, facetParams);
    // Здесь c.slug — категория самой подкатегории (к какому разделу она относится), а не
    // товаров — product_extra_categories тут ни при чём, поэтому своя простая проверка.
    const subcatCatWhere = category && category !== 'all' ? 'AND c.slug = ?' : '';
    const subcatFParams = category && category !== 'all' ? [category] : [];
    const subcatRows = await db.allAsync(
      `SELECT s.id, s.name, s.slug, s.icon, s.description, s.seo_title, s.seo_description, s.faq, s.sort, s.parent_id,
              s.filter_specs, s.gallery,
              par.slug AS parent_slug,
              (SELECT COUNT(DISTINCT pid) FROM (
                 SELECT id AS pid FROM products x WHERE x.subcategory_id = s.id AND x.published = 1
                 UNION
                 SELECT pec.product_id AS pid FROM product_extra_categories pec
                 JOIN products xp ON xp.id = pec.product_id
                 WHERE pec.subcategory_id = s.id AND xp.published = 1
               )) AS own_cnt
       FROM subcategories s
       JOIN categories c ON s.category_id = c.id
       LEFT JOIN subcategories par ON s.parent_id = par.id
       WHERE 1=1 ${subcatCatWhere}
       ORDER BY s.sort, s.name`, subcatFParams);
    const _byId = new Map(subcatRows.map(r => [r.id, r]));
    subcatRows.forEach(r => { r.cnt = r.own_cnt; });
    subcatRows.forEach(r => {
      let pid = r.parent_id;
      while (pid && _byId.has(pid)) { _byId.get(pid).cnt += r.own_cnt; pid = _byId.get(pid).parent_id; }
    });
    const subcats = subcatRows.filter(r => r.cnt > 0).map(r => ({
      name: r.name, slug: r.slug, icon: r.icon, description: r.description,
      seo_title: r.seo_title, seo_description: r.seo_description, faq: r.faq,
      cnt: r.cnt, parent_slug: r.parent_slug, sort: r.sort, gallery: r.gallery,
    }));
    const brandList = brands.map(b => b.brand).filter(Boolean);
    if (noBrand.cnt > 0) brandList.push('__none__');

    // Универсальные фильтры по характеристикам показываем только когда выбрана конкретная
    // подкатегория (или группа подкатегорий) — Мира явно попросила не поднимать их на
    // уровень "Все", где они относятся не ко всем товарам сразу (например "Производительность
    // по площади" есть только у поломоечных машин, а не у подметальных/пылесосов) — на "Все"
    // такой фильтр вводит в заблуждение, будто бы он применим ко всем товарам раздела.
    const scopeRows = subcategoryIds.length
      ? subcatRows.filter(r => subcategoryIds.includes(r.id))
      : [];
    const keyToIds = new Map();
    for (const row of scopeRows) {
      let keys = [];
      try { keys = JSON.parse(row.filter_specs || '[]'); } catch {}
      for (const k of keys) {
        if (!keyToIds.has(k)) keyToIds.set(k, []);
        keyToIds.get(k).push(row.id);
      }
    }
    const specFacets = [];
    for (const [key, ids] of keyToIds.entries()) {
      const f = await specKeyFacet(key, ids);
      if (f) specFacets.push(f);
    }

    facetsData = {
      brands: brandList,
      subtypes: subtypes.map(s => s.subtype).filter(Boolean),
      subcategories: subcats,
      priceMin: range.pmin || 0, priceMax: range.pmax || 0,
      perfMin: range.perfmin || 0, perfMax: range.perfmax || 0,
      specFacets,
    };
  }

  return { total, page: Number(page), limit: Number(limit), products: rows, facets: facetsData, subcategoryNotFound };
}

module.exports = { queryCategories, queryProducts, applyDiscount, normalizeSearch, matchesSearch };
