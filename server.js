const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const db = require('./database');
const seo = require('./seo');
const bitrix = require('./bitrix');
const notify = require('./notify');
const otp = require('./otp');
const kp = require('./kp');
const crypto = require('crypto');
const { queryCategories, queryProducts } = require('./queries');

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
// Экраны SPA (index.html) — на старте страницы шлём только тот, что реально нужен
// для текущего маршрута; остальные подгружает клиент по требованию (JS, ensureView).
const SPA_VIEWS = new Set(['home', 'catalog', 'product', 'notfound']);
// Версия для ?v=... в ссылках на site.js/product.js/style.css — считается по дате
// изменения самих файлов, а не руками (раньше не раз забывали её поднять, и браузер
// после правок тихо отдавал старую версию из 30-дневного кэша). Меняется сама и сразу
// при следующей правке любого из этих трёх файлов — перезапуск сервера не нужен.
function assetVersion() {
  try {
    const files = ['js/site.js', 'js/product.js', 'style.css'].map(f => path.join(PUBLIC_DIR, f));
    const mtimes = files.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
    return Math.round(Math.max(0, ...mtimes)).toString(36);
  } catch (e) { return 'x'; }
}
function renderPage(html, activeView) {
  html = html.replace(/\{\{V\}\}/g, assetVersion());
  return html.replace(/<!--\s*partial:([\w-]+)\s*-->/g, (m, name) => {
    if (activeView && SPA_VIEWS.has(name) && name !== activeView) return '';
    return getPartial(name) || m;
  });
}
// Данные для клиента "на будущее" — те же категории/товары, что сервер уже запросил
// для построения HTML (см. seo.injectContent), кладём в window.__HYDRATE__, чтобы
// init()/loadProducts() в браузере при первом заходе НЕ запрашивали их ещё раз —
// только seoData.view (home/catalog/product/notFound) означает, что рендерится SPA
// index.html; для отдельных статических страниц (about.html и т.п.) гидрация не нужна.
async function buildHydrate(seoData, req) {
  if (!seoData || !seoData.view) return null;
  const hydrate = { categories: await queryCategories() };
  if (seoData.view === 'catalog' && !seoData.notFound) {
    const p = decodeURIComponent(req.path);
    const mc = p.match(/^\/catalog(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
    const catSlug = (mc && mc[1]) || 'all';
    const subSlug = (mc && mc[2]) || '';
    // limit должен совпадать с state.limit в public/index.html — иначе клиент решит,
    // что уже получил все товары (page*limit >= total), и не подгрузит остальное при скролле.
    hydrate.products = await queryProducts({
      category: catSlug, subcategory: subSlug, page: 1, limit: 500, sort: 'default', facets: '1'
    });
    hydrate.productsFilter = { category: catSlug, subcat: subSlug };
  }
  return hydrate;
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
      const seoData = await seo.build(req, '/index.html');
      let html = renderPage(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), (seoData.view || '').toLowerCase());
      html = seo.inject(html, seoData);
      html = await seo.injectContent(html, seoData, req, await buildHydrate(seoData, req));
      // Просмотры считаем на клиенте (см. /api/track-view) — после первого захода
      // переходы внутри сайта идут через JS без обращения к серверу, сюда бы не попали.
      // no-cache (не no-store) — браузер всё равно спросит сервер "не изменилось ли"
      // через ETag перед показом из кэша; без этого Safari на iPhone иногда показывал
      // страницу из своего кэша/bfcache старой, ещё до последнего деплоя правок.
      res.set('Cache-Control', 'no-cache');
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
  let seoData = null;
  if (rel !== '/admin.html') {
    try { seoData = await seo.build(req, rel); } catch (e) { console.error('SEO build failed:', e.message); }
  }
  let html = renderPage(fs.readFileSync(full, 'utf8'), seoData && (seoData.view || '').toLowerCase());
  if (seoData) {
    try { html = seo.inject(html, seoData); }
    catch (e) { console.error('SEO inject failed:', e.message); }
    html = await seo.injectContent(html, seoData, req, await buildHydrate(seoData, req));
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

// По умолчанию express.static шлёт max-age=0 — браузер скачивает JS/CSS/картинки
// заново при каждом переходе по сайту. Загруженные иконки товаров никогда не
// перезаписываются (при повторной загрузке файл получает новое имя, см. multer
// storage выше), а JS/CSS обновляются через ?v=… в самих ссылках — так что 30 дней
// кэша безопасны и заметно ускоряют повторные переходы, особенно на мобильном интернете.
app.use(express.static(PUBLIC_DIR, { maxAge: '30d' }));

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
    res.json(await queryCategories());
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
      quiz: s.quiz || {}, contacts: s.contacts || {}, bonus: s.bonus || {}, kp: s.kp || {}
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
    const search = String(req.query.search || '').trim();
    if (search && !isBot(req)) logStat('search', null, search, null);
    res.json(await queryProducts(req.query));
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

// ==================== СКАЧИВАНИЕ КП (мгновенно, по номеру телефона) ====================
// Включается в админке → Вовлечённость → КП («Мгновенное скачивание»). Пока выключено —
// кнопка на сайте работает как раньше, через обычную заявку (requestModal), сюда не попадает.
// Без кода подтверждения — SMS/WhatsApp стоят денег за каждое сообщение, а тут просто лид.
app.post('/api/kp/download', async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (!/^[78]\d{10}$/.test(phone)) return res.status(400).json({ error: 'Некорректный номер телефона' });
    const productId = Number(req.body && req.body.productId);
    const product = await db.getAsync('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) return res.status(404).json({ error: 'Товар не найден' });

    await db.runAsync('INSERT INTO kp_leads (product_id, phone) VALUES (?, ?)', [productId, phone]);
    const s = await getSettings();
    kp.buildProductKpPdf(res, product, s.kp || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ОТЗЫВЫ НА ТОВАРЫ ====================
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT id, name, rating, text, created_at FROM reviews
       WHERE product_id = ? AND status = 'approved' ORDER BY id DESC`,
      [req.params.id]
    );
    const count = rows.length;
    const avg = count ? rows.reduce((s, r) => s + r.rating, 0) / count : 0;
    res.json({ rows, count, avg: Math.round(avg * 10) / 10 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/products/:id/reviews', async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const product = await db.getAsync('SELECT id FROM products WHERE id = ?', [productId]);
    if (!product) return res.status(404).json({ error: 'Товар не найден' });

    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const rating = Math.round(Number(req.body && req.body.rating));
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!name || !(rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'Укажите имя и оценку от 1 до 5' });
    }
    const customer = await getCustomerByToken(req);
    await db.runAsync(
      `INSERT INTO reviews (product_id, name, rating, text, customer_id) VALUES (?,?,?,?,?)`,
      [productId, name, rating, text, customer ? customer.id : null]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ОБЩИЕ ОТЗЫВЫ (страница /reviews, не привязаны к товару) ====================
app.get('/api/reviews', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT id, name, company, rating, text, created_at FROM reviews
       WHERE product_id IS NULL AND status = 'approved' ORDER BY id DESC LIMIT 60`
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/reviews', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const phone = String((req.body && req.body.phone) || '').trim().slice(0, 30);
    const company = String((req.body && req.body.company) || '').trim().slice(0, 150);
    const rating = Math.round(Number(req.body && req.body.rating));
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!name || !(rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'Укажите имя и оценку от 1 до 5' });
    }
    const customer = await getCustomerByToken(req);
    await db.runAsync(
      `INSERT INTO reviews (product_id, name, phone, company, rating, text, customer_id) VALUES (NULL,?,?,?,?,?,?)`,
      [name, phone, company, rating, text, customer ? customer.id : null]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ORDERS ====================
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, email, city, message, items } = req.body;
    if (!name || !phone || !items) {
      return res.status(400).json({ error: 'Заполните обязательные поля' });
    }
    if (!/^[78]\d{10}$/.test(String(phone).replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'Некорректный номер телефона' });
    }

    let itemsStr = typeof items === 'string' ? items : JSON.stringify(items);
    let total = 0;
    try {
      const parsed = JSON.parse(itemsStr);
      total = parsed.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    } catch {}

    // Бонусы: если оформляет вошедший клиент, спишем запрошенную сумму
    // (не больше остатка и не больше суммы заказа) и запомним, кто оформил.
    const customer = await getCustomerByToken(req);
    const s = await getSettings();
    const bonusCfg = s.bonus || {};
    let usedBonus = 0;
    if (customer && bonusCfg.enabled) {
      usedBonus = Math.max(0, Math.min(Number(req.body.useBonus) || 0, customer.bonus_balance, total));
      if (usedBonus > 0) {
        total -= usedBonus;
        await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance - ? WHERE id = ?', [usedBonus, customer.id]);
        await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [customer.id, -usedBonus, 'order_redeem']);
      }
    }

    const result = await db.runAsync(
      `INSERT INTO orders (name, phone, email, city, message, items, total, customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, phone, email || '', city || '', message || '', itemsStr, total, customer ? customer.id : null]
    );

    // Начисление бонусов за заказ — процент от суммы к оплате
    if (customer && bonusCfg.enabled && bonusCfg.earn_percent > 0 && total > 0) {
      const earned = Math.round(total * bonusCfg.earn_percent / 100);
      if (earned > 0) {
        await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [earned, customer.id]);
        await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)', [earned, customer.id, 'order_earn', result.lastID]);
      }
    }

    // Bitrix24 + WhatsApp/Email — не блокируем ответ клиенту; ошибки только логируем
    getSettings().then(s => {
      const hook = s.crm && s.crm.bitrix_webhook;
      if (hook) {
        bitrix.sendLead(hook, {
          name, phone, email, city, message, items: itemsStr, total,
          pageUrl: req.get('referer') || '',
        }).then(id => console.log('Bitrix24: лид создан #' + id))
          .catch(e => console.error('Bitrix24 lead failed:', e.message));
      }
      notify.notifyOrder({ id: result.lastID, name, phone, email, city, message, items: itemsStr, total })
        .catch(e => console.error('Order notify failed:', e.message));
    }).catch(() => {});

    res.json({ success: true, orderId: result.lastID, bonusUsed: usedBonus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ЛОГ ОШИБОК НА САЙТЕ ====================
// Публичный — шлёт браузер любого посетителя при JS-ошибке. Никогда не должен
// сам уронить страницу, поэтому всегда отвечает 200 и не бросает наружу.
app.post('/api/log-error', async (req, res) => {
  try {
    const message = String((req.body && req.body.message) || '').slice(0, 2000);
    const context = String((req.body && req.body.context) || '').slice(0, 200);
    const url = String((req.body && req.body.url) || '').slice(0, 500);
    if (message) {
      await db.runAsync(
        `INSERT INTO client_errors (message, context, url, ip) VALUES (?,?,?,?)`,
        [message, context, url, clientIp(req)]
      );
      await db.runAsync(`DELETE FROM client_errors WHERE id <= (SELECT MAX(id) - 5000 FROM client_errors)`);
    }
  } catch { /* лог ошибок не должен сам стать причиной ошибки */ }
  res.json({ ok: true });
});

// ==================== СТАТИСТИКА: ПРОСМОТРЫ С КЛИЕНТА ====================
// Публичный, шлётся из браузера при каждом реальном показе страницы — и при первой
// загрузке, и при переходах внутри SPA (там сервер второй раз не запрашивается).
// Никогда не должен ронять страницу — как и /api/log-error.
app.post('/api/track-view', async (req, res) => {
  try {
    const type = req.body && req.body.type === 'product_view' ? 'product_view' : 'pageview';
    const path = String((req.body && req.body.path) || '').slice(0, 500);
    const refId = type === 'product_view' ? Number(req.body && req.body.refId) || null : null;
    if (path && !isBot(req)) logStat(type, path, null, refId);
  } catch { /* статистика не должна ронять страницу */ }
  res.json({ ok: true });
});

// Клики по ключевым кнопкам: подбор оборудования, запрос КП, звонок, WhatsApp.
const CTA_KINDS = new Set(['quiz', 'offer', 'call', 'whatsapp']);
app.post('/api/track-click', async (req, res) => {
  try {
    const kind = String((req.body && req.body.kind) || '');
    const path = String((req.body && req.body.path) || '').slice(0, 500);
    const productId = Number(req.body && req.body.productId) || null;
    if (CTA_KINDS.has(kind) && !isBot(req)) logStat('cta_click', path, kind, productId);
  } catch { /* статистика не должна ронять страницу */ }
  res.json({ ok: true });
});

// ==================== CUSTOMER AUTH (регистрация, бонусы) ====================
// Токен — случайная строка в customer_sessions, живёт до выхода/навсегда (как в корзине).
async function getCustomerByToken(req) {
  const token = String(req.headers['x-customer-token'] || '');
  if (!token) return null;
  const row = await db.getAsync(
    `SELECT c.* FROM customer_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token = ?`,
    [token]
  );
  return row || null;
}
// Нормализация номера для сравнения в SQL: убираем форматирование (+, пробелы, скобки,
// дефис) и берём последние 10 цифр — казахстанский номер пишут то с +7, то с 8 в начале
// (одна и та же цифра физического номера), надёжно совпадает только 10-значный хвост.
function phoneNormSql(col) {
  return `SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},' ',''),'(',''),')',''),'-',''),'+',''), -10)`;
}
async function customerAuth(req, res, next) {
  const customer = await getCustomerByToken(req);
  if (!customer) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.customer = customer;
  next();
}
function customerPublic(c) {
  return { id: c.id, name: c.name, phone: c.phone, email: c.email, company: c.company || '', bonusBalance: c.bonus_balance, avatar: c.avatar || null };
}
// Уведомление в личный кабинет клиента («Мои уведомления») — сейчас используется для
// начисления бонуса при регистрации и при выполнении заказа.
async function notifyCustomer(customerId, message) {
  try { await db.runAsync('INSERT INTO notifications (customer_id, message) VALUES (?, ?)', [customerId, message]); }
  catch (e) { /* уведомление не должно ломать основной запрос */ }
}

// Вход без пароля: код на телефон (WhatsApp, если нет — SMS) → подтверждение.
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (!/^[78]\d{10}$/.test(phone)) return res.status(400).json({ error: 'Некорректный номер телефона' });
    const result = await otp.requestCode(phone);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const code = String((req.body && req.body.code) || '').trim();
    const name = String((req.body && req.body.name) || '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' });
    let customer = await db.getAsync('SELECT * FROM customers WHERE phone = ?', [phone]);
    // Новому клиенту без имени код пока не «сжигаем» — понадобится повторно с именем.
    try { await otp.verifyCode(phone, code, !!customer || !!name); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    let isNew = false;
    if (!customer) {
      if (!name) return res.status(400).json({ error: 'Укажите имя', needName: true });
      const r = await db.runAsync(`INSERT INTO customers (name, phone, registered_at) VALUES (?, ?, datetime('now'))`, [name, phone]);
      isNew = true;
      const s = await getSettings();
      const bonusCfg = s.bonus || {};
      if (bonusCfg.enabled && bonusCfg.register_bonus > 0) {
        await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [bonusCfg.register_bonus, r.lastID]);
        await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [r.lastID, bonusCfg.register_bonus, 'register']);
        await notifyCustomer(r.lastID, `Добро пожаловать в SIGMA MARKET! Вам начислено ${bonusCfg.register_bonus} ₸ бонусами за регистрацию.`);
      }
      customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [r.lastID]);
    } else if (!customer.registered_at) {
      // Запись уже была (например, создалась автоматически при начислении бонуса
      // к заказу), но сам клиент входит по коду впервые — вот это и есть регистрация.
      await db.runAsync(`UPDATE customers SET registered_at = datetime('now') WHERE id = ?`, [customer.id]);
      customer.registered_at = new Date().toISOString();
    }

    const token = crypto.randomBytes(24).toString('base64url');
    await db.runAsync('INSERT INTO customer_sessions (token, customer_id) VALUES (?, ?)', [token, customer.id]);
    res.json({ token, customer: customerPublic(customer), isNew });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', customerAuth, async (req, res) => {
  res.json({ customer: customerPublic(req.customer) });
});

app.get('/api/me/orders', customerAuth, async (req, res) => {
  // customer_id стоит только у заказов, оформленных вошедшим клиентом — более старые
  // (или оформленные гостем до входа) находим по номеру телефона, та же нормализация,
  // что и в админке (см. /api/admin/customers/:id).
  const rows = await db.allAsync(
    `SELECT o.id, o.items, o.total, o.status, o.created_at,
       COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = o.id AND reason = 'order_earn'), 0) AS bonus_earned
     FROM orders o
     WHERE o.customer_id = ? OR ${phoneNormSql('o.phone')} = ${phoneNormSql('?')}
     ORDER BY o.id DESC LIMIT 50`,
    [req.customer.id, req.customer.phone]
  );
  const orders = rows.map(o => {
    let items = [];
    try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []); } catch {}
    return { id: o.id, items, total: o.total, status: o.status, createdAt: o.created_at, bonusEarned: o.bonus_earned };
  });
  res.json({ orders });
});

app.put('/api/me', customerAuth, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
  const email = String((req.body && req.body.email) || '').trim().slice(0, 150);
  const company = String((req.body && req.body.company) || '').trim().slice(0, 150);
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  await db.runAsync('UPDATE customers SET name = ?, email = ?, company = ? WHERE id = ?', [name, email, company, req.customer.id]);
  const customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
  res.json({ customer: customerPublic(customer) });
});

app.get('/api/me/favorites', customerAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT p.id, p.name, p.price, p.price_on_request, p.icon, p.unit, c.slug AS category_slug
     FROM customer_favorites f JOIN products p ON p.id = f.product_id
     JOIN categories c ON c.id = p.category_id
     WHERE f.customer_id = ? ORDER BY f.created_at DESC`,
    [req.customer.id]
  );
  res.json({ products: rows });
});
app.post('/api/me/favorites', customerAuth, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [Number(req.body && req.body.productId)];
  for (const id of ids) {
    if (!id) continue;
    await db.runAsync('INSERT OR IGNORE INTO customer_favorites (customer_id, product_id) VALUES (?, ?)', [req.customer.id, Number(id)]);
  }
  res.json({ success: true });
});
app.delete('/api/me/favorites/:productId', customerAuth, async (req, res) => {
  await db.runAsync('DELETE FROM customer_favorites WHERE customer_id = ? AND product_id = ?', [req.customer.id, Number(req.params.productId)]);
  res.json({ success: true });
});

app.get('/api/me/reviews', customerAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT r.id, r.rating, r.text, r.status, r.created_at, r.product_id, p.name AS product_name
     FROM reviews r LEFT JOIN products p ON p.id = r.product_id
     WHERE r.customer_id = ? ORDER BY r.id DESC LIMIT 50`,
    [req.customer.id]
  );
  res.json({ reviews: rows });
});

app.get('/api/me/notifications', customerAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT id, message, created_at FROM notifications WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
    [req.customer.id]
  );
  res.json({ notifications: rows });
});

app.post('/api/logout', customerAuth, async (req, res) => {
  await db.runAsync('DELETE FROM customer_sessions WHERE token = ?', [String(req.headers['x-customer-token'] || '')]);
  res.json({ success: true });
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

// ---- Статистика сайта (для админки — просмотры, поисковые запросы, товары) ----
function isBot(req) {
  return /bot|crawl|spider|slurp|bingpreview|yandex|google|facebookexternalhit|whatsapp|telegram/i
    .test(String(req.headers['user-agent'] || ''));
}
async function logStat(type, path, value, refId) {
  try {
    await db.runAsync(
      `INSERT INTO stats_events (type, path, value, ref_id) VALUES (?,?,?,?)`,
      [type, path || null, value || null, refId || null]
    );
    await db.runAsync(`DELETE FROM stats_events WHERE id <= (SELECT MAX(id) - 200000 FROM stats_events)`);
  } catch { /* статистика не должна ломать основной запрос */ }
}
async function logAdmin(req, action, label, detail, orderId, customerId) {
  try {
    await db.runAsync(
      `INSERT INTO admin_log (admin, action, label, detail, ip, order_id, customer_id) VALUES (?,?,?,?,?,?,?)`,
      [(req.admin && req.admin.username) || req._logUser || '—', action, label || null, detail || null, clientIp(req), orderId || null, customerId || null]
    );
    await db.runAsync(`DELETE FROM admin_log WHERE id <= (SELECT MAX(id) - 10000 FROM admin_log)`);
  } catch { /* журнал не должен ломать основной запрос */ }
}
// Заявка, к которой относится запрос — либо из самого URL (/orders/:id...), либо
// проставлена руками в обработчике (req._logOrderId — например, id новой заявки
// после её создания, когда в URL id ещё не было). Нужно, чтобы показывать в карточке
// заявки журнал именно по ней, а не искать по тексту label.
function extractOrderId(req) {
  if (req._logOrderId) return req._logOrderId;
  const m = req.originalUrl.split('?')[0].match(/\/orders\/(\d+)/);
  return m ? Number(m[1]) : null;
}
// То же самое для клиента (/customers/:id...), плюс req._logCustomerId — когда клиент
// определяется не из URL, а внутри обработчика (например, при завершении заявки, где
// клиент находится/создаётся по телефону).
function extractCustomerId(req) {
  if (req._logCustomerId) return req._logCustomerId;
  const m = req.originalUrl.split('?')[0].match(/\/customers\/(\d+)/);
  return m ? Number(m[1]) : null;
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
    [/\/orders\/\d+\/complete$/, { PUT: ['update', 'Заказ выполнен'] }],
    [/\/orders\/\d+\/notes$/,  { POST: ['create', 'Добавлено примечание к заявке'] }],
    [/\/orders\/\d+$/,         { PUT: ['update', 'Изменена заявка'] }],
    [/\/customers\/\d+$/,      { PUT: ['update', 'Изменён клиент'] }],
    [/\/customers\/\d+\/deduct-bonus$/, { PUT: ['update', 'Списан бонус клиенту'] }],
    [/\/reviews\/\d+$/,        { PUT: ['update', `Отзыв #${id}: ${(req.body && req.body.status) || ''}`], DELETE: ['delete', `Удалён отзыв #${id}`] }],
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

const DIFF_FIELDS = {
  products: {
    name: 'Название', article: 'Артикул', brand: 'Бренд',
    category_id: 'Категория (id)', subcategory_id: 'Подкатегория (id)',
    price: 'Цена', price_on_request: { label: 'Цена по запросу', bool: true },
    in_stock: { label: 'В наличии', bool: true }, featured: { label: 'Хит продаж', bool: true },
    subtitle: 'Подзаголовок', description: 'Описание',
    perf: 'Производительность', perf_unit: 'Ед. произв.', subtype: 'Тип',
    youtube: 'Видео', icon: 'Иконка',
    seo_title: 'SEO-заголовок', seo_description: 'SEO-описание',
    contact_primary: 'Первый контакт (WhatsApp/звонок)',
  },
  categories: { name: 'Название', slug: 'Slug', description: 'Описание', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
  subcategories: { category_id: 'Категория (id)', name: 'Название', slug: 'Slug', description: 'Описание', sort: 'Порядок', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
  orders: { name: 'Имя', phone: 'Телефон', email: 'Email', city: 'Город', company: 'Компания', message: 'Комментарий', total: 'Сумма' },
  customers: { name: 'Имя', phone: 'Телефон', email: 'Email', city: 'Город', company: 'Компания', bonus_balance: { label: 'Бонусы', bodyKey: 'bonusBalance' } },
};
function diffEntity(u) {
  if (/\/products\/\d+$/.test(u)) return 'products';
  if (/\/categories\/\d+$/.test(u)) return 'categories';
  if (/\/subcategories\/\d+$/.test(u)) return 'subcategories';
  if (/\/orders\/\d+$/.test(u)) return 'orders';
  if (/\/customers\/\d+$/.test(u)) return 'customers';
  return null;
}
async function snapshotBefore(req) {
  const u = req.originalUrl.split('?')[0];
  const id = (u.match(/\/(\d+)(?:\/[a-z]+)?$/) || [])[1];
  if (!id) return null;
  const ent = diffEntity(u);
  if (ent) return db.getAsync(`SELECT * FROM ${ent} WHERE id = ?`, [id]);
  if (/\/orders\/\d+\/status$/.test(u)) return db.getAsync('SELECT id, status FROM orders WHERE id = ?', [id]);
  if (/\/orders\/\d+\/complete$/.test(u)) return db.getAsync('SELECT id, total FROM orders WHERE id = ?', [id]);
  return null;
}
function shortVal(v) {
  v = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  if (!v) return '∅';
  // Ограничение — просто защита от совсем огромных полей, не для UI-обрезки
  // (в журнале полный текст видно по клику → модальное окно).
  return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
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
  if (/\/orders\/\d+\/complete$/.test(u)) {
    const parts = [];
    if (before && Number(before.total) !== Number(body.total)) parts.push(`Сумма: ${shortVal(before.total)} → ${shortVal(body.total)}`);
    // req._logBonusAward — то, что реально применил сервер (0, если не superadmin),
    // а не body.bonusAward — то, что просто пришло с формы (это вводило в заблуждение:
    // лог писал «начислено», хотя сервер это тихо отклонял).
    if (req._logBonusAward > 0) parts.push(`Начислено бонусов: ${req._logBonusAward}`);
    return parts.length ? parts.join('\n') : null;
  }
  if (/\/customers\/\d+\/deduct-bonus$/.test(u)) {
    return req._logDeductAmount ? `Списано бонусов: ${req._logDeductAmount}` : null;
  }
  if (/\/orders\/\d+\/notes$/.test(u) && req.method === 'POST') {
    return 'Текст: ' + shortVal(body.text) + (body.remindAt ? `\nНапоминание: ${body.remindAt}` : '');
  }
  const ent = diffEntity(u);
  const map = ent && DIFF_FIELDS[ent];
  if (!map || !before) return null;
  const norm = (cfg, val) => (cfg && cfg.bool)
    ? (val && String(val) !== '0' && val !== 'false' ? 'да' : 'нет')
    : (val == null ? '' : String(val));
  const parts = [];
  for (const [f, cfg] of Object.entries(map)) {
    // bodyKey — когда в запросе поле называется иначе, чем колонка в базе
    // (например customers.bonus_balance приходит как body.bonusBalance).
    const bodyKey = (cfg && cfg.bodyKey) || f;
    if (!(bodyKey in body)) continue;
    const label = typeof cfg === 'string' ? cfg : cfg.label;
    const ov = norm(cfg, before[f]);
    const nv = norm(cfg, body[bodyKey]);
    if (ov === nv) continue;
    if (!cfg.bool && ov !== '' && nv !== '' && !isNaN(ov) && !isNaN(nv) && Number(ov) === Number(nv)) continue;
    parts.push(`${label}: ${shortVal(ov)} → ${shortVal(nv)}`);
  }
  // \n, не "; " — иначе если в самом значении (например, в описании) встретится "; ",
  // модальное окно в журнале не сможет надёжно разбить текст обратно на поля.
  return parts.length ? parts.join('\n') : 'поля не изменились';
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
    logAdmin(req, action, label, diffDetail(req), extractOrderId(req), extractCustomerId(req));
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
// Кто я — для UI (скрыть/показать поля бонусов и саму панель «Администраторы» тем,
// у кого роль не superadmin).
app.get('/api/admin/me', adminAuth, async (req, res) => {
  res.json({ username: req.admin.username, role: req.admin.role || 'admin' });
});
function requireSuperadmin(req, res, next) {
  if ((req.admin.role || 'admin') !== 'superadmin') return res.status(403).json({ error: 'Доступно только супер-администратору' });
  next();
}
app.get('/api/admin/admins', adminAuth, requireSuperadmin, async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT id, username, role FROM admins ORDER BY id');
    res.json(rows.map(r => ({ ...r, me: r.id === req.admin.id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/admins', adminAuth, requireSuperadmin, async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const role = req.body && req.body.role === 'superadmin' ? 'superadmin' : 'admin';
    if (username.length < 3 || password.length < 4) {
      return res.status(400).json({ error: 'Логин от 3 символов, пароль от 4 символов' });
    }
    try {
      const r = await db.runAsync('INSERT INTO admins (username, password, role) VALUES (?, ?, ?)', [username, password, role]);
      res.json({ success: true, id: r.lastID });
    } catch { res.status(400).json({ error: 'Такой логин уже существует' }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Свой пароль/логин может менять любой администратор — роль и чужие аккаунты
// правит только superadmin.
app.put('/api/admin/admins/:id', adminAuth, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT * FROM admins WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const isSuperadmin = (req.admin.role || 'admin') === 'superadmin';
    const isSelf = String(req.admin.id) === String(req.params.id);
    if (!isSuperadmin && !isSelf) return res.status(403).json({ error: 'Доступно только супер-администратору' });
    const username = String((req.body && req.body.username) || cur.username).trim() || cur.username;
    const password = String((req.body && req.body.password) || '') || cur.password;
    const role = isSuperadmin && req.body && req.body.role ? (req.body.role === 'superadmin' ? 'superadmin' : 'admin') : cur.role;
    try {
      await db.runAsync('UPDATE admins SET username = ?, password = ?, role = ? WHERE id = ?', [username, password, role, req.params.id]);
      res.json({ success: true });
    } catch { res.status(400).json({ error: 'Такой логин уже существует' }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/admins/:id', adminAuth, requireSuperadmin, async (req, res) => {
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

// ==================== ADMIN: СТАТИСТИКА ====================
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const isToday = req.query.days === '0';
    const days = isToday ? 0 : Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = isToday ? `datetime('now','start of day')` : `datetime('now','-${days} days')`;

    const totalViews = (await db.getAsync(
      `SELECT COUNT(*) AS c FROM stats_events WHERE type IN ('pageview','product_view') AND ts >= ${since}`
    )).c;

    const byDay = await db.allAsync(
      `SELECT substr(ts,1,10) AS date, COUNT(*) AS count
       FROM stats_events WHERE type IN ('pageview','product_view') AND ts >= ${since}
       GROUP BY date ORDER BY date`
    );

    const topSearches = await db.allAsync(
      `SELECT value, COUNT(*) AS count FROM stats_events
       WHERE type = 'search' AND ts >= ${since} AND value IS NOT NULL AND value != ''
       GROUP BY LOWER(value) ORDER BY count DESC LIMIT 30`
    );

    const topProducts = await db.allAsync(
      `SELECT s.ref_id, COUNT(*) AS count, p.name, p.icon
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type = 'product_view' AND s.ts >= ${since} AND s.ref_id IS NOT NULL
       GROUP BY s.ref_id ORDER BY count DESC LIMIT 30`
    );

    // Подробный список «когда и что смотрели» — последние события, самые свежие сверху
    const recentViews = await db.allAsync(
      `SELECT s.ts, s.type, s.path, s.ref_id, p.name AS product_name
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type IN ('pageview','product_view') AND s.ts >= ${since}
       ORDER BY s.id DESC LIMIT 200`
    );

    // Клики по кнопкам: подбор оборудования, запрос КП, звонок, WhatsApp
    const ctaRows = await db.allAsync(
      `SELECT value, COUNT(*) AS count FROM stats_events
       WHERE type = 'cta_click' AND ts >= ${since} GROUP BY value`
    );
    const ctaClicks = { quiz: 0, offer: 0, call: 0, whatsapp: 0 };
    ctaRows.forEach((r) => { if (r.value in ctaClicks) ctaClicks[r.value] = r.count; });

    // По какому товару чаще всего запрашивают КП / звонят / пишут в WhatsApp —
    // «Подбор оборудования» сюда не попадает, он не привязан к конкретному товару.
    const ctaByProductRows = await db.allAsync(
      `SELECT s.ref_id, s.value AS kind, COUNT(*) AS count, p.name, p.icon
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type = 'cta_click' AND s.ref_id IS NOT NULL AND s.ts >= ${since}
       GROUP BY s.ref_id, s.value`
    );
    const ctaByProductMap = {};
    ctaByProductRows.forEach((r) => {
      if (!ctaByProductMap[r.ref_id]) ctaByProductMap[r.ref_id] = { productId: r.ref_id, name: r.name, icon: r.icon, offer: 0, call: 0, whatsapp: 0 };
      if (r.kind in ctaByProductMap[r.ref_id]) ctaByProductMap[r.ref_id][r.kind] = r.count;
    });
    const ctaByProduct = Object.values(ctaByProductMap)
      .sort((a, b) => (b.offer + b.call + b.whatsapp) - (a.offer + a.call + a.whatsapp));

    res.json({ days, totalViews, byDay, topSearches, topProducts, recentViews, ctaClicks, ctaByProduct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN: ЖУРНАЛ ====================
// Журнал действий по конкретной заявке — для карточки заказа (не весь общий журнал).
app.get('/api/admin/orders/:id/log', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM admin_log WHERE order_id = ? ORDER BY id DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// То же самое для карточки клиента.
app.get('/api/admin/customers/:id/log', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM admin_log WHERE customer_id = ? ORDER BY id DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
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

// ==================== ADMIN: ОШИБКИ НА САЙТЕ ====================
app.get('/api/admin/errors', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 60);
    const total = (await db.getAsync(`SELECT COUNT(*) AS c FROM client_errors`)).c;
    const rows = await db.allAsync(
      `SELECT * FROM client_errors ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]
    );
    res.json({ total, page, limit, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/errors', adminAuth, async (req, res) => {
  try {
    await db.runAsync(`DELETE FROM client_errors`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN: ОТЗЫВЫ (товары + общие) ====================
app.get('/api/admin/reviews', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || '';
    const where = status ? 'WHERE r.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await db.allAsync(
      `SELECT r.*, p.name AS product_name FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
       ${where} ORDER BY r.id DESC LIMIT 300`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }
    await db.runAsync('UPDATE reviews SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN PRODUCTS ====================
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, category, subcategory } = req.query;
    const offset = (page - 1) * limit;
    let where = [];
    let params = [];
    if (search) {
      where.push('(p.name LIKE ? OR p.article LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (category) { where.push('p.category_id = ?'); params.push(Number(category)); }
    if (subcategory) {
      // Как на сайте: подкатегория показывает товары и из своих вложенных подкатегорий —
      // иначе порядок в админке управлял бы только частью того, что видно на странице.
      const idRows = await db.allAsync(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM subcategories WHERE id = ?
           UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
         ) SELECT id FROM tree`, [Number(subcategory)]);
      const ids = idRows.map(r => r.id);
      where.push('p.subcategory_id IN (' + (ids.length ? ids.map(() => '?').join(',') : 'NULL') + ')');
      params.push(...ids);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // Порядок перетаскиванием осмыслен только внутри одной подкатегории — там же
    // отдаём сразу все товары без постраничной разбивки, чтобы drag-and-drop видел весь список.
    const noPaging = !!subcategory;
    const countRow = await db.getAsync(`SELECT COUNT(*) as cnt FROM products p ${whereStr}`, params);
    const rows = await db.allAsync(
      `SELECT p.*, c.name as category_name, sc.name as subcategory_name FROM products p
       JOIN categories c ON p.category_id=c.id
       LEFT JOIN subcategories sc ON p.subcategory_id=sc.id
       ${whereStr} ORDER BY p.sort_order ASC, p.id DESC
       ${noPaging ? '' : 'LIMIT ? OFFSET ?'}`,
      noPaging ? params : [...params, Number(limit), Number(offset)]
    );
    res.json({ total: countRow.cnt, products: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Сохраняет порядок товаров после перетаскивания в админке — ids в нужном порядке.
app.put('/api/admin/products/reorder', adminAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    for (let i = 0; i < ids.length; i++) {
      await db.runAsync('UPDATE products SET sort_order = ? WHERE id = ?', [i, Number(ids[i])]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const rows = await db.allAsync(`SELECT id, name, article, brand, price FROM products ORDER BY name`);
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
    const { page = 1, limit = 30, status, search, sort } = req.query;
    const offset = (page - 1) * limit;
    const statuses = status ? String(status).split(',').filter(Boolean) : [];
    const clauses = [], params = [];
    if (statuses.length) { clauses.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    const q = String(search || '').trim();
    if (q) { clauses.push('(name LIKE ? OR phone LIKE ? OR company LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    // белый список колонок — sort приходит из URL, нельзя подставлять как есть в ORDER BY.
    // Формат: "колонка:направление,колонка2:направление2" — сортировка сразу по нескольким полям
    // (например, сначала по статусу, а внутри статуса — по дате), как в Excel/Google Таблицах.
    const SORT_COLS = { id: 'o.id', name: 'o.name', company: 'o.company', city: 'o.city',
      phone: 'o.phone', total: 'o.total', status: 'o.status', created_at: 'o.created_at' };
    const sortParts = String(sort || 'id:desc').split(',').map((s) => {
      const [col, dir] = s.split(':');
      const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      // сортировка «Примечание» — по дате напоминания; заявки без напоминания всегда
      // уходят в конец списка, независимо от направления, а не мешаются наверху из-за NULL
      if (col === 'reminder') return `(nextReminder IS NULL) ASC, nextReminder ${d}`;
      return SORT_COLS[col] ? `${SORT_COLS[col]} ${d}` : null;
    }).filter(Boolean);
    const orderBy = sortParts.length ? sortParts.join(', ') : 'o.id DESC';
    const countRow = await db.getAsync(`SELECT COUNT(*) as cnt FROM orders o ${where}`, params);
    const rows = await db.allAsync(
      `SELECT o.*, (SELECT COUNT(*) FROM order_notes n WHERE n.order_id = o.id) AS notesCount,
       (SELECT text FROM order_notes n WHERE n.order_id = o.id ORDER BY n.id DESC LIMIT 1) AS lastNote,
       (SELECT remind_at FROM order_notes n WHERE n.order_id = o.id ORDER BY n.id DESC LIMIT 1) AS nextReminder
       FROM orders o ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
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

// Менеджер сам создаёт заказ (звонок, оффлайн-клиент и т.п.) — та же таблица orders,
// source='manual' отличает его от заявок с сайта; без CRM/WhatsApp-уведомления — она и так знает.
app.post('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { name, phone, email, city, company, message, items, total } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Укажите имя и телефон' });
    let itemsStr = typeof items === 'string' ? items : JSON.stringify(items || []);
    let computedTotal = Number(total) || 0;
    if (!computedTotal) {
      try {
        const parsed = JSON.parse(itemsStr);
        computedTotal = parsed.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
      } catch {}
    }
    const result = await db.runAsync(
      `INSERT INTO orders (name, phone, email, city, company, message, items, total, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      [name, phone, email || '', city || '', company || '', message || '', itemsStr, computedTotal]
    );
    req._logOrderId = result.lastID;   // в URL id ещё нет — заявка только что создана
    res.json({ success: true, orderId: result.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Карточка заказа — сам заказ + история заказов этого же клиента (по телефону):
// сколько раз покупал и что именно, чтобы менеджер видел это с одного взгляда.
app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Не найдено' });
    const history = await db.allAsync(
      `SELECT id, items, total, status, created_at,
         COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = orders.id AND reason = 'order_earn'), 0) AS bonus_earned
       FROM orders WHERE ${phoneNormSql('phone')} = ${phoneNormSql('?')} AND id != ? ORDER BY id DESC`,
      [order.phone, order.id]
    );
    res.json({ order, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const name = String(req.body.name || '').trim() || cur.name;
    const phone = String(req.body.phone || '').trim() || cur.phone;
    const email = req.body.email != null ? String(req.body.email).trim() : cur.email;
    const city = req.body.city != null ? String(req.body.city).trim() : cur.city;
    const company = req.body.company != null ? String(req.body.company).trim() : cur.company;
    const message = req.body.message != null ? String(req.body.message).trim() : cur.message;
    const items = req.body.items != null ? JSON.stringify(req.body.items) : cur.items;
    const total = req.body.total != null ? (Number(req.body.total) || 0) : cur.total;
    await db.runAsync(
      'UPDATE orders SET name=?, phone=?, email=?, city=?, company=?, message=?, items=?, total=? WHERE id=?',
      [name, phone, email, city, company, message, items, total, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Лиды со скачивания КП (телефон подтверждён кодом, см. /api/kp/verify-code) —
// чтобы менеджер мог перезвонить, даже если клиент не оставил обычную заявку.
app.get('/api/admin/kp-leads', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const total = (await db.getAsync('SELECT COUNT(*) AS c FROM kp_leads')).c;
    const rows = await db.allAsync(
      `SELECT l.id, l.phone, l.created_at, p.id AS product_id, p.name AS product_name
       FROM kp_leads l JOIN products p ON p.id = l.product_id
       ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]
    );
    res.json({ total, leads: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Баланс бонусов клиента по телефону — для окна завершения заказа (только просмотр,
// без создания: заводится клиент только при реальном начислении, см. ниже).
app.get('/api/admin/customers', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const q = String(req.query.search || '').trim();
    const where = q ? 'WHERE (name LIKE ? OR phone LIKE ? OR email LIKE ?)' : '';
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const total = (await db.getAsync(`SELECT COUNT(*) AS c FROM customers ${where}`, params)).c;
    const rows = await db.allAsync(
      `SELECT c.*, (SELECT COUNT(*) FROM orders o
         WHERE ${phoneNormSql('o.phone')} = ${phoneNormSql('c.phone')}
       ) AS ordersCount
       FROM customers c ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, customers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Карточка клиента + все его заказы (по телефону, та же нормализация, что и в списке) —
// видно, что купил (статус «Выполнена»), что отменилось, что ещё в работе.
app.get('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Не найдено' });
    const orders = await db.allAsync(
      `SELECT id, items, total, status, created_at,
         COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = orders.id AND reason = 'order_earn'), 0) AS bonus_earned
       FROM orders
       WHERE ${phoneNormSql('phone')} = ${phoneNormSql('?')}
       ORDER BY id DESC`,
      [customer.phone]
    );
    res.json({ customer, orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const name = String(req.body.name || '').trim() || cur.name;
    const phone = req.body.phone != null ? String(req.body.phone).replace(/\D/g, '') || cur.phone : cur.phone;
    const email = req.body.email != null ? String(req.body.email).trim() : cur.email;
    const city = req.body.city != null ? String(req.body.city).trim() : cur.city;
    const company = req.body.company != null ? String(req.body.company).trim() : cur.company;
    // Бонусы клиента правит только superadmin — остальным поле в интерфейсе недоступно,
    // но на всякий случай проверяем и на сервере, а не только прячем в вёрстке.
    const isSuperadmin = (req.admin.role || 'admin') === 'superadmin';
    const bonusBalance = isSuperadmin && req.body.bonusBalance != null
      ? Math.max(0, Math.round(Number(req.body.bonusBalance) || 0)) : cur.bonus_balance;
    try {
      await db.runAsync('UPDATE customers SET name=?, phone=?, email=?, city=?, company=?, bonus_balance=? WHERE id=?', [name, phone, email, city, company, bonusBalance, req.params.id]);
    } catch { return res.status(400).json({ error: 'Клиент с таким телефоном уже есть' }); }
    const delta = bonusBalance - cur.bonus_balance;
    if (delta !== 0) {
      await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [req.params.id, delta, 'admin_adjust']);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Списание бонуса — только superadmin, отдельным явным действием (а не правкой числа
// в общей форме), чтобы в истории клиента было чётко видно, кто сколько списал и когда.
app.put('/api/admin/customers/:id/deduct-bonus', adminAuth, requireSuperadmin, async (req, res) => {
  try {
    const cur = await db.getAsync('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const amount = Math.round(Number(req.body && req.body.amount) || 0);
    if (amount <= 0) return res.status(400).json({ error: 'Укажите сумму больше нуля' });
    if (amount > cur.bonus_balance) return res.status(400).json({ error: 'Нельзя списать больше, чем есть у клиента' });
    const bonusBalance = cur.bonus_balance - amount;
    await db.runAsync('UPDATE customers SET bonus_balance = ? WHERE id = ?', [bonusBalance, req.params.id]);
    await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [req.params.id, -amount, 'admin_deduct']);
    req._logDeductAmount = amount;
    res.json({ success: true, bonusBalance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/customers/by-phone/:phone', adminAuth, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const c = await db.getAsync('SELECT id, name, phone, bonus_balance FROM customers WHERE phone = ?', [phone]);
    res.json({ customer: c ? { id: c.id, name: c.name, phone: c.phone, bonusBalance: c.bonus_balance } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Завершение заказа: менеджер подтверждает состав/сумму, по желанию начисляет бонус.
// Клиент с таким телефоном заводится в «Клиенты» при любом выполненном заказе (не
// только когда есть бонус) — чтобы в базе было видно всех реальных покупателей. Но
// registered_at у такой записи остаётся пустым (см. миграцию) — это НЕ регистрация,
// клиент сам ничего не подтверждал, просто купил. Отдельно от «зарегистрировался сам».
app.put('/api/admin/orders/:id/complete', adminAuth, async (req, res) => {
  try {
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Не найдено' });
    const items = req.body.items || [];
    const itemsStr = JSON.stringify(items);
    const total = Number(req.body.total) || 0;
    // Бонус начисляется всем админам, если бонусная программа включена — просто обычный
    // admin получает ровно автоматически посчитанный процент и не может его подправить
    // руками (это может только superadmin, передав своё значение bonusAward).
    const isSuperadmin = (req.admin.role || 'admin') === 'superadmin';
    const bonusCfg = (await getSettings()).bonus || {};
    const autoBonus = bonusCfg.enabled && bonusCfg.earn_percent ? Math.round(total * bonusCfg.earn_percent / 100) : 0;
    const bonusAward = isSuperadmin ? Math.max(0, Math.round(Number(req.body.bonusAward) || 0)) : autoBonus;
    req._logBonusAward = bonusAward;   // для журнала — реально применённая сумма, не то, что просто прислали

    await db.runAsync('UPDATE orders SET items=?, total=?, status=? WHERE id=?', [itemsStr, total, 'done', req.params.id]);

    const phone = String(order.phone || '').replace(/\D/g, '');
    let customer = phone ? await db.getAsync('SELECT * FROM customers WHERE phone = ?', [phone]) : null;
    if (!customer && phone) {
      const r = await db.runAsync('INSERT INTO customers (name, phone) VALUES (?, ?)', [order.name, phone]);
      customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [r.lastID]);
    }
    if (customer) req._logCustomerId = customer.id;   // чтобы это попало и в историю клиента

    let bonusBalance = customer ? customer.bonus_balance : null;
    if (bonusAward > 0 && customer) {
      await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [bonusAward, customer.id]);
      await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)', [customer.id, bonusAward, 'order_earn', order.id]);
      // Уведомление в личный кабинет — только зарегистрированным (иначе им негде его увидеть,
      // войти в аккаунт по этому номеру они не смогут). Бонус при этом всё равно начислен.
      if (customer.registered_at) {
        await notifyCustomer(customer.id, `Заказ №${order.id} выполнен. Вам начислено ${bonusAward} ₸ бонусами.`);
      }
      bonusBalance = customer.bonus_balance + bonusAward;
    }
    res.json({ success: true, bonusBalance, bonusAwarded: bonusAward });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Примечания к заказу (история обработки менеджерами) ----
app.get('/api/admin/orders/:id/notes', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT * FROM order_notes WHERE order_id = ? ORDER BY id', [req.params.id]);
    res.json({ notes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/orders/:id/notes', adminAuth, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустое примечание' });
    const remindAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body && req.body.remindAt) ? req.body.remindAt : null;
    await db.runAsync('INSERT INTO order_notes (order_id, admin, text, remind_at) VALUES (?, ?, ?, ?)', [req.params.id, req.admin.username, text, remindAt]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Фото профиля клиента (личный кабинет)
app.post('/api/me/avatar', customerAuth, mw(upload.single('avatar')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  await db.runAsync('UPDATE customers SET avatar = ? WHERE id = ?', ['/icons/' + req.file.filename, req.customer.id]);
  res.json({ avatar: '/icons/' + req.file.filename });
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
  let seoData = null;
  if (!isAdmin) {
    try { seoData = await seo.build(req, '/index.html', { softFallback: true }); }
    catch (e) { console.error('SEO build failed:', e.message); }
  }
  let html = renderPage(fs.readFileSync(file, 'utf8'), seoData && (seoData.view || '').toLowerCase());
  if (seoData) {
    try { html = seo.inject(html, seoData); }
    catch (e) { console.error('SEO inject failed:', e.message); }
  }
  const code = (isAdmin || req.path === '/') ? 200 : 404;
  res.status(code).type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`✅ SIGMA MARKET Shop запущен: http://localhost:${PORT}`);
  console.log(`🛠  Админ-панель: http://localhost:${PORT}/admin.html`);
});
