const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const db = require('./database');
const seo = require('./seo');
const bitrix = require('./bitrix');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PARTIALS_DIR = path.join(PUBLIC_DIR, 'partials');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Пред-запусковый режим: весь сайт закрыт от индексации.
// Включается переменной SITE_NOINDEX=1 (deploy/ecosystem.config.js). Снять в день запуска.
const SITE_NOINDEX = /^(1|true|yes)$/i.test(process.env.SITE_NOINDEX || '');
if (SITE_NOINDEX) {
  console.log('⚠️  SITE_NOINDEX=1 — сайт закрыт от поисковиков (noindex на всех страницах)');
  app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
}
app.locals.SITE_NOINDEX = SITE_NOINDEX;

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

// ЧПУ каталога/товаров + 301 со старого ?category=/?product=
app.get(/.*/, async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = decodeURIComponent(req.path);

  // старый query-формат → 301 на новый ЧПУ
  if (p === '/' && (req.query.product || req.query.category)) {
    try {
      const to = await seo.legacyRedirect(req);
      if (to) return res.redirect(301, to);
    } catch (e) { /* отдадим обычную главную ниже */ }
    return next();
  }

  // /catalog, /catalog/{cat}, /catalog/{cat}/{sub}, /product/{id}-{slug}
  if (p === '/catalog' || /^\/catalog\/[^/]+/.test(p) || /^\/product\/\d/.test(p)) {
    try {
      let html = renderPage(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
      const seoData = await seo.build(req, '/index.html');
      html = seo.inject(html, seoData);
      return res.status(seoData.notFound ? 404 : 200).type('html').send(html);
    } catch (e) {
      console.error('ЧПУ render failed:', e.message);
    }
  }
  next();
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
      quiz: s.quiz || {}, contacts: s.contacts || {}
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
      // раскрываем каждую подкатегорию до её поддерева: родитель → все потомки
      const idRows = subs.length ? await db.allAsync(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM subcategories WHERE slug IN (${subs.map(() => '?').join(',')})
           UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
         ) SELECT id FROM tree`, subs) : [];
      const ids = idRows.map(r => r.id);
      if (ids.length) { where.push('p.subcategory_id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
      else where.push('1=0');
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
      const subcatRows = await db.allAsync(
        `SELECT s.id, s.name, s.slug, s.icon, s.description, s.seo_title, s.seo_description, s.sort, s.parent_id,
                par.slug AS parent_slug,
                (SELECT COUNT(*) FROM products x WHERE x.subcategory_id = s.id) AS own_cnt
         FROM subcategories s
         JOIN categories c ON s.category_id = c.id
         LEFT JOIN subcategories par ON s.parent_id = par.id
         WHERE 1=1 ${catWhere}
         ORDER BY s.sort, s.name`, fParams);
      // свернуть own_cnt вверх по дереву → cnt поддерева
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

    // готовые SEO-мета (единый источник — seo.js); клиент их берёт при SPA-навигации
    product.seo = seo.productMeta(product);

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

    // Bitrix24 — не блокируем ответ клиенту; ошибку только логируем
    getSettings().then(s => {
      const hook = s.crm && s.crm.bitrix_webhook;
      if (!hook) return;
      return bitrix.sendLead(hook, {
        name, phone, email, city, message, items: itemsStr, total,
        pageUrl: req.get('referer') || '',
      }).then(id => console.log('Bitrix24: лид создан #' + id))
        .catch(e => console.error('Bitrix24 lead failed:', e.message));
    }).catch(() => {});

    res.json({ success: true, orderId: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN AUTH ====================
// Токен = "логин:пароль" любого администратора из таблицы admins (все равноправны).
async function adminAuth(req, res, next) {
  try {
    const auth = String(req.headers['x-admin-token'] || '');
    const sep = auth.indexOf(':');
    const u = sep >= 0 ? auth.slice(0, sep) : '';
    const p = sep >= 0 ? auth.slice(sep + 1) : '';
    const admin = u ? await db.getAsync('SELECT * FROM admins WHERE username = ?', [u]) : null;
    if (!admin || p !== admin.password) {
      return res.status(401).json({ error: 'Нет доступа' });
    }
    req.admin = admin;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ---- Журнал действий ----
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim().replace(/^::ffff:/, '');
}
async function logAdmin(req, action, label, detail) {
  try {
    await db.runAsync(
      `INSERT INTO admin_log (admin, action, label, detail, ip) VALUES (?,?,?,?,?)`,
      [(req.admin && req.admin.username) || req._logUser || '—', action, label || null, detail || null, clientIp(req)]
    );
    await db.runAsync(`DELETE FROM admin_log WHERE id <= (SELECT MAX(id) - 10000 FROM admin_log)`);
  } catch { /* журнал не должен ломать основной запрос */ }
}
function adminActionLabel(req) {
  const u = req.originalUrl.split('?')[0];
  const m = req.method;
  const id = (u.match(/\/(\d+)(?:\/[a-z]+)?$/) || [])[1];
  const nm = (req.body && (req.body.name || req.body.title || req.body.username)) || '';
  const tail = nm ? ` «${nm}»` : (id ? ` #${id}` : '');
  const R = [
    [/\/products$/,            { POST: ['create', 'Добавлен товар'] }],
    [/\/products\/\d+$/,       { PUT: ['update', 'Изменён товар'], DELETE: ['delete', 'Удалён товар'] }],
    [/\/categories$/,          { POST: ['create', 'Добавлена категория'] }],
    [/\/categories\/\d+$/,     { PUT: ['update', 'Изменена категория'], DELETE: ['delete', 'Удалена категория'] }],
    [/\/subcategories$/,       { POST: ['create', 'Добавлена подкатегория'] }],
    [/\/subcategories\/\d+$/,  { PUT: ['update', 'Изменена подкатегория'], DELETE: ['delete', 'Удалена подкатегория'] }],
    [/\/orders\/\d+\/status$/, { PUT: ['update', `Статус заявки #${id}: ${(req.body && req.body.status) || ''}`] }],
    [/\/settings\/reset-quiz$/,{ POST: ['update', 'Сброс квиза к стандартному'] }],
    [/\/settings$/,            { PUT: ['update', 'Изменены настройки сайта'] }],
    [/\/upload-/,              { POST: ['update', 'Загрузка файлов'] }],
    [/\/admins$/,              { POST: ['create', 'Создан администратор'] }],
    [/\/admins\/\d+$/,         { PUT: ['update', 'Изменён администратор'], DELETE: ['delete', 'Удалён администратор'] }],
  ];
  for (const [re, map] of R) {
    if (re.test(u) && map[m]) {
      const [action, base] = map[m];
      const label = /Статус заявки|Сброс|настройки|Загрузка/.test(base) ? base : base + tail;
      return { action, label };
    }
  }
  return { action: m.toLowerCase(), label: `${m} ${u}` };
}
// Какие поля показывать в diff-е при редактировании (ключ поля -> подпись, либо {label, bool})
const DIFF_FIELDS = {
  products: {
    name: 'Название', article: 'Артикул', brand: 'Бренд',
    category_id: 'Категория (id)', subcategory_id: 'Подкатегория (id)',
    price: 'Цена', price_on_request: { label: 'Цена по запросу', bool: true },
    in_stock: { label: 'В наличии', bool: true }, featured: { label: 'Хит', bool: true },
    subtitle: 'Подзаголовок', description: 'Описание',
    perf: 'Производительность', perf_unit: 'Ед. произв.', subtype: 'Тип',
    youtube: 'Видео', icon: 'Иконка',
    seo_title: 'SEO-заголовок', seo_description: 'SEO-описание',
    contact_primary: 'Первый контакт (WhatsApp/звонок)',
  },
  categories: { name: 'Название', slug: 'Slug', description: 'Описание', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
  subcategories: { category_id: 'Категория (id)', name: 'Название', slug: 'Slug', description: 'Описание', sort: 'Порядок', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
};
function diffEntity(u) {
  if (/\/products\/\d+$/.test(u)) return 'products';
  if (/\/categories\/\d+$/.test(u)) return 'categories';
  if (/\/subcategories\/\d+$/.test(u)) return 'subcategories';
  return null;
}
async function snapshotBefore(req) {
  const u = req.originalUrl.split('?')[0];
  const id = (u.match(/\/(\d+)(?:\/[a-z]+)?$/) || [])[1];
  if (!id) return null;
  const ent = diffEntity(u);
  if (ent) return db.getAsync(`SELECT * FROM ${ent} WHERE id = ?`, [id]);
  if (/\/orders\/\d+\/status$/.test(u)) return db.getAsync('SELECT id, status FROM orders WHERE id = ?', [id]);
  return null;
}
function shortVal(v) {
  v = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  if (!v) return '∅';
  return v.length > 80 ? v.slice(0, 80) + '…' : v;
}
function diffDetail(req) {
  const u = req.originalUrl.split('?')[0];
  const before = req._before, body = req.body || {};
  if (req.method === 'DELETE') {
    if (before && before.name) {
      return 'Было: «' + before.name + '»' +
        (before.article ? ` (арт. ${before.article})` : '') +
        (before.slug ? ` [${before.slug}]` : '');
    }
    return null;
  }
  if (/\/orders\/\d+\/status$/.test(u)) {
    return before ? `${before.status || '?'} → ${body.status || '?'}` : null;
  }
  const ent = diffEntity(u);
  const map = ent && DIFF_FIELDS[ent];
  if (!map || !before) return null;
  const norm = (cfg, val) => (cfg && cfg.bool)
    ? (val && String(val) !== '0' && val !== 'false' ? 'да' : 'нет')
    : (val == null ? '' : String(val));
  const parts = [];
  for (const [f, cfg] of Object.entries(map)) {
    if (!(f in body)) continue;
    const label = typeof cfg === 'string' ? cfg : cfg.label;
    const ov = norm(cfg, before[f]);
    const nv = norm(cfg, body[f]);
    if (ov === nv) continue;
    if (!cfg.bool && ov !== '' && nv !== '' && !isNaN(ov) && !isNaN(nv) && Number(ov) === Number(nv)) continue;
    parts.push(`${label}: ${shortVal(ov)} → ${shortVal(nv)}`);
  }
  return parts.length ? parts.join('; ') : 'поля не изменились';
}

// Пишем в журнал любое успешное изменение под /api/admin (кроме входа — он логируется отдельно)
app.use('/api/admin', async (req, res, next) => {
  if (req.method === 'GET' || req.path === '/login') return next();
  if (req.method === 'PUT' || req.method === 'DELETE') {
    try { req._before = await snapshotBefore(req); } catch { /* игнор */ }
  }
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const { action, label } = adminActionLabel(req);
    logAdmin(req, action, label, diffDetail(req));
  });
  next();
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    req._logUser = (username || '—').toString().slice(0, 60);
    const admin = await db.getAsync(
      'SELECT * FROM admins WHERE username = ? AND password = ?',
      [username, password]
    );
    if (!admin) {
      await logAdmin(req, 'login_fail', 'Неудачный вход');
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    await logAdmin(req, 'login', 'Вход в панель');
    res.json({ token: `${admin.username}:${admin.password}`, username: admin.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN: АДМИНИСТРАТОРЫ ====================
app.get('/api/admin/admins', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT id, username FROM admins ORDER BY id');
    res.json(rows.map(r => ({ ...r, me: r.id === req.admin.id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/admins', adminAuth, async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (username.length < 3 || password.length < 4) {
      return res.status(400).json({ error: 'Логин от 3 символов, пароль от 4 символов' });
    }
    try {
      const r = await db.runAsync('INSERT INTO admins (username, password) VALUES (?, ?)', [username, password]);
      res.json({ success: true, id: r.lastID });
    } catch { res.status(400).json({ error: 'Такой логин уже существует' }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/admins/:id', adminAuth, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT * FROM admins WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const username = String((req.body && req.body.username) || cur.username).trim() || cur.username;
    const password = String((req.body && req.body.password) || '') || cur.password;
    try {
      await db.runAsync('UPDATE admins SET username = ?, password = ? WHERE id = ?', [username, password, req.params.id]);
      res.json({ success: true });
    } catch { res.status(400).json({ error: 'Такой логин уже существует' }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/admins/:id', adminAuth, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT id FROM admins WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const total = (await db.getAsync('SELECT COUNT(*) AS c FROM admins')).c;
    if (total <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    if (String(req.admin.id) === String(req.params.id)) {
      return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    }
    await db.runAsync('DELETE FROM admins WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN: ЖУРНАЛ ====================
app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 60);
    const where = [], params = [];
    if (req.query.admin) { where.push('admin = ?'); params.push(req.query.admin); }
    if (req.query.action === 'login') { where.push("action IN ('login','login_fail')"); }
    else if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
    if (req.query.q) {
      where.push('(label LIKE ? OR detail LIKE ? OR ip LIKE ?)');
      const like = `%${req.query.q}%`; params.push(like, like, like);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await db.getAsync(`SELECT COUNT(*) AS c FROM admin_log ${w}`, params)).c;
    const rows = await db.allAsync(
      `SELECT * FROM admin_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const admins = (await db.allAsync('SELECT DISTINCT admin FROM admin_log ORDER BY admin')).map(r => r.admin);
    res.json({ total, page, limit, rows, admins });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Частичный UPDATE: в SET попадают только те колонки, ключи которых реально есть в теле запроса.
// cols — { колонка: fn(value, body) | null }. Пустой результат = ничего не меняем.
function partialUpdate(cols, body) {
  const sets = [], params = [];
  for (const [col, transform] of Object.entries(cols)) {
    if (!(col in body)) continue;
    sets.push(col + ' = ?');
    params.push(transform ? transform(body[col], body) : body[col]);
  }
  return { sets, params };
}

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const b = req.body;
    const result = await db.runAsync(
      `INSERT INTO products (category_id, name, article, brand, description, price, price_on_request, icon, in_stock, featured, specs,
                             subtype, perf, perf_unit, related_ids, bundle_ids, youtube, subtitle, images, subcategory_id,
                             seo_title, seo_description, contact_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.category_id, b.name, b.article || '', b.brand || '', b.description || '', b.price || 0,
       b.price_on_request ? 1 : 0, b.icon || null, b.in_stock ? 1 : 0, b.featured ? 1 : 0, b.specs || '{}',
       b.subtype || null, b.perf || null, b.perf_unit || 'ед./час', jsonArr(b.related_ids), jsonArr(b.bundle_ids),
       b.youtube || null, b.subtitle || null, jsonArr(b.images), b.subcategory_id || null,
       (b.seo_title || '').trim() || null, (b.seo_description || '').trim() || null,
       (b.contact_primary === '1' || b.contact_primary === '2') ? b.contact_primary : null]
    );
    res.json({ success: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await db.getAsync('SELECT id FROM products WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Товар не найден' });
    const { sets, params } = partialUpdate({
      category_id: null,
      subcategory_id: v => v || null,
      name: null,
      article: v => v || '',
      brand: v => v || '',
      description: v => v || '',
      price: v => v || 0,
      price_on_request: v => (v ? 1 : 0),
      icon: v => v || null,
      in_stock: v => (v ? 1 : 0),
      featured: v => (v ? 1 : 0),
      specs: v => v || '{}',
      subtype: v => v || null,
      perf: v => v || null,
      perf_unit: v => v || 'ед./час',
      related_ids: v => jsonArr(v),
      bundle_ids: v => jsonArr(v),
      youtube: v => v || null,
      subtitle: v => v || null,
      images: v => jsonArr(v),
      seo_title: v => (v || '').trim() || null,
      seo_description: v => (v || '').trim() || null,
      contact_primary: v => (v === '1' || v === '2') ? v : null,
    }, b);
    if (!sets.length) return res.json({ success: true });
    await db.runAsync(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
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
// Проверка связи с Bitrix24 — создаёт тестового лида
app.post('/api/admin/crm-test', adminAuth, async (req, res) => {
  try {
    const hook = (req.body && req.body.bitrix_webhook || '').trim()
      || ((await getSettings()).crm || {}).bitrix_webhook;
    if (!hook) return res.status(400).json({ error: 'Не указан адрес вебхука' });
    const id = await bitrix.sendLead(hook, {
      name: 'Тест SIGMA MARKET',
      phone: '+7 700 000 00 00',
      message: 'Тестовая заявка — проверка связи с сайтом. Можно удалить.',
      items: '[]',
    });
    res.json({ success: true, leadId: id });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
      `INSERT INTO categories (name, slug, description, icon, seo_title, seo_description) VALUES (?,?,?,?,?,?)`,
      [name, slug, description || '', icon || null,
       (req.body.seo_title || '').trim() || null, (req.body.seo_description || '').trim() || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть' : e.message }); }
});
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await db.getAsync('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const { sets, params } = partialUpdate({
      name: null,
      slug: (v, body) => (v ? slugify(v) : slugify(body.name || cur.name)),
      description: v => v || '',
      icon: v => v || null,
      seo_title: v => (v || '').trim() || null,
      seo_description: v => (v || '').trim() || null,
    }, b);
    if (!sets.length) return res.json({ success: true });
    await db.runAsync(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
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
              par.name AS parent_name,
              (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) as product_count
       FROM subcategories s JOIN categories c ON s.category_id = c.id
       LEFT JOIN subcategories par ON s.parent_id = par.id
       ORDER BY s.category_id, s.sort, s.name`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    const { category_id, name, description, sort, icon } = req.body;
    if (!category_id || !name) return res.status(400).json({ error: 'Укажите категорию и название' });
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
    const r = await db.runAsync(
      `INSERT INTO subcategories (category_id, name, slug, description, sort, icon, seo_title, seo_description, parent_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      [category_id, name, slug, description || '', sort || 0, icon || null,
       (req.body.seo_title || '').trim() || null, (req.body.seo_description || '').trim() || null,
       req.body.parent_id || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть в этой категории' : e.message }); }
});
app.put('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await db.getAsync('SELECT * FROM subcategories WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const { sets, params } = partialUpdate({
      category_id: null,
      name: null,
      slug: (v, body) => (v ? slugify(v) : slugify(body.name || cur.name)),
      description: v => v || '',
      sort: v => v || 0,
      icon: v => v || null,
      seo_title: v => (v || '').trim() || null,
      seo_description: v => (v || '').trim() || null,
      parent_id: v => (v && Number(v) !== Number(req.params.id) ? Number(v) : null),
    }, b);
    if (!sets.length) return res.json({ success: true });
    await db.runAsync(`UPDATE subcategories SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть в этой категории' : e.message }); }
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
