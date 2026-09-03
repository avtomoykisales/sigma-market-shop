const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const db = require('./database');
const seo = require('./seo');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== HTML PAGES + PARTIALS ====================
// Renders any *.html page (and "/" -> index, "/about" -> about.html),
// replacing <!-- partial:name --> markers with public/partials/name.html
const partialCache = new Map();
function getPartial(name) {
  if (process.env.NODE_ENV !== 'production' || !partialCache.has(name)) {
    const file = path.join(PARTIALS_DIR, name + '.html');
    partialCache.set(name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  }
  return partialCache.get(name);
}
function renderPage(html) {
  return html.replace(/<!--\s*partial:([\w-]+)\s*-->/g, (m, name) => getPartial(name) || m);
}
// robots.txt + sitemap.xml (динамические, из БД)
app.get('/robots.txt', async (req, res) => {
  try { res.type('text/plain').send(await seo.robots(req)); }
  catch (e) { res.status(500).type('text/plain').send('User-agent: *\nDisallow:\n'); }
});
app.get('/sitemap.xml', async (req, res) => {
  try { res.type('application/xml').send(await seo.sitemap(req)); }
  catch (e) { res.status(500).type('text/plain').send('sitemap error'); }
});

app.get(/.*/, async (req, res, next) => {
  if (req.method !== 'GET') return next();
  let rel = decodeURIComponent(req.path);
  if (rel === '/') rel = '/index.html';
  else if (!path.extname(rel)) rel += '.html';
  if (!rel.endsWith('.html') || rel.includes('/partials/')) return next();
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full)) return next();
  let html = renderPage(fs.readFileSync(full, 'utf8'));
  if (rel !== '/admin.html') {
    try { html = seo.inject(html, await seo.build(req, rel)); }
    catch (e) { console.error('SEO inject failed:', e.message); }
  }
  res.type('html').send(html);
});

app.use(express.static(PUBLIC_DIR));

// File upload for icons
const ICONS_DIR = path.join(__dirname, 'public/icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ICONS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
    let stem = path.basename(file.originalname || '', ext).replace(/[^a-zA-Z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '');
    if (!stem) stem = 'img-' + Date.now().toString(36);   // нелатинское/пустое имя → генерим
    let name = stem + ext, n = 1;
    while (fs.existsSync(path.join(ICONS_DIR, name))) name = `${stem}-${n++}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

// ==================== CATEGORIES ====================
app.get('/api/categories', async (req, res) => {
  try {
    const cats = await db.allAsync(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c ORDER BY c.id`);
    res.json(cats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== SETTINGS (public) ====================
async function getSettings() {
  const rows = await db.allAsync('SELECT key, value FROM settings');
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); }
    catch { out[r.key] = r.value === 'true' ? true : r.value === 'false' ? false : r.value; }
  }
  return out;
}
app.get('/api/settings', async (req, res) => {
  try {
    const s = await getSettings();
    res.json({
      blocks: s.blocks || {}, filters: s.filters || {},
      compare: s.compare !== false, favorites: s.favorites !== false,
      quiz: s.quiz || {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== SUBCATEGORIES (public) ====================
app.get('/api/subcategories', async (req, res) => {
  try {
    let sql = `SELECT s.*, c.slug as category_slug,
                 (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) as product_count
               FROM subcategories s JOIN categories c ON s.category_id = c.id`;
    const params = [];
    if (req.query.category && req.query.category !== 'all') { sql += ' WHERE c.slug = ?'; params.push(req.query.category); }
    sql += ' ORDER BY s.sort, s.name';
    res.json(await db.allAsync(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== PRODUCTS ====================
app.get('/api/products', async (req, res) => {
  try {
    const { category, subcategory, search, featured, page = 1, limit = 24,
            brand, subtype, priceMin, priceMax, perfMin, perfMax, sort } = req.query;
    const offset = (page - 1) * limit;

    let where = [];
    let params = [];

    if (category && category !== 'all') { where.push('c.slug = ?'); params.push(category); }
    if (subcategory) {
      const subs = subcategory.split(',').filter(Boolean);
      where.push('sc.slug IN (' + subs.map(() => '?').join(',') + ')');
      params.push(...subs);
    }
    if (search) {
      // SQLite LIKE не регистронезависим для кириллицы — добавляем вариант с заглавной буквы
      const cap = search.charAt(0).toUpperCase() + search.slice(1);
      const low = search.charAt(0).toLowerCase() + search.slice(1);
      where.push('(p.name LIKE ? OR p.name LIKE ? OR p.name LIKE ? OR p.article LIKE ? OR p.brand LIKE ? OR p.brand LIKE ?)');
      params.push(`%${search}%`, `%${cap}%`, `%${low}%`, `%${search}%`, `%${search}%`, `%${cap}%`);
    }
    if (featured === '1') where.push('p.featured = 1');
    if (brand)   { where.push('p.brand IN (' + brand.split(',').map(() => '?').join(',') + ')'); params.push(...brand.split(',')); }
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

    // Фасеты (по категории, без учёта прочих фильтров) — для панели фильтров
    let facets = null;
    if (req.query.facets === '1') {
      const catWhere = category && category !== 'all' ? 'AND c.slug = ?' : '';
      const fParams = category && category !== 'all' ? [category] : [];
      const brands = await db.allAsync(
        `SELECT DISTINCT p.brand FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.brand != '' ${catWhere} ORDER BY p.brand`, fParams);
      const subtypes = await db.allAsync(
        `SELECT DISTINCT p.subtype FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.subtype IS NOT NULL AND p.subtype != '' ${catWhere} ORDER BY p.subtype`, fParams);
      const range = await db.getAsync(
        `SELECT MIN(NULLIF(p.price,0)) as pmin, MAX(p.price) as pmax,
                MIN(p.perf) as perfmin, MAX(p.perf) as perfmax
         FROM products p JOIN categories c ON p.category_id=c.id WHERE 1=1 ${catWhere}`, fParams);
      const subcats = await db.allAsync(
        `SELECT s.name, s.slug, s.icon, COUNT(p.id) as cnt
         FROM subcategories s
         JOIN categories c ON s.category_id = c.id
         LEFT JOIN products p ON p.subcategory_id = s.id
         WHERE 1=1 ${catWhere}
         GROUP BY s.id HAVING cnt > 0 ORDER BY s.sort, s.name`, fParams);
      facets = {
        brands: brands.map(b => b.brand).filter(Boolean),
        subtypes: subtypes.map(s => s.subtype).filter(Boolean),
        subcategories: subcats,
        priceMin: range.pmin || 0, priceMax: range.pmax || 0,
        perfMin: range.perfmin || 0, perfMax: range.perfmax || 0
      };
    }

    res.json({ total, page: Number(page), limit: Number(limit), products: rows, facets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Подбор оборудования (квиз)
app.post('/api/products/quiz', async (req, res) => {
  try {
    const { biz, load, budget } = req.body || {};
    const s = await getSettings();
    const quiz = s.quiz || db.DEFAULT_QUIZ || {};
    const opt = (stepKey, id) => {
      const step = (quiz.steps || []).find(st => st.key === stepKey);
      return step && (step.options || []).find(o => o.id === id);
    };
    const bizO = opt('biz', biz), loadO = opt('load', load), budgetO = opt('budget', budget);

    let where = ['p.price_on_request = 0'];
    let params = [];
    if (bizO && bizO.category) { where.push('c.slug = ?'); params.push(bizO.category); }
    const build = (extra) => {
      const w = where.concat(extra.w);
      return db.allAsync(
        `SELECT p.*, c.name as category_name, c.slug as category_slug
         FROM products p JOIN categories c ON p.category_id=c.id
         WHERE ${w.join(' AND ')} ORDER BY p.featured DESC, p.price DESC LIMIT 3`,
        params.concat(extra.p));
    };
    const perfW = [], perfP = [];
    if (loadO && loadO.perfMin) { perfW.push('(p.perf IS NULL OR p.perf >= ?)'); perfP.push(loadO.perfMin); }
    if (loadO && loadO.perfMax) { perfW.push('(p.perf IS NULL OR p.perf <= ?)'); perfP.push(loadO.perfMax); }
    const priceW = [], priceP = [];
    if (budgetO && budgetO.priceMin) { priceW.push('p.price >= ?'); priceP.push(budgetO.priceMin); }
    if (budgetO && budgetO.priceMax) { priceW.push('p.price <= ?'); priceP.push(budgetO.priceMax); }

    let products = await build({ w: [...perfW, ...priceW], p: [...perfP, ...priceP] });
    if (products.length < 2) products = await build({ w: priceW, p: priceP });   // ослабляем поток
    if (products.length < 2) products = await build({ w: [], p: [] });           // только категория
    res.json({ products, criteria: { biz: bizO, load: loadO, budget: budgetO } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await db.getAsync(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              sc.name as subcategory_name, sc.slug as subcategory_slug
       FROM products p JOIN categories c ON p.category_id = c.id
       LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
       WHERE p.id = ?`,
      [req.params.id]
    );

    if (!product) return res.status(404).json({ error: 'Товар не найден' });
    if (product.specs) { try { product.specs = JSON.parse(product.specs); } catch {} }

    // Галерея: главное изображение (icon) + дополнительные (images), без дублей
    let extra = [];
    try { extra = JSON.parse(product.images || '[]'); } catch {}
    product.gallery = [...new Set([product.icon, ...extra].filter(Boolean))];

    const s = await getSettings();
    const blocks = s.blocks || {};
    const briefCols = `p.id, p.name, p.article, p.brand, p.price, p.price_on_request, p.icon,
                       p.subtype, p.perf, p.perf_unit, c.slug as category_slug`;
    const byIds = async (raw) => {
      let ids = []; try { ids = JSON.parse(raw || '[]'); } catch {}
      ids = ids.filter(Boolean).slice(0, 8);
      if (!ids.length) return [];
      const rows = await db.allAsync(
        `SELECT ${briefCols} FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids);
      return ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
    };

    product.related = blocks.accessories !== false ? await byIds(product.related_ids) : [];
    product.bundle  = blocks.bundle      !== false ? await byIds(product.bundle_ids)  : [];
    product.similar = [];
    if (blocks.similar !== false) {
      const lo = product.price ? product.price * 0.55 : 0;
      const hi = product.price ? product.price * 1.8 : 0;
      product.similar = await db.allAsync(
        `SELECT ${briefCols} FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.category_id = ? AND p.id != ?
           ${product.price ? 'AND ((p.price BETWEEN ? AND ?) OR p.price_on_request=1)' : ''}
         ORDER BY p.featured DESC, ABS(COALESCE(p.perf,0) - ?) ASC, p.id LIMIT 4`,
        product.price ? [product.category_id, product.id, lo, hi, product.perf || 0]
                      : [product.category_id, product.id, product.perf || 0]);
    }
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ORDERS ====================
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, email, city, message, items } = req.body;
    if (!name || !phone || !items) {
      return res.status(400).json({ error: 'Заполните обязательные поля' });
    }

    let itemsStr = typeof items === 'string' ? items : JSON.stringify(items);
    let total = 0;
    try {
      const parsed = JSON.parse(itemsStr);
      total = parsed.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    } catch {}

    const result = await db.runAsync(
      `INSERT INTO orders (name, phone, email, city, message, items, total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, phone, email || '', city || '', message || '', itemsStr, total]
    );

    res.json({ success: true, orderId: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN AUTH ====================
async function adminAuth(req, res, next) {
  try {
    const auth = req.headers['x-admin-token'];
    const admin = await db.getAsync('SELECT * FROM admins WHERE username = ?', ['admin']);
    if (!admin || auth !== `${admin.username}:${admin.password}`) {
      return res.status(401).json({ error: 'Нет доступа' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await db.getAsync(
      'SELECT * FROM admins WHERE username = ? AND password = ?',
      [username, password]
    );
    if (!admin) return res.status(401).json({ error: 'Неверный логин или пароль' });
    res.json({ token: `${admin.username}:${admin.password}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN PRODUCTS ====================
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const offset = (page - 1) * limit;
    let where = '';
    let params = [];
    if (search) {
      where = 'WHERE p.name LIKE ? OR p.article LIKE ?';
      params = [`%${search}%`, `%${search}%`];
    }
    const countRow = await db.getAsync(`SELECT COUNT(*) as cnt FROM products p ${where}`, params);
    const rows = await db.allAsync(
      `SELECT p.*, c.name as category_name FROM products p
       JOIN categories c ON p.category_id=c.id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    res.json({ total: countRow.cnt, products: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const jsonArr = (v) => { try { return JSON.stringify(Array.isArray(v) ? v : JSON.parse(v || '[]')); } catch { return '[]'; } };

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const b = req.body;
    const result = await db.runAsync(
      `INSERT INTO products (category_id, name, article, brand, description, price, price_on_request, icon, in_stock, featured, specs,
                             subtype, perf, perf_unit, related_ids, bundle_ids, youtube, subtitle, images, subcategory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.category_id, b.name, b.article || '', b.brand || '', b.description || '', b.price || 0,
       b.price_on_request ? 1 : 0, b.icon || null, b.in_stock ? 1 : 0, b.featured ? 1 : 0, b.specs || '{}',
       b.subtype || null, b.perf || null, b.perf_unit || 'ед./час', jsonArr(b.related_ids), jsonArr(b.bundle_ids),
       b.youtube || null, b.subtitle || null, jsonArr(b.images), b.subcategory_id || null]
    );
    res.json({ success: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body;
    await db.runAsync(
      `UPDATE products SET category_id=?, name=?, article=?, brand=?, description=?, price=?,
       price_on_request=?, icon=?, in_stock=?, featured=?, specs=?,
       subtype=?, perf=?, perf_unit=?, related_ids=?, bundle_ids=?, youtube=?, subtitle=?, images=?, subcategory_id=? WHERE id=?`,
      [b.category_id, b.name, b.article || '', b.brand || '', b.description || '', b.price || 0,
       b.price_on_request ? 1 : 0, b.icon || null, b.in_stock ? 1 : 0, b.featured ? 1 : 0, b.specs || '{}',
       b.subtype || null, b.perf || null, b.perf_unit || 'ед./час', jsonArr(b.related_ids), jsonArr(b.bundle_ids),
       b.youtube || null, b.subtitle || null, jsonArr(b.images), b.subcategory_id || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN SETTINGS ====================
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await getSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body || {})) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      await db.runAsync(`INSERT INTO settings (key, value) VALUES (?, ?)
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, val]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/settings/reset-quiz', adminAuth, async (req, res) => {
  try {
    await db.runAsync(`INSERT INTO settings (key,value) VALUES ('quiz',?)
                       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [JSON.stringify(db.DEFAULT_QUIZ)]);
    res.json({ success: true, quiz: db.DEFAULT_QUIZ });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN CATEGORIES ====================
app.get('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    res.json(await db.allAsync(
      `SELECT c.*,
              (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) as product_count,
              (SELECT COUNT(*) FROM subcategories s WHERE s.category_id = c.id) as subcat_count
       FROM categories c ORDER BY c.id`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Укажите название' });
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
    const r = await db.runAsync(
      `INSERT INTO categories (name, slug, description, icon) VALUES (?,?,?,?)`,
      [name, slug, description || '', icon || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть' : e.message }); }
});
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
    await db.runAsync(
      `UPDATE categories SET name=?, slug=?, description=?, icon=? WHERE id=?`,
      [name, slug, description || '', icon || null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть' : e.message }); }
});
app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const cnt = await db.getAsync('SELECT COUNT(*) as n FROM products WHERE category_id=?', [req.params.id]);
    if (cnt.n > 0) return res.status(400).json({ error: `Нельзя удалить: в категории ${cnt.n} товаров. Сначала перенесите их.` });
    await db.runAsync('DELETE FROM subcategories WHERE category_id=?', [req.params.id]);
    await db.runAsync('DELETE FROM categories WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN SUBCATEGORIES ====================
const slugify = (s) => String(s || '').toLowerCase().trim()
  .replace(/[а-яё]/g, ch => ({а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'}[ch] || ch))
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('sc-' + Date.now().toString(36));

app.get('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    res.json(await db.allAsync(
      `SELECT s.*, c.name as category_name, c.slug as category_slug,
              (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) as product_count
       FROM subcategories s JOIN categories c ON s.category_id = c.id
       ORDER BY s.category_id, s.sort, s.name`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    const { category_id, name, description, sort, icon } = req.body;
    if (!category_id || !name) return res.status(400).json({ error: 'Укажите категорию и название' });
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
    const r = await db.runAsync(
      `INSERT INTO subcategories (category_id, name, slug, description, sort, icon) VALUES (?,?,?,?,?,?)`,
      [category_id, name, slug, description || '', sort || 0, icon || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть в этой категории' : e.message }); }
});
app.put('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    const { category_id, name, description, sort, icon } = req.body;
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
    await db.runAsync(
      `UPDATE subcategories SET category_id=?, name=?, slug=?, description=?, sort=?, icon=? WHERE id=?`,
      [category_id, name, slug, description || '', sort || 0, icon || null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('UPDATE products SET subcategory_id=NULL WHERE subcategory_id=?', [req.params.id]);
    await db.runAsync('DELETE FROM subcategories WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Компактный список товаров для админ-виджета «связанные товары»
app.get('/api/admin/products-lite', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const rows = await db.allAsync(`SELECT id, name, article, brand FROM products ORDER BY name`);
    const out = (q
      ? rows.filter(r => `${r.name} ${r.article} ${r.brand}`.toLowerCase().includes(q))
      : rows
    ).slice(0, 30);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN ORDERS ====================
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    const countRow = await db.getAsync('SELECT COUNT(*) as cnt FROM orders');
    const rows = await db.allAsync(
      'SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?',
      [Number(limit), Number(offset)]
    );
    res.json({ total: countRow.cnt, orders: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    await db.runAsync('UPDATE orders SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== UPLOAD ICON ====================
// обёртка: multer-ошибки (размер/тип) отдаём как JSON, а не HTML-500
const mw = (multerMiddleware) => (req, res, next) =>
  multerMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
    next();
  });

app.post('/api/admin/upload-icon', adminAuth, mw(upload.single('icon')), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ filename: req.file.filename });
});

// Несколько изображений сразу
app.post('/api/admin/upload-images', adminAuth, mw(upload.array('images', 12)), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Файлы не загружены' });
  res.json({ filenames: req.files.map(f => f.filename) });
});

// ==================== UPLOAD ZIP (иконки) ====================
const multerZip = multer({ dest: '/tmp/' });
app.post('/api/admin/upload-icons-zip', adminAuth, multerZip.single('zip'), (req, res) => {
  const { execSync } = require('child_process');
  const zipPath = req.file.path;
  const outDir = path.join(__dirname, 'public/icons');
  try {
    execSync(`unzip -o "${zipPath}" -d "${outDir}"`);
    res.json({ success: true, message: 'Иконки загружены' });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка при распаковке' });
  }
});

// ==================== STATIC (SPA fallback) ====================
app.get(/.*/, async (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  const isAdmin = req.path.startsWith('/admin');
  const file = isAdmin
    ? path.join(__dirname, 'public/admin.html')
    : path.join(__dirname, 'public/index.html');
  let html = renderPage(fs.readFileSync(file, 'utf8'));
  if (!isAdmin) {
    try { html = seo.inject(html, await seo.build(req, '/index.html', { softFallback: true })); }
    catch (e) { console.error('SEO inject failed:', e.message); }
  }
  const code = (isAdmin || req.path === '/') ? 200 : 404;
  res.status(code).type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`✅ SIGMA MARKET Shop запущен: http://localhost:${PORT}`);
  console.log(`🛠  Админ-панель: http://localhost:${PORT}/admin.html`);
});
