/* ============================================================
   Общие запросы к БД для каталога/товаров — используются и в
   /api/categories, /api/products (для клиента), и при сборке
   HTML на сервере (seo.js), чтобы не запрашивать одни и те же
   данные дважды и не дублировать логику фильтров/фасетов.
   ============================================================ */
const db = require('./database');

async function queryCategories() {
  return db.allAsync(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
     FROM categories c ORDER BY c.id`);
}

async function queryProducts(q) {
  const { category, subcategory, search, featured, page = 1, limit = 24,
          brand, subtype, priceMin, priceMax, perfMin, perfMax, sort, facets } = q || {};
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  if (category && category !== 'all') { where.push('c.slug = ?'); params.push(category); }
  let subcategoryNotFound = false;
  if (subcategory) {
    const subs = subcategory.split(',').filter(Boolean);
    const idRows = subs.length ? await db.allAsync(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM subcategories WHERE slug IN (${subs.map(() => '?').join(',')})
         UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
       ) SELECT id FROM tree`, subs) : [];
    const ids = idRows.map(r => r.id);
    if (ids.length) { where.push('p.subcategory_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
    else {
      where.push('1=0');
      if (subs.length === 1) subcategoryNotFound = true;
    }
  }
  if (search) {
    const cap = search.charAt(0).toUpperCase() + search.slice(1);
    const low = search.charAt(0).toLowerCase() + search.slice(1);
    where.push('(p.name LIKE ? OR p.name LIKE ? OR p.name LIKE ? OR p.article LIKE ? OR p.brand LIKE ? OR p.brand LIKE ?)');
    params.push(`%${search}%`, `%${cap}%`, `%${low}%`, `%${search}%`, `%${search}%`, `%${cap}%`);
  }
  if (featured === '1') where.push('p.featured = 1');
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

  const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const orderMap = {
    price_asc: 'p.price ASC', price_desc: 'p.price DESC',
    name_asc: 'p.name ASC', default: 'p.featured DESC, p.id'
  };
  const orderStr = orderMap[sort] || orderMap.default;

  const fromJoin = `FROM products p
     JOIN categories c ON p.category_id = c.id
     LEFT JOIN subcategories sc ON p.subcategory_id = sc.id`;

  const countRow = await db.getAsync(`SELECT COUNT(*) as cnt ${fromJoin} ${whereStr}`, params);
  const total = countRow.cnt;

  const rows = await db.allAsync(
    `SELECT p.*, c.name as category_name, c.slug as category_slug,
            sc.name as subcategory_name, sc.slug as subcategory_slug
     ${fromJoin}
     ${whereStr} ORDER BY ${orderStr} LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]);

  let facetsData = null;
  if (facets === '1') {
    const catWhere = category && category !== 'all' ? 'AND c.slug = ?' : '';
    const fParams = category && category !== 'all' ? [category] : [];
    const brands = await db.allAsync(
      `SELECT DISTINCT p.brand FROM products p JOIN categories c ON p.category_id=c.id
       WHERE p.brand != '' ${catWhere} ORDER BY p.brand`, fParams);
    const noBrand = await db.getAsync(
      `SELECT COUNT(*) as cnt FROM products p JOIN categories c ON p.category_id=c.id
       WHERE (p.brand IS NULL OR p.brand = '') ${catWhere}`, fParams);
    const subtypes = await db.allAsync(
      `SELECT DISTINCT p.subtype FROM products p JOIN categories c ON p.category_id=c.id
       WHERE p.subtype IS NOT NULL AND p.subtype != '' ${catWhere} ORDER BY p.subtype`, fParams);
    const range = await db.getAsync(
      `SELECT MIN(NULLIF(p.price,0)) as pmin, MAX(p.price) as pmax,
              MIN(p.perf) as perfmin, MAX(p.perf) as perfmax
       FROM products p JOIN categories c ON p.category_id=c.id WHERE 1=1 ${catWhere}`, fParams);
    const subcatRows = await db.allAsync(
      `SELECT s.id, s.name, s.slug, s.icon, s.description, s.seo_title, s.seo_description, s.sort, s.parent_id,
              par.slug AS parent_slug,
              (SELECT COUNT(*) FROM products x WHERE x.subcategory_id = s.id) AS own_cnt
       FROM subcategories s
       JOIN categories c ON s.category_id = c.id
       LEFT JOIN subcategories par ON s.parent_id = par.id
       WHERE 1=1 ${catWhere}
       ORDER BY s.sort, s.name`, fParams);
    const _byId = new Map(subcatRows.map(r => [r.id, r]));
    subcatRows.forEach(r => { r.cnt = r.own_cnt; });
    subcatRows.forEach(r => {
      let pid = r.parent_id;
      while (pid && _byId.has(pid)) { _byId.get(pid).cnt += r.own_cnt; pid = _byId.get(pid).parent_id; }
    });
    const subcats = subcatRows.filter(r => r.cnt > 0).map(r => ({
      name: r.name, slug: r.slug, icon: r.icon, description: r.description,
      seo_title: r.seo_title, seo_description: r.seo_description,
      cnt: r.cnt, parent_slug: r.parent_slug, sort: r.sort,
    }));
    const brandList = brands.map(b => b.brand).filter(Boolean);
    if (noBrand.cnt > 0) brandList.push('__none__');
    facetsData = {
      brands: brandList,
      subtypes: subtypes.map(s => s.subtype).filter(Boolean),
      subcategories: subcats,
      priceMin: range.pmin || 0, priceMax: range.pmax || 0,
      perfMin: range.perfmin || 0, perfMax: range.perfmax || 0
    };
  }

  return { total, page: Number(page), limit: Number(limit), products: rows, facets: facetsData, subcategoryNotFound };
}

module.exports = { queryCategories, queryProducts };
