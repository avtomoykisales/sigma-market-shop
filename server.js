const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const db = require('./database');
const seo = require('./seo');
const bitrix = require('./bitrix');
const notify = require('./notify');
const auth = require('./auth');
const kp = require('./kp');
const crypto = require('crypto');
const { queryCategories, queryProducts, applyDiscount } = require('./queries');

// Страховка от падения всего сайта из-за одной необработанной ошибки в асинхронном
// коде (например, сбой посреди генерации PDF, когда ответ уже начал отправляться) —
// без этого Node сам завершает процесс, и сайт ложится для всех до перезапуска pm2.
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); });

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
const SPA_VIEWS = new Set(['home', 'catalog', 'product', 'notfound', 'articles', 'article']);
// Версия для ?v=... в ссылках на site.js/product.js/checkout.js/style.css — считается по
// дате изменения самих файлов, а не руками (раньше не раз забывали её поднять, и браузер
// после правок тихо отдавал старую версию из 30-дневного кэша). Меняется сама и сразу
// при следующей правке любого из этих файлов — перезапуск сервера не нужен.
function assetVersion() {
  try {
    const files = ['js/site.js', 'js/product.js', 'js/checkout.js', 'js/account.js', 'style.css'].map(f => path.join(PUBLIC_DIR, f));
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
  const hydrate = { categories: await queryCategories(), settings: await buildPublicSettings() };
  if (seoData.view === 'catalog' && !seoData.notFound) {
    const p = decodeURIComponent(req.path);
    const mc = p.match(/^\/catalog(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
    const catSlug = (mc && mc[1]) || 'all';
    const subSlug = (mc && mc[2]) || '';
    // limit должен совпадать с state.limit в public/index.html — иначе клиент решит,
    // что уже получил все товары (page*limit >= total), и не подгрузит остальное при скролле.
    hydrate.products = await queryProducts({
      category: catSlug, subcategory: subSlug, page: 1, limit: 48, sort: 'default', facets: '1'
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
// Фид товаров для Google Merchant Center — ссылку на этот адрес один раз указываете
// в самом Merchant Center (способ добавления фида: "По расписанию"/"Google Таблицы" не
// нужны, там есть вариант "Загрузить" с прямой ссылкой на файл).
app.get('/merchant-feed.xml', async (req, res) => {
  try { res.type('application/xml').send(await seo.merchantFeed(req)); }
  catch (e) { res.status(500).type('text/plain').send('merchant feed error'); }
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
  // ("/catalog/" с одним хвостовым слэшем и без категории — отдельный случай: [^/]+
  // требует хотя бы символ ПОСЛЕ слэша, которого тут нет, иначе отдавался 404).
  if (p === '/catalog' || p === '/catalog/' || /^\/catalog\/[^/]+/.test(p) || /^\/product\/\d/.test(p) ||
      p === '/articles' || p === '/articles/' || /^\/articles\/[^/]+/.test(p)) {
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

// Квитанции/чеки (напр. при списании бонуса клиенту, см. PUT .../deduct-bonus) — отдельная
// папка и фильтр: в отличие от ICONS_DIR сюда можно и PDF, это не витринные фото товара.
const RECEIPTS_DIR = path.join(__dirname, 'public/receipts');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
const receiptStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RECEIPTS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    cb(null, 'receipt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const uploadReceipt = multer({
  storage: receiptStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf')
});

// Вложения в чате (клиент ↔ админ, см. chat_messages.attachment) — картинки, PDF и
// документы Word, своя папка, та же схема именования, что у чеков.
const CHAT_DIR = path.join(__dirname, 'public/chat-uploads');
fs.mkdirSync(CHAT_DIR, { recursive: true });
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CHAT_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    cb(null, 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const uploadChat = multer({
  storage: chatStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null,
    /^image\//.test(file.mimetype) ||
    file.mimetype === 'application/pdf' ||
    file.mimetype === 'application/msword' ||
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
});

// Фото часто приходят с телефона/от поставщика в исходном разрешении (тысячи px,
// до нескольких МБ) — а на сайте показываются шириной 180-520px. Сжимаем сразу при
// загрузке: уменьшаем до разумного максимума и пережимаем с тем же форматом/именем
// файла (чтобы ничего не ломалось у уже сохранённых ссылок на него в товарах).
// SVG/GIF не трогаем — SVG уже компактный вектор, GIF может быть анимированным.
// BMP/TIFF — несжатые форматы (BMP на 2-3 МБ не редкость даже для небольшой фотки) —
// пережимаем в JPEG, оставляя то же имя файла (см. комментарий про PNG-как-.jpg ниже).
//
// Миниатюра (thumbPath) — отдельный файл "имя-thumb.ext" рядом с основным. В каталоге/
// квизе/похожих товарах карточка показывает фото шириной 180-250px — отдавать туда
// версию с максимумом 1200px (нужным для страницы товара, где фото открыто крупно)
// бессмысленно, браузер всё равно сжимает её на лету, но трафик уже потрачен.
function thumbPath(filePath) {
  const ext = path.extname(filePath);
  return filePath.slice(0, -ext.length) + '-thumb' + ext;
}
async function makeThumb(sharp, buffer, ext, filePath) {
  try {
    let t = sharp(buffer).resize({ width: 500, height: 500, fit: 'inside', withoutEnlargement: true });
    const tbuf = ext === '.png' ? await t.png({ compressionLevel: 9 }).toBuffer()
      : ext === '.webp' ? await t.webp({ quality: 80 }).toBuffer()
      : await t.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    fs.writeFileSync(thumbPath(filePath), tbuf);
  } catch (e) { /* миниатюра — бонус, без неё код выше просто покажет полный файл */ }
}
async function compressUploadedImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'].includes(ext)) return path.basename(filePath);
  try {
    const sharp = require('sharp');
    const before = fs.statSync(filePath).size;
    let img;
    if (ext === '.bmp') {
      // В отличие от TIFF, BMP sharp/libvips читать не умеет вовсе — распаковываем
      // через bmp-js и уже готовые пиксели отдаём в sharp как raw-буфер. У bmp-js
      // свой нестандартный порядок байт на пиксель: [A(всегда 0), B, G, R] — вместо
      // привычного RGBA, поэтому переставляем сами (и ставим альфу в 255 — у BMP
      // прозрачности не бывает, а 0 от bmp-js означает просто "не используется").
      try {
        const decoded = require('bmp-js').decode(fs.readFileSync(filePath));
        const raw = decoded.data;
        const rgba = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i += 4) {
          rgba[i] = raw[i + 3]; rgba[i + 1] = raw[i + 2]; rgba[i + 2] = raw[i + 1]; rgba[i + 3] = 255;
        }
        img = sharp(rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
      } catch (bmpErr) {
        // bmp-js понимает только простейший несжатый BMP — на RLE-сжатии и прочих
        // вариантах падает с "Invalid BMP File". Как и с PNG под видом .jpg — расширение
        // не гарантия формата: пробуем прочитать как обычную картинку (sharp сам
        // определит реальный формат по содержимому, не по имени файла).
        img = sharp(filePath).rotate();
      }
    } else {
      img = sharp(filePath).rotate(); // .rotate() без аргументов — авто-поворот по EXIF, и сам EXIF дальше не тащим
    }
    const meta = await img.metadata();
    if ((meta.width || 0) > 1200 || (meta.height || 0) > 1200) {
      img = img.resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true });
    }
    // Расширение файла не всегда совпадает с реальным форматом (попадаются PNG с
    // прозрачностью, сохранённые как .jpg) — ориентируемся на meta.hasAlpha, а не на
    // расширение: у JPEG (в отличие от PNG/WebP) нет альфа-канала, и если сжимать в
    // jpeg "как есть", прозрачный фон молча становится чёрным. Разворачиваем на белый —
    // такой же, как у карточек на сайте.
    const willBeJpeg = ext !== '.png' && ext !== '.webp';
    if (meta.hasAlpha && willBeJpeg) img = img.flatten({ background: '#ffffff' });
    const buffer = ext === '.png' ? await img.png({ compressionLevel: 9 }).toBuffer()
      : ext === '.webp' ? await img.webp({ quality: 82 }).toBuffer()
      : await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    // BMP/TIFF всегда попадают в ветку "сжать как JPEG" выше (willBeJpeg) — но до сих
    // пор файл оставался под старым именем/расширением (.bmp/.tiff), и сервер продолжал
    // отдавать его с Content-Type той же картинки, хотя внутри уже настоящий JPEG.
    // Браузеры обычно справляются (определяют формат по содержимому), но PageSpeed/
    // Lighthouse считает такой файл "неэффективным форматом" из-за расширения и
    // занижает оценку — раз уж перекодировали в JPEG, называем файл .jpg по-честному.
    if (willBeJpeg && ext !== '.jpg' && ext !== '.jpeg') {
      const jpgPath = filePath.slice(0, -ext.length) + '.jpg';
      fs.writeFileSync(jpgPath, buffer);
      fs.unlinkSync(filePath);
      await makeThumb(sharp, buffer, '.jpg', jpgPath);
      return path.basename(jpgPath);
    }
    // пережатая версия больше оригинала (бывает у уже маленьких картинок) — не перезаписываем
    if (buffer.length < before) fs.writeFileSync(filePath, buffer);
    await makeThumb(sharp, buffer, ext, filePath);
  } catch (e) { /* сжатие — бонус, не должно ломать саму загрузку файла */ }
  return path.basename(filePath);
}

// ==================== WHATSAPP WEBHOOK (Meta) ====================
// Приём входящих сообщений/статусов от WhatsApp Cloud API (developers.facebook.com →
// приложение → WhatsApp → Configuration → Webhooks). Verify Token — свой секрет,
// который Мира вводит в поле "Подтверждение маркера" там же (см. META_WA_VERIFY_TOKEN
// в deploy/ecosystem.config.js), никак не связан с самим Access Token'ом для отправки.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && process.env.META_WA_VERIFY_TOKEN && token === process.env.META_WA_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);   // подтверждаем приём сразу — Meta отключает webhook при таймаутах/ошибках
  try {
    const entries = (req.body && req.body.entry) || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const messages = (change.value && change.value.messages) || [];
        for (const msg of messages) {
          if (msg.type !== 'text') continue;
          const from = msg.from || '';
          const text = (msg.text && msg.text.body) || '';
          const notifyPhone = process.env.NOTIFY_PHONE;
          if (notifyPhone && text) {
            notify.sendWhatsAppTo(notifyPhone, `Входящее WhatsApp от +${from}:\n${text}`)
              .catch(e => notify.logFail('whatsapp_webhook_forward', e.message));
          }
        }
      }
    }
  } catch (e) {
    notify.logFail('whatsapp_webhook', e.message);
  }
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
// Та же форма, что отдаёт /api/settings — вынесено отдельно, чтобы buildHydrate()
// могла положить это же в window.__HYDRATE__ (см. ниже) и клиент не делал лишний
// round-trip за настройками при первом заходе (из-за этого на главной «прыгал» блок
// квиза — CLS: место под него не зарезервировано, пока не придёт /api/settings).
async function buildPublicSettings() {
  const s = await getSettings();
  return {
    blocks: s.blocks || {}, filters: s.filters || {},
    compare: s.compare !== false, favorites: s.favorites !== false,
    quiz: s.quiz || {}, contacts: s.contacts || {}, bonus: s.bonus || {}, kp: s.kp || {},
    // Сумма бонуса за отзыв — отдельный ключ настроек (не внутри bonus{}: админка там
    // сохраняет весь объект целиком, см. saveEngage(), ключ бы затирался). Редактируется
    // прямо в окне публикации отзыва (только superadmin), см. PUT /api/admin/reviews/:id.
    review_bonus_amount: Number(s.review_bonus_amount) || 500,
    // Только то, что безопасно отдавать на фронт — username публичный (виден всем в
    // Telegram), сам токен бота (TELEGRAM_BOT_TOKEN) остаётся только в окружении сервера.
    telegram: { enabled: !!(s.telegram && s.telegram.enabled), bot_username: (s.telegram && s.telegram.bot_username) || '' },
  };
}
app.get('/api/settings', async (req, res) => {
  try { res.json(await buildPublicSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== SUBCATEGORIES (public) ====================
app.get('/api/subcategories', async (req, res) => {
  try {
    let sql = `SELECT s.*, c.slug as category_slug,
                 (SELECT COUNT(DISTINCT pid) FROM (
                    SELECT id AS pid FROM products p WHERE p.subcategory_id = s.id
                    UNION
                    SELECT product_id AS pid FROM product_extra_categories WHERE subcategory_id = s.id
                  )) as product_count
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
    if (search) logStat('search', null, search, null, clientIp(req), req.headers['user-agent']);
    res.json(await queryProducts(req.query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Живые подсказки при наборе в поиске шапки — лёгкий ответ (без фасетов/пагинации), не
// логируем как полноценный поисковый запрос в статистику (иначе там будет запись на
// каждую напечатанную букву, см. logStat('search', ...) чуть выше).
app.get('/api/products/suggest', async (req, res) => {
  try {
    const search = String(req.query.q || '').trim();
    if (search.length < 2) return res.json([]);
    const { products } = await queryProducts({ search, limit: 6, page: 1 });
    res.json(products.map(p => ({
      id: p.id, name: p.name, icon: p.icon,
      price: p.price, price_on_request: p.price_on_request,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Подбор оборудования (квиз)
app.post('/api/products/quiz', async (req, res) => {
  try {
    const { biz, type, subtype } = req.body || {};
    const offset = Math.max(0, Number(req.body && req.body.offset) || 0);
    const PAGE_SIZE = 8;
    const s = await getSettings();
    const quiz = s.quiz || db.DEFAULT_QUIZ || {};
    const step = (key) => (quiz.steps || []).find(st => st.key === key);
    const bizStep = step('biz');
    const bizO = bizStep && (bizStep.options || []).find(o => o.id === biz);
    // "type" ветвится по "biz", "subtype" — по "type" (см. optionsByBranch в DEFAULT_QUIZ).
    // Третий шаг есть не у всех веток второго — там, где его нет в конфиге, subtypeO не
    // находится, и в дело идёт сам typeO (он там уже конечный, со своей subcategory).
    const typeStep = step('type');
    const typeOptions = (typeStep && typeStep.optionsByBranch && biz) ? (typeStep.optionsByBranch[biz] || []) : [];
    const typeO = typeOptions.find(o => o.id === type);
    const subtypeStep = step('subtype');
    const subtypeOptions = (subtypeStep && subtypeStep.optionsByBranch && type) ? (subtypeStep.optionsByBranch[type] || []) : [];
    const subtypeO = subtypeOptions.find(o => o.id === subtype);
    const effectiveO = subtypeO || typeO;

    // Раньше тут был фильтр "p.price_on_request = 0" — остался от шага с бюджетом,
    // которому нужна была реальная цена для сравнения. Бюджет убрали (см. DEFAULT_QUIZ),
    // а фильтр забыли — из-за него квиз показывал меньше товаров, чем есть в разделе на
    // сайте (напр. "Мойка с подогревом": 2 в квизе вместо 3 на /catalog, т.к. один товар
    // "по запросу"). В каталоге такие товары не прячут, просто пишут "Цена по запросу" —
    // здесь должно быть так же.
    let where = [];
    let params = [];
    // Та же "мягкая" проверка категории, что и в обычном каталоге (см. queries.js) — через
    // ИЛИ с дополнительной привязкой (product_extra_categories). Без неё товар, у которого
    // "родная" категория — Автомойка, а в Клининг он виден только как доп. привязка (как
    // раз случай "Пылесосы" под Клинингом — они физически заведены под Автомойкой), не
    // находился: строгое "c.slug = 'klining'" проверяет только родную категорию товара.
    if (bizO && bizO.category) {
      where.push(`(c.slug = ? OR p.id IN (
        SELECT pec.product_id FROM product_extra_categories pec
        JOIN categories ec ON pec.category_id = ec.id WHERE ec.slug = ?
      ))`);
      params.push(bizO.category, bizO.category);
    }

    const subcatTreeIds = async (slug) => {
      const idRows = await db.allAsync(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM subcategories WHERE slug = ?
           UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
         ) SELECT id FROM tree`, [slug]);
      return idRows.map(r => r.id);
    };

    let products, totalCnt, hasMore;

    if (effectiveO && (effectiveO.specKey || effectiveO.nameKeyword)) {
      // Характеристика (значения в JSON текстовые и у всех по-разному, напр. "1300 кв.
      // м/час") и поиск по слову в названии — оба фильтруются в JS, не SQL: у характеристик
      // нет единого формата для сравнения в запросе, а SQLite LIKE для кириллицы регистро-
      // зависим ("Бензин" не совпадёт с '%бензин%') — JS-овский toLowerCase() с этим
      // справляется правильно. Для specKey намеренно БЕЗ отката на более широкую выдачу:
      // нет характеристики — товар не показываем, не выдумываем число за него (см.
      // комментарий у "subtype" в DEFAULT_QUIZ).
      const ids = await subcatTreeIds(effectiveO.scopeSubcategory);
      let rows = [];
      if (ids.length) {
        const inList = ids.map(() => '?').join(',');
        rows = await db.allAsync(
          `SELECT * FROM products WHERE subcategory_id IN (${inList})`, ids);
      }
      const matched = rows.filter(p => {
        if (effectiveO.nameKeyword) {
          return String(p.name || '').toLowerCase().includes(effectiveO.nameKeyword.toLowerCase());
        }
        let specs = {}; try { specs = JSON.parse(p.specs || '{}'); } catch {}
        const raw = specs[effectiveO.specKey];
        const m = raw && String(raw).match(/[\d.]+/);
        if (!m) return false;
        const val = parseFloat(m[0]);
        if (effectiveO.specMin != null && val < effectiveO.specMin) return false;
        if (effectiveO.specMax != null && val > effectiveO.specMax) return false;
        return true;
      });
      // Как в каталоге: товары со значком ("Хит продаж" и т.п.) — в начале списка.
      const isFeatured = p => p.featured && p.featured !== '[]';
      matched.sort((a, b) => (isFeatured(b) - isFeatured(a)) || (a.sort_order - b.sort_order) || (b.id - a.id));
      totalCnt = matched.length;
      const pageIds = matched.slice(offset, offset + PAGE_SIZE).map(p => p.id);
      products = pageIds.length ? await db.allAsync(
        `SELECT p.*, c.name as category_name, c.slug as category_slug FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.id IN (${pageIds.map(() => '?').join(',')})`, pageIds) : [];
      const orderIdx = new Map(pageIds.map((id, i) => [id, i]));
      products.sort((a, b) => orderIdx.get(a.id) - orderIdx.get(b.id));
      hasMore = offset + products.length < totalCnt;
    } else {
      // Подкатегория может быть вложенной (напр. "Пылеводососы" внутри "Пылесосы"), поэтому
      // матчим по всему поддереву, как и в обычном каталоге — и заодно учитываем товары,
      // привязанные к ней как к дополнительной категории (product_extra_categories).
      let subW = [], subP = [];
      if (effectiveO && effectiveO.subcategory) {
        const ids = await subcatTreeIds(effectiveO.subcategory);
        if (ids.length) {
          const inList = ids.map(() => '?').join(',');
          subW.push(`(p.subcategory_id IN (${inList}) OR p.id IN (
            SELECT product_id FROM product_extra_categories WHERE subcategory_id IN (${inList})
          ))`);
          subP.push(...ids, ...ids);
        }
      } else if (effectiveO && effectiveO.nameKeyword) {
        // Нет отдельной подкатегории под это (напр. "автономные/бензиновые" у АВД) —
        // ищем по слову в названии, в пределах родительской подкатегории.
        const ids = await subcatTreeIds(effectiveO.scopeSubcategory);
        if (ids.length) {
          const inList = ids.map(() => '?').join(',');
          subW.push(`p.subcategory_id IN (${inList}) AND p.name LIKE ?`);
          subP.push(...ids, '%' + effectiveO.nameKeyword + '%');
        }
      }

      // Без бюджета как фильтра нечего "ослаблять" постранично — вместо этого решаем один
      // раз, по какому набору условий вообще штатно пагинируем — по точному совпадению или
      // по всей категории. Порог — "хотя бы 1": даже единственный точный результат честнее
      // и полезнее, чем десятки случайных из всей категории ради круглого числа (напр. у
      // "Промышленный пылесос" всего 1 реальный товар — лучше показать его одного, чем
      // вперемешку с пеногенераторами). Широкая категория — только если совпадений вообще нет.
      const whereNarrow = where.concat(subW).join(' AND ');
      const countRow = await db.getAsync(
        `SELECT COUNT(*) as cnt FROM products p JOIN categories c ON p.category_id=c.id WHERE ${whereNarrow}`,
        params.concat(subP));
      const useNarrow = countRow.cnt >= 1;
      const finalWhere = useNarrow ? whereNarrow : where.join(' AND ');
      const finalParams = useNarrow ? params.concat(subP) : params;
      const totalRow = useNarrow ? countRow : await db.getAsync(
        `SELECT COUNT(*) as cnt FROM products p JOIN categories c ON p.category_id=c.id WHERE ${finalWhere}`, finalParams);

      products = await db.allAsync(
        `SELECT p.*, c.name as category_name, c.slug as category_slug
         FROM products p JOIN categories c ON p.category_id=c.id
         WHERE ${finalWhere} ORDER BY (p.featured IS NOT NULL AND p.featured != '[]') DESC, p.sort_order ASC, p.id DESC LIMIT ? OFFSET ?`,
        finalParams.concat([PAGE_SIZE, offset]));
      totalCnt = totalRow.cnt;
      hasMore = offset + products.length < totalCnt;
    }

    res.json({
      products, criteria: { biz: bizO, type: typeO, subtype: subtypeO },
      total: totalCnt, hasMore,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await db.getAsync(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              sc.name as subcategory_name, sc.slug as subcategory_slug
       FROM products p JOIN categories c ON p.category_id = c.id
       LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
       WHERE p.id = ? AND p.published = 1`,
      [req.params.id]
    );

    if (!product) return res.status(404).json({ error: 'Товар не найден' });
    if (product.specs) { try { product.specs = JSON.parse(product.specs); } catch {} }
    applyDiscount(product);

    // готовые SEO-мета (единый источник — seo.js); клиент их берёт при SPA-навигации
    product.seo = seo.productMeta(product);

    // Категории, где товар виден дополнительно к своей основной (canonical) — см.
    // product_extra_categories. Нужно только для формы редактирования в админке.
    product.extra_categories = await db.allAsync(
      'SELECT category_id, subcategory_id FROM product_extra_categories WHERE product_id = ?', [product.id]);

    // Галерея: главное изображение (icon) + дополнительные (images), без дублей
    let extra = [];
    try { extra = JSON.parse(product.images || '[]'); } catch {}
    product.gallery = [...new Set([product.icon, ...extra].filter(Boolean))];

    const s = await getSettings();
    const blocks = s.blocks || {};
    const briefCols = `p.id, p.name, p.slug, p.article, p.brand, p.price, p.price_on_request, p.icon,
                       p.subtype, p.perf, p.perf_unit, p.discount_percent, p.discount_until, p.discount_price, c.slug as category_slug`;
    const byIds = async (raw) => {
      let ids = []; try { ids = JSON.parse(raw || '[]'); } catch {}
      ids = ids.filter(Boolean).slice(0, 8);
      if (!ids.length) return [];
      const rows = await db.allAsync(
        `SELECT ${briefCols} FROM products p JOIN categories c ON p.category_id=c.id
         WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.published = 1`, ids);
      rows.forEach(applyDiscount);
      return ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
    };

    // similar-блок ищет по уже уценённой цене product.price (видна покупателю), поэтому
    // диапазон считается от неё же — иначе товар со скидкой мог бы не найти похожие рядом.
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
         ORDER BY (p.featured IS NOT NULL AND p.featured != '[]') DESC, ABS(COALESCE(p.perf,0) - ?) ASC, p.id LIMIT 4`,
        product.price ? [product.category_id, product.id, lo, hi, product.perf || 0]
                      : [product.category_id, product.id, product.perf || 0]);
      product.similar.forEach(applyDiscount);
    }
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== СТАТЬИ (публичные) ====================
app.get('/api/articles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 20));
    const total = (await db.getAsync('SELECT COUNT(*) as n FROM articles WHERE published = 1')).n;
    const rows = await db.allAsync(
      'SELECT id, title, slug, excerpt, cover, created_at FROM articles WHERE published = 1 ORDER BY id DESC LIMIT ? OFFSET ?',
      [limit, (page - 1) * limit]);
    res.json({ rows, total, page, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/articles/:slug', async (req, res) => {
  try {
    const a = await db.getAsync('SELECT * FROM articles WHERE slug = ? AND published = 1', [req.params.slug]);
    if (!a) return res.status(404).json({ error: 'Статья не найдена' });
    a.seo = seo.articleMeta(a);
    res.json(a);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== КОММЕНТАРИИ К СТАТЬЯМ ====================
app.get('/api/articles/:id/comments', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT id, name, text, reply, created_at FROM article_comments
       WHERE article_id = ? AND status = 'approved' ORDER BY id DESC`,
      [req.params.id]
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/articles/:id/comments', async (req, res) => {
  try {
    const articleId = Number(req.params.id);
    const article = await db.getAsync('SELECT id FROM articles WHERE id = ?', [articleId]);
    if (!article) return res.status(404).json({ error: 'Статья не найдена' });

    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!name || !text) return res.status(400).json({ error: 'Укажите имя и текст комментария' });
    await db.runAsync(
      `INSERT INTO article_comments (article_id, name, text) VALUES (?,?,?)`,
      [articleId, name, text]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== СКАЧИВАНИЕ КП (мгновенно, по номеру телефона) ====================
// Включается в админке → Вовлечённость → КП («Мгновенное скачивание»). Пока выключено —
// кнопка на сайте работает как раньше, через обычную заявку (requestModal), сюда не попадает.
// Без кода подтверждения — SMS/WhatsApp стоят денег за каждое сообщение, а тут просто лид.
app.post('/api/kp/download', async (req, res) => {
  try {
    // Та же ловушка, что и в форме заказа — см. #kpWebsite в header.html.
    if (req.body && req.body.website) {
      logHoneypot(req, 'kp');
      return res.status(400).json({ error: 'Некорректный номер телефона' });
    }
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (!/^[78]\d{10}$/.test(phone)) return res.status(400).json({ error: 'Некорректный номер телефона' });
    const productId = Number(req.body && req.body.productId);
    const product = await db.getAsync('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) return res.status(404).json({ error: 'Товар не найден' });

    // На мобильной сети соединение иногда рвётся уже ПОСЛЕ того, как сервер успел
    // записать лид, но ДО того как клиент получил PDF — человек видит "Ошибка сети" и
    // жмёт кнопку ещё раз, а лид на самом деле уже был записан. Чтобы не плодить дубли
    // одного и того же обращения, не создаём новую запись, если такой же телефон уже
    // скачивал КП по этому товару в последние 10 минут — просто отдаём PDF повторно.
    const recentDup = await db.getAsync(
      `SELECT id FROM kp_leads WHERE product_id = ? AND phone = ? AND created_at >= datetime('now', '-10 minutes')`,
      [productId, phone]
    );
    if (!recentDup) await db.runAsync('INSERT INTO kp_leads (product_id, phone) VALUES (?, ?)', [productId, phone]);
    const s = await getSettings();
    await kp.buildProductKpPdf(res, product, s.kp || {});
  } catch (e) {
    console.error('kp/download:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end();
  }
});

// ==================== ОТЗЫВЫ НА ТОВАРЫ ====================
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT id, name, rating, text, reply, created_at FROM reviews
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

    // Отзыв можно оставить только вошедшим в аккаунт — форма на фронте уже это требует
    // (см. loadProductReviews в product.js), здесь проверяем на случай прямого запроса
    // в обход интерфейса.
    const customer = await getCustomerByToken(req);
    if (!customer) return res.status(401).json({ error: 'Войдите в аккаунт, чтобы оставить отзыв' });

    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const rating = Math.round(Number(req.body && req.body.rating));
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!name || !(rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'Укажите имя и оценку от 1 до 5' });
    }
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
      `SELECT id, name, company, rating, text, reply, created_at FROM reviews
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
// Варианты способа оплаты на шаге оформления заказа в корзине — публичный чекаут
// не проводит настоящую онлайн-оплату (каталог с индивидуальным расчётом цены), но должен
// быть полноценным оформлением заказа с явным выбором способа оплаты и доставки, а не просто
// формой "оставьте телефон" — см. public/index.html #cartPanel .order-form.
const CHECKOUT_PAYMENT_METHODS = ['Оплата по счёту (для юр. лиц)', 'POS-Терминал(Visa/MasterCard) или QR', 'Наличными'];
const CHECKOUT_DELIVERY_METHODS = ['Доставка по Казахстану', 'Самовывоз'];
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, email, city, message, items } = req.body;
    const paymentMethod = CHECKOUT_PAYMENT_METHODS.includes(req.body.paymentMethod) ? req.body.paymentMethod : CHECKOUT_PAYMENT_METHODS[0];
    const deliveryMethod = CHECKOUT_DELIVERY_METHODS.includes(req.body.deliveryMethod) ? req.body.deliveryMethod : CHECKOUT_DELIVERY_METHODS[0];
    // Антибот: скрытое поле "website" реальный человек не видит и не заполняет — его
    // трогают только боты, читающие форму по коду страницы (см. #oWebsite в index.html).
    // Ответ намеренно такой же, как у обычной валидации — чтобы по тексту ошибки нельзя
    // было понять, что сработала именно ловушка.
    // Проверку "слишком быстро заполнили" убрали — автозаполнение браузера подставляет
    // имя/телефон мгновенно, и живого клиента с автозаполнением она бы тоже отклоняла.
    if (req.body.website) {
      logHoneypot(req, 'orders');
      return res.status(400).json({ error: 'Заполните обязательные поля' });
    }
    // Антиспам от ботов, бьющих ПРЯМО в этот API (минуя форму и ловушку website выше —
    // та спасает только от ботов, читающих HTML-страницу): не больше 5 заказов с одного
    // IP за 15 минут. Живой клиент столько заказов подряд не оформит, а флуд-бот — обрежет.
    const reqIp = clientIp(req);
    const recentFromIp = (await db.getAsync(
      `SELECT COUNT(*) AS c FROM orders WHERE ip = ? AND created_at >= datetime('now', '-15 minutes')`, [reqIp]
    )).c;
    if (recentFromIp >= 5) {
      db.runAsync(
        `INSERT INTO client_errors (message, context, url, ip) VALUES (?,?,?,?)`,
        [`Превышен лимит заказов с одного IP (${recentFromIp} за 15 минут)`, 'orders_rate_limit', req.originalUrl || '', reqIp]
      ).catch(() => {});
      return res.status(429).json({ error: 'Слишком много заказов подряд. Попробуйте позже.' });
    }
    if (!name || !phone || !items) {
      return res.status(400).json({ error: 'Заполните обязательные поля' });
    }
    if (!/^[78]\d{10}$/.test(String(phone).replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'Некорректный номер телефона' });
    }

    let itemsStr = typeof items === 'string' ? items : JSON.stringify(items);
    let total = 0;
    let parsedItems = [];
    try { parsedItems = JSON.parse(itemsStr); } catch {}
    // "items" строкой "[]" (пустая корзина) проходит мимо "!items" выше — она ведь
    // непустая строка. Проверяем именно количество товаров, не сам факт наличия поля.
    if (!Array.isArray(parsedItems) || !parsedItems.length) {
      return res.status(400).json({ error: 'Добавьте товар в корзину' });
    }
    // На сайте кол-во в корзине ограничено 20 (см. changeQty в index.html) — тот же
    // предел тут, на случай прямого запроса в обход интерфейса. Без него количество
    // можно было отправить любым, вплоть до абсурдных заказов на десятки миллионов ₸
    // от одного клика — это не настоящий опт, а либо ошибка, либо мусорная заявка;
    // для реального опта есть разговор с менеджером, не самостоятельное оформление.
    parsedItems.forEach(item => { item.qty = Math.min(20, Math.max(1, Number(item.qty) || 1)); });
    itemsStr = JSON.stringify(parsedItems);
    total = parsedItems.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);

    // Бонусы: если оформляет вошедший клиент, уменьшаем сумму к оплате на запрошенную
    // сумму (не больше остатка и не больше суммы заказа) прямо сейчас — это то, сколько
    // клиент реально должен заплатить. Но со счёта клиента её пока НЕ списываем (см.
    // bonus_requested в database.js) — реальное списание и уведомление об этом будет
    // только когда заказ подтвердят выполненным (см. /api/admin/orders/:id/complete):
    // если заказ отменят, бонус останется нетронутым, его не придётся вручную возвращать.
    const customer = await getCustomerByToken(req);
    const s = await getSettings();
    const bonusCfg = s.bonus || {};
    let usedBonus = 0;
    if (customer && bonusCfg.enabled) {
      usedBonus = Math.max(0, Math.min(Number(req.body.useBonus) || 0, customer.bonus_balance, total));
      if (usedBonus > 0) total -= usedBonus;
    }

    const result = await db.runAsync(
      `INSERT INTO orders (name, phone, email, city, message, items, total, customer_id, ip, payment_method, delivery_method, bonus_requested)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, phone, email || '', city || '', message || '', itemsStr, total, customer ? customer.id : null, clientIp(req), paymentMethod, deliveryMethod, usedBonus]
    );

    // Бонус за заказ начисляется НЕ здесь — только когда заказ подтверждён менеджером
    // (см. /api/admin/orders/:id/complete). Раньше начислялся сразу тут и ЕЩЁ РАЗ при
    // завершении заказа — клиент получал бонус дважды за один и тот же заказ.

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
      notify.notifyOrder({ id: result.lastID, name, phone, email, city, message, items: itemsStr, total, paymentMethod, deliveryMethod })
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
    const ref = String((req.body && req.body.ref) || '').slice(0, 500);
    const entryQuery = String((req.body && req.body.entryQuery) || '').slice(0, 500);
    if (path) logStat(type, path, null, refId, clientIp(req), req.headers['user-agent'], ref, entryQuery);
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
    const phone = String((req.body && req.body.phone) || '').slice(0, 40);
    if (CTA_KINDS.has(kind)) logStat('cta_click', path, kind, productId, clientIp(req), req.headers['user-agent'], null, null, phone);
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
  // Телефон-заглушка у клиентов, вошедших через Telegram и ещё не указавших настоящий
  // (см. 'tg_' + telegramId в /api/auth/telegram/callback) — на фронте показываем как
  // "не указан", а не саму заглушку.
  const phone = /^tg_/.test(c.phone || '') ? '' : c.phone;
  return { id: c.id, clientNo: c.client_no, name: c.name, phone, email: c.email, company: c.company || '', corpPhone: c.corp_phone || '', extraPhone: c.extra_phone || '', bonusBalance: c.bonus_balance, avatar: c.avatar || null };
}
// Следующий свободный "номер клиента" (видимый в админке/личном кабинете вместо
// внутреннего id, см. миграцию client_no в database.js) — просто MAX+1, с нижней
// границей 2261 на случай, если бэкфилл почему-то ещё не отработал.
async function nextClientNo() {
  const row = await db.getAsync('SELECT MAX(client_no) AS m FROM customers');
  return Math.max(2261, (row.m || 0) + 1);
}
// Уведомление в личный кабинет клиента («Мои уведомления») — сейчас используется для
// начисления бонуса при регистрации и при выполнении заказа.
async function notifyCustomer(customerId, message) {
  try { await db.runAsync('INSERT INTO notifications (customer_id, message) VALUES (?, ?)', [customerId, message]); }
  catch (e) { /* уведомление не должно ломать основной запрос */ }
}

// Начисление бонуса за регистрацию + уведомление в личный кабинет — общее для email- и
// Telegram-регистрации (раньше было только в одном месте, см. старый /api/auth/verify-code).
async function awardRegisterBonus(customerId) {
  const s = await getSettings();
  const bonusCfg = s.bonus || {};
  if (bonusCfg.enabled && bonusCfg.register_bonus > 0) {
    await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [bonusCfg.register_bonus, customerId]);
    await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [customerId, bonusCfg.register_bonus, 'register']);
    await notifyCustomer(customerId, `Добро пожаловать в SIGMA MARKET! Вам начислено ${bonusCfg.register_bonus} ₸ бонусами за регистрацию.`);
  }
}
async function issueSession(customerId) {
  const token = crypto.randomBytes(24).toString('base64url');
  await db.runAsync('INSERT INTO customer_sessions (token, customer_id) VALUES (?, ?)', [token, customerId]);
  return token;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Шаг 1: ввели email. Уже зарегистрирован (есть пароль) — просим сразу пароль, без кода.
// Новый — шлём код на почту для подтверждения перед тем, как дать задать пароль.
app.post('/api/auth/email/request-code', async (req, res) => {
  try {
    // Та же ловушка, что в форме заказа — см. #accWebsite в header.html.
    if (req.body && req.body.website) { logHoneypot(req, 'email_code'); return res.status(400).json({ error: 'Некорректный email' }); }
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    const existing = await db.getAsync('SELECT id, password_hash FROM customers WHERE email = ?', [email]);
    if (existing && existing.password_hash) return res.json({ needPassword: true });
    await auth.requestEmailCode(email);
    res.json({ sent: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Шаг 2: код подтверждён → одноразовый regToken на шаг "телефон + пароль" (чтобы не
// слать код ещё раз).
app.post('/api/auth/email/verify-code', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'Укажите email и код' });
    const regToken = await auth.verifyEmailCode(email, code);
    res.json({ regToken });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Шаг 3: телефон (для бонусов — они начисляются именно по номеру) + пароль → аккаунт создан.
app.post('/api/auth/email/complete-registration', async (req, res) => {
  try {
    if (req.body && req.body.website) { logHoneypot(req, 'email_register'); return res.status(400).json({ error: 'Заполните обязательные поля' }); }
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const regToken = String((req.body && req.body.regToken) || '').trim();
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const password = String((req.body && req.body.password) || '');
    if (!/^[78]\d{10}$/.test(phone)) return res.status(400).json({ error: 'Некорректный номер телефона' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    await auth.consumeRegToken(email, regToken);

    const passwordHash = auth.hashPassword(password);
    // На этот телефон уже могла быть запись (гость оформлял заказ, бонус начислился
    // автоматически) — довершаем её email/паролем вместо дубликата. Бонус за
    // регистрацию в этом случае не положен — как и раньше для "доросших" до
    // регистрации гостевых записей (см. старый /api/auth/verify-code).
    let customer = await db.getAsync('SELECT * FROM customers WHERE phone = ?', [phone]);
    const isNew = !customer;
    if (customer) {
      if (customer.password_hash) return res.status(400).json({ error: 'Этот номер телефона уже привязан к другому аккаунту' });
      await db.runAsync(`UPDATE customers SET email = ?, password_hash = ?, registered_at = COALESCE(registered_at, datetime('now')) WHERE id = ?`, [email, passwordHash, customer.id]);
    } else {
      const name = email.split('@')[0];
      const r = await db.runAsync(`INSERT INTO customers (name, phone, email, password_hash, registered_at, client_no) VALUES (?, ?, ?, ?, datetime('now'), ?)`, [name, phone, email, passwordHash, await nextClientNo()]);
      customer = { id: r.lastID };
    }
    if (isNew) await awardRegisterBonus(customer.id);
    customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [customer.id]);
    const token = await issueSession(customer.id);
    res.json({ token, customer: customerPublic(customer), isNew });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Забыли пароль: шлём код на email уже зарегистрированного клиента (в отличие от
// request-code на шаге входа, здесь код нужен именно для сброса, а не "нет пароля").
app.post('/api/auth/email/request-reset-code', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    const existing = await db.getAsync('SELECT id FROM customers WHERE email = ? AND password_hash IS NOT NULL', [email]);
    if (!existing) return res.status(400).json({ error: 'Аккаунт с таким email не найден' });
    await auth.requestEmailCode(email);
    res.json({ sent: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Код подтверждён (тем же /api/auth/email/verify-code) → задаём новый пароль по regToken.
app.post('/api/auth/email/reset-password', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const regToken = String((req.body && req.body.regToken) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    await auth.consumeRegToken(email, regToken);
    const customer = await db.getAsync('SELECT * FROM customers WHERE email = ?', [email]);
    if (!customer) return res.status(400).json({ error: 'Аккаунт с таким email не найден' });
    await db.runAsync('UPDATE customers SET password_hash = ? WHERE id = ?', [auth.hashPassword(password), customer.id]);
    const token = await issueSession(customer.id);
    res.json({ token, customer: customerPublic(customer), isNew: false });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Обычный вход для уже зарегистрированных по email.
app.post('/api/auth/email/login', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const customer = await db.getAsync('SELECT * FROM customers WHERE email = ?', [email]);
    if (!customer || !auth.verifyPassword(password, customer.password_hash)) {
      return res.status(400).json({ error: 'Неверный email или пароль' });
    }
    const token = await issueSession(customer.id);
    res.json({ token, customer: customerPublic(customer), isNew: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Telegram Login Widget (https://core.telegram.org/widgets/login) ----
// Токен бота — TELEGRAM_BOT_TOKEN в deploy/ecosystem.config.js, как и META_WA_TOKEN;
// username бота — в настройках админки (Вовлечённость → Вход клиентов), публичный,
// нужен виджету на фронте. Пока бот не создан — просто вернёт понятную ошибку.
app.post('/api/auth/telegram/callback', async (req, res) => {
  try {
    const data = req.body || {};
    auth.verifyTelegramAuth(data, process.env.TELEGRAM_BOT_TOKEN);
    const telegramId = String(data.id);
    let customer = await db.getAsync('SELECT * FROM customers WHERE telegram_id = ?', [telegramId]);
    let isNew = false;
    if (!customer) {
      const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || 'Клиент Telegram';
      // Настоящий телефон ещё не известен — временная уникальная заглушка (нужна из-за
      // NOT NULL UNIQUE на phone), донесём его отдельным шагом сразу после входа (needPhone).
      const r = await db.runAsync(`INSERT INTO customers (name, phone, telegram_id, registered_at, client_no) VALUES (?, ?, ?, datetime('now'), ?)`, [name, 'tg_' + telegramId, telegramId, await nextClientNo()]);
      isNew = true;
      customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [r.lastID]);
      await awardRegisterBonus(customer.id);
    }
    const token = await issueSession(customer.id);
    res.json({ token, customer: customerPublic(customer), isNew, needPhone: /^tg_/.test(customer.phone) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// После входа через Telegram без телефона — донести настоящий номер (для бонусов,
// они начисляются именно по нему).
app.post('/api/me/phone', customerAuth, async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (!/^[78]\d{10}$/.test(phone)) return res.status(400).json({ error: 'Некорректный номер телефона' });
    const existing = await db.getAsync('SELECT id FROM customers WHERE phone = ? AND id != ?', [phone, req.customer.id]);
    if (existing) return res.status(400).json({ error: 'Этот номер уже используется другим аккаунтом' });
    await db.runAsync('UPDATE customers SET phone = ? WHERE id = ?', [phone, req.customer.id]);
    res.json({ success: true });
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
  // Корпоративный и доп. номер — просто ещё одни контакты клиента, не для входа, без
  // проверки на уникальность/занятость (в отличие от основного телефона в /api/me/phone).
  const corpPhone = String((req.body && req.body.corpPhone) || '').replace(/\D/g, '').slice(0, 15);
  const extraPhone = String((req.body && req.body.extraPhone) || '').replace(/\D/g, '').slice(0, 15);
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  await db.runAsync('UPDATE customers SET name = ?, email = ?, company = ?, corp_phone = ?, extra_phone = ? WHERE id = ?', [name, email, company, corpPhone, extraPhone, req.customer.id]);
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
    `SELECT r.id, r.rating, r.text, r.reply, r.status, r.created_at, r.product_id, p.name AS product_name
     FROM reviews r LEFT JOIN products p ON p.id = r.product_id
     WHERE r.customer_id = ? ORDER BY r.id DESC LIMIT 50`,
    [req.customer.id]
  );
  res.json({ reviews: rows });
});

// Товары из выполненных заказов клиента, на которые он ещё не оставил отзыв — карточки
// с кнопкой "Оставить отзыв" на вкладке "Мои отзывы" (см. acctReviewPrompts в account.js).
// Берём актуальные название/фото/цену из products (а не из снимка в orders.items —
// он мог устареть), поэтому отдельный запрос, а не просто поле из /api/me/orders.
app.get('/api/me/review-prompts', customerAuth, async (req, res) => {
  try {
    const orders = await db.allAsync(
      `SELECT items FROM orders WHERE (customer_id = ? OR ${phoneNormSql('phone')} = ${phoneNormSql('?')}) AND status = 'done'`,
      [req.customer.id, req.customer.phone]
    );
    const ids = new Set();
    orders.forEach(o => {
      let items = [];
      try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []); } catch {}
      items.forEach(i => { if (i && i.id) ids.add(Number(i.id)); });
    });
    if (!ids.size) return res.json({ products: [] });
    const reviewed = await db.allAsync(
      `SELECT DISTINCT product_id FROM reviews WHERE customer_id = ? AND product_id IS NOT NULL`,
      [req.customer.id]
    );
    reviewed.forEach(r => ids.delete(r.product_id));
    if (!ids.size) return res.json({ products: [] });
    const idList = Array.from(ids);
    const rows = await db.allAsync(
      `SELECT id, name, icon, price, price_on_request FROM products WHERE id IN (${idList.map(() => '?').join(',')})`,
      idList
    );
    res.json({ products: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me/notifications', customerAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT id, message, created_at, read_at FROM notifications WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
    [req.customer.id]
  );
  res.json({ notifications: rows });
});
// Отмечаем все уведомления прочитанными — зовётся при открытии вкладки "Мои
// уведомления" в личном кабинете (см. acctShowTab в account.js), чтобы красный
// счётчик непрочитанных погас.
app.put('/api/me/notifications/read', customerAuth, async (req, res) => {
  await db.runAsync(`UPDATE notifications SET read_at = datetime('now') WHERE customer_id = ? AND read_at IS NULL`, [req.customer.id]);
  res.json({ success: true });
});

// ---- Чат с нами (личный кабинет) ----
app.get('/api/me/chat', customerAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT id, sender, admin, text, attachment, created_at, read_at FROM chat_messages WHERE customer_id = ? ORDER BY id ASC LIMIT 200`,
    [req.customer.id]
  );
  res.json({ messages: rows });
});
app.post('/api/me/chat', customerAuth, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    const attachment = (req.body && req.body.attachment) || null;
    if (attachment && !/^\/chat-uploads\/[\w.-]+$/.test(attachment)) return res.status(400).json({ error: 'Некорректное вложение' });
    if (!text && !attachment) return res.status(400).json({ error: 'Введите сообщение' });
    const r = await db.runAsync(
      `INSERT INTO chat_messages (customer_id, sender, text, attachment) VALUES (?, 'customer', ?, ?)`,
      [req.customer.id, text, attachment]
    );
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Отмечаем прочитанными ответы админа — зовётся при открытии вкладки "Чат с нами"
// (см. acctShowTab в account.js), как и у /api/me/notifications/read.
app.put('/api/me/chat/read', customerAuth, async (req, res) => {
  await db.runAsync(
    `UPDATE chat_messages SET read_at = datetime('now') WHERE customer_id = ? AND sender = 'admin' AND read_at IS NULL`,
    [req.customer.id]
  );
  res.json({ success: true });
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
      // Саму попытку чтения (GET) не пишем в журнал — это обычный фон (истёкший токен,
      // открытая вторая вкладка и т.п.), а вот попытка изменить/удалить что-то без
      // доступа — уже стоит внимания, пишем логин (без пароля) и что пытались сделать.
      if (req.method !== 'GET') {
        logAdmin(req, 'unauthorized', `Попытка без доступа: ${req.method} ${req.originalUrl}`, u ? `логин в токене: ${u}` : 'токен не передан');
      }
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

// Отдельная запись в "Ошибки сайта" на каждое срабатывание ловушки от ботов (поле
// "website", см. #oWebsite/#kpWebsite/#accWebsite) — раньше такой отказ ничем не
// отличался от обычной ошибки валидации, по логам нельзя было понять, бот это или
// просто пользователь что-то не так заполнил. User-Agent — чтобы отличить реального
// спам-бота от, например, краулера Google Merchant Center (вдруг это он задевает
// скрытое поле и поэтому не может "оформить заказ" — тогда ловушку надо переделать).
function logHoneypot(req, context) {
  const ua = String(req.headers['user-agent'] || '(нет User-Agent)').slice(0, 300);
  db.runAsync(
    `INSERT INTO client_errors (message, context, url, ip) VALUES (?,?,?,?)`,
    [`Сработала ловушка от ботов. User-Agent: ${ua}`, 'honeypot_' + context, req.originalUrl || '', clientIp(req)]
  ).catch(() => {});
}

// ---- Статистика сайта (для админки — просмотры, поисковые запросы, товары) ----
// По просьбе Миры боты (включая Яндекс/Google) из статистики не исключаются —
// пусть пишется всё подряд, без фильтрации.
async function logStat(type, path, value, refId, ip, ua, ref, entryQuery, phone) {
  try {
    await db.runAsync(
      `INSERT INTO stats_events (type, path, value, ref_id, ip, ua, ref, entry_query, phone) VALUES (?,?,?,?,?,?,?,?,?)`,
      [type, path || null, value || null, refId || null, ip || null, (ua || '').slice(0, 300) || null,
       (ref || '').slice(0, 500) || null, (entryQuery || '').slice(0, 500) || null, (phone || '').slice(0, 40) || null]
    );
    await db.runAsync(`DELETE FROM stats_events WHERE id <= (SELECT MAX(id) - 200000 FROM stats_events)`);
  } catch { /* статистика не должна ломать основной запрос */ }
}
async function logAdmin(req, action, label, detail, orderId, customerId, attachment) {
  try {
    await db.runAsync(
      `INSERT INTO admin_log (admin, action, label, detail, ip, order_id, customer_id, attachment) VALUES (?,?,?,?,?,?,?,?)`,
      [(req.admin && req.admin.username) || req._logUser || '—', action, label || null, detail || null, clientIp(req), orderId || null, customerId || null, attachment || null]
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
    [/\/articles$/,            { POST: ['create', 'Добавлена статья'] }],
    [/\/articles\/\d+$/,       { PUT: ['update', 'Изменена статья'], DELETE: ['delete', 'Удалена статья'] }],
    [/\/orders\/\d+\/status$/, { PUT: ['update', `Статус заявки #${id}: ${(req.body && req.body.status) || ''}`] }],
    [/\/orders\/\d+\/complete$/, { PUT: ['update', 'Заказ выполнен'] }],
    [/\/orders\/\d+\/notes$/,  { POST: ['create', 'Добавлено примечание к заявке'] }],
    [/\/orders\/\d+$/,         { PUT: ['update', 'Изменена заявка'] }],
    [/\/customers\/\d+$/,      { PUT: ['update', 'Изменён клиент'] }],
    [/\/customers\/\d+\/deduct-bonus$/, { PUT: ['update', 'Списан бонус клиенту'] }],
    [/\/reviews\/\d+$/,        { PUT: ['update', (req.body && req.body.status) ? `Отзыв #${id}: ${req.body.status}` : `Изменён отзыв #${id}`], DELETE: ['delete', `Удалён отзыв #${id}`] }],
    [/\/article-comments\/\d+$/, { PUT: ['update', (req.body && req.body.status) ? `Комментарий к статье #${id}: ${req.body.status}` : `Изменён комментарий к статье #${id}`], DELETE: ['delete', `Удалён комментарий к статье #${id}`] }],
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
    in_stock: { label: 'В наличии', bool: true }, featured: 'Значок на карточке',
    subtitle: 'Подзаголовок', description: 'Описание',
    perf: 'Производительность', perf_unit: 'Ед. произв.', subtype: 'Тип',
    youtube: 'Видео', icon: 'Иконка',
    seo_title: 'SEO-заголовок', seo_description: 'SEO-описание',
    contact_primary: 'Первый контакт (WhatsApp/звонок)',
  },
  categories: { name: 'Название', slug: 'Slug', description: 'Описание', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
  subcategories: { category_id: 'Категория (id)', name: 'Название', slug: 'Slug', description: 'Описание', sort: 'Порядок', icon: 'Иконка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание' },
  articles: { title: 'Заголовок', slug: 'Slug', excerpt: 'Краткое описание', content: 'Текст', cover: 'Обложка', seo_title: 'SEO-заголовок', seo_description: 'SEO-описание', published: { label: 'Опубликовано', bool: true } },
  orders: { name: 'Имя', phone: 'Телефон', email: 'Email', city: 'Город', company: 'Компания', message: 'Комментарий', total: 'Сумма' },
  customers: { name: 'Имя', phone: 'Телефон', email: 'Email', city: 'Город', company: 'Компания', comment: 'Комментарий', bonus_balance: { label: 'Бонусы', bodyKey: 'bonusBalance' } },
  reviews: { status: 'Статус', product_id: 'Товар (id)', name: 'Имя', phone: 'Телефон', company: 'Компания', rating: 'Оценка', text: 'Текст', reply: 'Ответ', created_at: 'Дата' },
  article_comments: { status: 'Статус', article_id: 'Статья (id)', name: 'Имя', text: 'Текст', reply: 'Ответ', created_at: 'Дата' },
};
function diffEntity(u) {
  if (/\/products\/\d+$/.test(u)) return 'products';
  if (/\/categories\/\d+$/.test(u)) return 'categories';
  if (/\/subcategories\/\d+$/.test(u)) return 'subcategories';
  if (/\/articles\/\d+$/.test(u)) return 'articles';
  if (/\/orders\/\d+$/.test(u)) return 'orders';
  if (/\/customers\/\d+$/.test(u)) return 'customers';
  if (/\/reviews\/\d+$/.test(u)) return 'reviews';
  if (/\/article-comments\/\d+$/.test(u)) return 'article_comments';
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
  // Бонус за отзыв (см. PUT /api/admin/reviews/:id) — отдельной строкой рядом с обычным
  // "Статус: pending → approved", а не вместо него.
  if (ent === 'reviews' && req._logReviewBonus > 0) parts.push(`Начислено за отзыв: ${req._logReviewBonus} ₸`);
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
    logAdmin(req, action, label, diffDetail(req), extractOrderId(req), extractCustomerId(req), req._logAttachment || null);
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
    const isYesterday = req.query.days === '-1';
    const days = isToday || isYesterday ? 0 : Math.min(365, Math.max(1, Number(req.query.days) || 30));
    // "Сегодня"/"Вчера" — границы суток считаем по времени Алматы (almatyStartOfDay),
    // а не datetime('now','start of day') у SQLite (это UTC) — иначе ночью, пока в
    // Алматы уже новый день, а в UTC ещё старый, "Сегодня" показывало вчерашние данные.
    const since = isYesterday ? `'${almatyStartOfDay(1)}'`
      : isToday ? `'${almatyStartOfDay(0)}'` : `datetime('now','-${days} days')`;
    // Верхняя граница нужна только у «Вчера» — иначе за «вчера» попадали бы и
    // сегодняшние события (since у остальных периодов не ограничен сверху, там and всегда true).
    const until = isYesterday ? `'${almatyStartOfDay(0)}'` : `datetime('now','+1000 years')`;

    const totalViews = (await db.getAsync(
      `SELECT COUNT(*) AS c FROM stats_events WHERE type IN ('pageview','product_view') AND ts >= ${since} AND ts < ${until}`
    )).c;

    const byDay = await db.allAsync(
      // date(ts,'+5 hours') — группируем по календарной дате в Алматы (UTC+5), а не по
      // дате хранения в UTC: иначе события вечером по Алматы (после ~19:00) уезжали
      // в график следующего дня.
      `SELECT date(ts,'+5 hours') AS date, COUNT(*) AS count
       FROM stats_events WHERE type IN ('pageview','product_view') AND ts >= ${since} AND ts < ${until}
       GROUP BY date ORDER BY date`
    );

    const topSearches = await db.allAsync(
      `SELECT value, COUNT(*) AS count FROM stats_events
       WHERE type = 'search' AND ts >= ${since} AND ts < ${until} AND value IS NOT NULL AND value != ''
       GROUP BY LOWER(value) ORDER BY count DESC LIMIT 30`
    );

    const topProducts = await db.allAsync(
      `SELECT s.ref_id, COUNT(*) AS count, p.name, p.icon
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type = 'product_view' AND s.ts >= ${since} AND s.ts < ${until} AND s.ref_id IS NOT NULL
       GROUP BY s.ref_id ORDER BY count DESC LIMIT 30`
    );

    // Подробный список «когда и что смотрели» — последние события, самые свежие сверху.
    // Таблица в админке показывает только последние 1000 — это нормально для списка (никто
    // не листает тысячи строк руками), но счётчик повторов IP (ниже) считаем ОТДЕЛЬНЫМ
    // запросом по ВСЕМУ периоду — иначе "×N" врёт, если у IP было больше заходов, чем
    // влезло в эти 1000 строк (просто обрезаются как более старые).
    const ipFilter = (req.query.ip || '').trim();
    const recentViews = await db.allAsync(
      `SELECT s.ts, s.type, s.path, s.ref_id, s.ip, s.ua, s.ref, s.entry_query, p.name AS product_name
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type IN ('pageview','product_view') AND s.ts >= ${since} AND s.ts < ${until}
       ${ipFilter ? 'AND s.ip = ?' : ''}
       ORDER BY s.id DESC LIMIT 1000`,
      ipFilter ? [ipFilter] : []
    );
    const ipCountRows = await db.allAsync(
      `SELECT ip, COUNT(*) as cnt FROM stats_events
       WHERE type IN ('pageview','product_view') AND ts >= ${since} AND ts < ${until} AND ip IS NOT NULL AND ip != ''
       GROUP BY ip`
    );
    const ipCountsFull = {};
    ipCountRows.forEach(r => { ipCountsFull[r.ip] = r.cnt; });
    // Источник визита — по исходной ссылке (gclid/utm в строке запроса = точно реклама)
    // и по тому, с какого сайта пришли (referrer). Если ни то, ни другое не указывает на
    // конкретный источник — считаем прямым заходом (по ссылке в закладках/мессенджере
    // или человек напечатал адрес сам: тогда referrer у браузера пустой).
    // Название кампании по её id (campaignid из ValueTrack, см. trafficSource) — сам Google
    // Ads название в адрес не подставляет, только числовой id, поэтому сопоставляем вручную.
    // Id виден в адресной строке Google Ads на странице кампании (...campaignId=XXXXXXXXXX).
    // Добавляйте сюда новые кампании по мере создания — иначе в отчёте будет просто id.
    const CAMPAIGN_NAMES = {
      '24355949514': 'Shopping',
      '24201786142': 'Campaign #1',
      '24350189447': 'АВД — КМС',
      '24297996137': 'Поломоечные машины — поиск',
      '24294096679': 'Робот мойки — КМС',
      '24238032205': 'Sigma Trade',
    };
    function trafficSource(ref, entryQuery) {
      const q = String(entryQuery || '');
      const r = String(ref || '');
      if (/[?&](gclid|gad_source|gad_campaignid)=/i.test(q)) {
        // Поиск или КМС (баннерная сеть) — Google Ads сам не передаёт это в адресе,
        // только если в кампании настроен «суффикс конечного URL» вида network={network}
        // (или nw={network}) — тогда там будет код сети: g/s — поиск, d — КМС, ytv — YouTube.
        const nwM = q.match(/[?&](?:network|nw)=([^&]+)/i);
        const NETWORKS = { g: 'Поиск', s: 'Партнёр поиска', d: 'КМС (баннеры)', ytv: 'YouTube' };
        const nw = nwM && NETWORKS[decodeURIComponent(nwM[1]).toLowerCase()];
        // Название кампании — так же, только если в суффиксе есть campaignid={campaignid}
        // (или cid={campaignid}); если id неизвестен (новая кампания, ещё не внесли в
        // CAMPAIGN_NAMES выше) — показываем хотя бы сам id, не теряя информацию молча.
        const cidM = q.match(/[?&](?:campaignid|cid)=([^&]+)/i);
        const cid = cidM && decodeURIComponent(cidM[1]);
        const campaignLabel = cid && (CAMPAIGN_NAMES[cid] || `кампания ${cid}`);
        let label = 'Google Ads (реклама)';
        if (nw) label += ` — ${nw}`;
        if (campaignLabel) label += ` — ${campaignLabel}`;
        return label;
      }
      if (/[?&](yclid|ysclid)=/i.test(q)) return 'Яндекс.Директ (реклама)';
      if (/[?&]utm_source=/i.test(q)) {
        const m = q.match(/[?&]utm_source=([^&]+)/i);
        return 'Метка utm: ' + decodeURIComponent((m && m[1]) || '');
      }
      if (!r) return '';
      // Переходы из приложений Android иногда приходят как "android-app://<пакет>/",
      // а не обычной ссылкой — у них нет домена, зато имя пакета само по себе похоже на
      // домен в обратном порядке (com.google.android.youtube). Раньше это ловилось
      // как "google." простым поиском подстроки где угодно в строке — и приложение
      // YouTube (com.google.android.YOUTUBE) ошибочно считалось Google-поиском, хотя
      // "google." там — случайная часть имени пакета, а не сам сервис. Разбираем такие
      // ссылки отдельно, по конкретному пакету, до общей проверки по домену.
      if (/^android-app:\/\//i.test(r)) {
        const pkg = r.replace(/^android-app:\/\//i, '').replace(/\/$/, '');
        const APPS = {
          'com.google.android.youtube': 'YouTube (приложение)',
          'com.google.android.googlequicksearchbox': 'Google (приложение)',
          'com.google.android.gm': 'Gmail (приложение)',
          'com.google.android.apps.maps': 'Google Карты (приложение)',
          'com.android.chrome': 'Chrome (приложение)',
          'com.instagram.android': 'Instagram (приложение)',
          'com.facebook.katana': 'Facebook (приложение)',
          'com.vkontakte.android': 'ВКонтакте (приложение)',
          'org.telegram.messenger': 'Telegram (приложение)',
          'com.whatsapp': 'WhatsApp (приложение)',
        };
        return APPS[pkg] || `Приложение: ${pkg}`;
      }
      // Для обычных ссылок сравниваем именно хост (через URL), а не подстроку где
      // попало в строке — иначе, например, у yandex.ru/clck/... с параметром
      // "...&url=https://google.com/..." в адресе ошибочно сработал бы "Google".
      let host = '';
      try { host = new URL(r).hostname.toLowerCase(); } catch { host = ''; }
      const hostIs = (domain) => host === domain || host.endsWith('.' + domain);
      if (hostIs('google.com') || /^google\.[a-z.]+$/.test(host)) return 'Google (поиск)';
      if (hostIs('yandex.ru') || hostIs('yandex.com') || hostIs('yandex.kz')) return 'Яндекс (поиск)';
      if (hostIs('2gis.ru') || hostIs('2gis.kz') || hostIs('2gis.com')) return '2ГИС';
      if (hostIs('instagram.com')) return 'Instagram';
      if (hostIs('facebook.com')) return 'Facebook';
      if (hostIs('vk.com')) return 'ВКонтакте';
      if (hostIs('t.me') || host.includes('telegram')) return 'Telegram';
      if (host.includes('whatsapp')) return 'WhatsApp';
      if (hostIs('b2btech.kz')) return 'Другая страница сайта';
      return host || 'Переход по ссылке';
    }
    recentViews.forEach(r => { r.traffic_source = trafficSource(r.ref, r.entry_query); });
    // Честные боты сами представляются в User-Agent — так помечаем их в отчёте. Это не
    // ловит настоящий кликфрод (он маскируется под обычный телефон/браузер специально),
    // только очевидных краулеров/скриптов. Порядок проверок важен — более конкретные
    // названия (напр. YandexBot) идут раньше общего "bot".
    const BOT_PATTERNS = [
      // Та же история, что с Яндексом: кроме Googlebot у Google ещё AdsBot-Google,
      // Mediapartners-Google, APIs-Google, FeedFetcher-Google, Google-InspectionTool,
      // Storebot-Google и т.д. — ловим по самому слову "google".
      [/google/i, 'Google-бот'],
      [/bingbot/i, 'Bingbot (Microsoft)'],
      // У Яндекса десяток разных ботов (YandexBot, YandexImages, YandexAccessibilityBot,
      // YandexRenderResourcesBot, YaDirectFetcher и т.д.) — перечислять каждый бессмысленно,
      // ловим по самому слову "yandex" в паре с bot/crawl/spider (проверяется этим же
      // правилом чуть ниже) — так что тут достаточно просто "yandex".
      [/yandex/i, 'Яндекс-бот'],
      [/duckduckbot/i, 'DuckDuckBot'],
      [/baiduspider/i, 'Baiduspider'],
      [/ahrefsbot/i, 'AhrefsBot (SEO-сервис)'],
      [/semrushbot/i, 'SemrushBot (SEO-сервис)'],
      [/mj12bot/i, 'MJ12bot (Majestic SEO)'],
      [/dotbot/i, 'DotBot (Moz)'],
      [/facebookexternalhit/i, 'Facebook (предпросмотр ссылки)'],
      // Новый краулер Meta для предпросмотра ссылок — тот же смысл, что и facebookexternalhit
      // выше, просто под другим именем (developers.facebook.com/docs/sharing/webmasters/crawler).
      [/meta-externalagent/i, 'Meta (предпросмотр ссылки)'],
      [/telegrambot/i, 'Telegram (предпросмотр ссылки)'],
      [/whatsapp/i, 'WhatsApp (предпросмотр ссылки)'],
      [/slurp/i, 'Yahoo Slurp'],
      [/ia_archiver/i, 'Archive.org'],
      [/python-requests/i, 'Скрипт (python-requests)'],
      [/curl\//i, 'Скрипт (curl)'],
      [/wget/i, 'Скрипт (wget)'],
      [/scrapy/i, 'Скрипт-сборщик (Scrapy)'],
      [/headlesschrome/i, 'Автоматизированный браузер (Headless Chrome)'],
      [/phantomjs/i, 'Автоматизированный браузер (PhantomJS)'],
      [/bot|crawl|spider/i, 'Неизвестный бот/краулер'],
    ];
    function botName(ua) {
      const found = BOT_PATTERNS.find(([re]) => re.test(ua));
      return found ? found[1] : null;
    }
    recentViews.forEach(r => { r.bot_name = r.ua ? botName(r.ua) : null; r.is_bot_ua = !!r.bot_name; });

    // Клики по кнопкам: подбор оборудования, запрос КП, звонок, WhatsApp
    const ctaRows = await db.allAsync(
      `SELECT value, COUNT(*) AS count FROM stats_events
       WHERE type = 'cta_click' AND ts >= ${since} AND ts < ${until} GROUP BY value`
    );
    const ctaClicks = { quiz: 0, offer: 0, call: 0, whatsapp: 0 };
    ctaRows.forEach((r) => { if (r.value in ctaClicks) ctaClicks[r.value] = r.count; });

    // По какому товару чаще всего запрашивают КП / звонят / пишут в WhatsApp —
    // «Подбор оборудования» сюда не попадает, он не привязан к конкретному товару.
    const ctaByProductRows = await db.allAsync(
      `SELECT s.ref_id, s.value AS kind, COUNT(*) AS count, p.name, p.icon
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type = 'cta_click' AND s.ref_id IS NOT NULL AND s.ts >= ${since} AND s.ts < ${until}
       GROUP BY s.ref_id, s.value`
    );
    const ctaByProductMap = {};
    ctaByProductRows.forEach((r) => {
      if (!ctaByProductMap[r.ref_id]) ctaByProductMap[r.ref_id] = { productId: r.ref_id, name: r.name, icon: r.icon, offer: 0, call: 0, whatsapp: 0 };
      if (r.kind in ctaByProductMap[r.ref_id]) ctaByProductMap[r.ref_id][r.kind] = r.count;
    });
    const ctaByProduct = Object.values(ctaByProductMap)
      .sort((a, b) => (b.offer + b.call + b.whatsapp) - (a.offer + a.call + a.whatsapp));

    // Последние клики по кнопкам (звонок/WhatsApp/КП/подбор) с IP и номером, по
    // которому звонили/писали — Мира попросила видеть это, а не только суммы по товарам.
    const recentClicks = await db.allAsync(
      `SELECT s.ts, s.value AS kind, s.ref_id, s.phone, s.ip, p.name AS product_name
       FROM stats_events s LEFT JOIN products p ON p.id = s.ref_id
       WHERE s.type = 'cta_click' AND s.ts >= ${since} AND s.ts < ${until}
       ORDER BY s.id DESC LIMIT 300`
    );

    res.json({ days, totalViews, byDay, topSearches, topProducts, recentViews, ctaClicks, ctaByProduct, recentClicks, ipCountsFull });
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
    // reviewBonusThisMonth — сколько отзывов этого клиента уже принесли бонус в текущем
    // календарном месяце по времени Алматы (+5 часов к UTC, см. almatyStartOfDay выше) —
    // показываем в админке при публикации, чтобы было видно лимит (3 в месяц) ДО того,
    // как начислять ещё один (см. PUT /api/admin/reviews/:id). NULL — отзыв гостя без
    // аккаунта, бонус в принципе не положен, считать нечего.
    const rows = await db.allAsync(
      `SELECT r.*, p.name AS product_name,
        (CASE WHEN r.customer_id IS NOT NULL THEN (
          SELECT COUNT(*) FROM bonus_log b WHERE b.customer_id = r.customer_id AND b.reason = 'review'
            AND strftime('%Y-%m', b.created_at, '+5 hours') = strftime('%Y-%m','now','+5 hours')
        ) ELSE NULL END) AS reviewBonusThisMonth
       FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
       ${where} ORDER BY r.id DESC LIMIT 300`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if ('status' in b && !['pending', 'approved', 'rejected'].includes(b.status)) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }
    const cur = await db.getAsync('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const { sets, params } = partialUpdate({
      status: null,
      // Перенос отзыва на другой товар (или в общие — пустое значение) и правка
      // даты/текста/оценки — нужно, когда отзыв изначально оставлен не на том товаре,
      // или перенесён сюда вручную (с другой площадки) с исходной датой публикации.
      product_id: v => v || null,
      name: v => (v || '').trim() || cur.name,
      phone: v => (v || '').trim() || null,
      company: v => (v || '').trim() || null,
      rating: v => Math.max(1, Math.min(5, Number(v) || cur.rating)),
      text: v => (v || '').trim() || null,
      reply: v => (v || '').trim() || null,
      created_at: v => v || cur.created_at,
    }, b);
    if (sets.length) await db.runAsync(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    // Бонус за отзыв — только при публикации (approved), только если отзыв оставил
    // вошедший клиент (customer_id), только один раз на отзыв (bonus_awarded_at) и не
    // больше 3 отзывов с бонусом в месяц на клиента (считаем по bonus_log, см. выше в
    // /api/admin/reviews). Сумму и подтверждение даёт сама админка (окно при публикации,
    // см. awardBonus/bonusAmount) — здесь только проверяем условия и начисляем.
    let bonusResult = null;
    if (b.status === 'approved' && b.awardBonus && !cur.bonus_awarded_at) {
      if (!cur.customer_id) {
        bonusResult = { awarded: false, reason: 'Отзыв оставлен без аккаунта — начислять некуда' };
      } else {
        const countRow = await db.getAsync(
          `SELECT COUNT(*) AS c FROM bonus_log WHERE customer_id = ? AND reason = 'review'
           AND strftime('%Y-%m', created_at, '+5 hours') = strftime('%Y-%m','now','+5 hours')`,
          [cur.customer_id]
        );
        if (countRow.c >= 3) {
          bonusResult = { awarded: false, reason: 'У клиента уже 3 отзыва с бонусом в этом месяце' };
        } else {
          const amount = Math.max(1, Math.round(Number(b.bonusAmount) || 0));
          await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [amount, cur.customer_id]);
          await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason) VALUES (?, ?, ?)', [cur.customer_id, amount, 'review']);
          await db.runAsync('UPDATE reviews SET bonus_awarded_at = datetime(\'now\') WHERE id = ?', [req.params.id]);
          req._logReviewBonus = amount;
          // Чтобы запись попала не только в общий "Журнал", но и в "Историю изменений
          // клиента" (см. extractCustomerId/GET /api/admin/customers/:id/log) — сама
          // ссылка в URL (/reviews/:id) клиента не содержит, иначе её было бы не найти.
          req._logCustomerId = cur.customer_id;
          bonusResult = { awarded: true, amount };
          await notifyCustomer(cur.customer_id, `Спасибо за отзыв! Вам начислено ${amount} ₸ бонусами.`);
        }
      }
    }
    res.json({ success: true, bonus: bonusResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/article-comments', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || '';
    const where = status ? 'WHERE c.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await db.allAsync(
      `SELECT c.*, a.title AS article_title, a.slug AS article_slug FROM article_comments c
       LEFT JOIN articles a ON a.id = c.article_id
       ${where} ORDER BY c.id DESC LIMIT 300`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/article-comments/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if ('status' in b && !['pending', 'approved', 'rejected'].includes(b.status)) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }
    const cur = await db.getAsync('SELECT * FROM article_comments WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const { sets, params } = partialUpdate({
      status: null,
      name: v => (v || '').trim() || cur.name,
      text: v => (v || '').trim() || cur.text,
      reply: v => (v || '').trim() || null,
    }, b);
    if (sets.length) await db.runAsync(`UPDATE article_comments SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/article-comments/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('DELETE FROM article_comments WHERE id = ?', [req.params.id]);
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
    let subcategoryIds = [];
    if (search) {
      if (/^\d+$/.test(String(search).trim())) {
        where.push('(p.id = ? OR p.name LIKE ? OR p.article LIKE ?)');
        params.push(Number(search), `%${search}%`, `%${search}%`);
      } else {
        where.push('(p.name LIKE ? OR p.article LIKE ? OR p.brand LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
    }
    // Товар виден в категории/подкатегории либо как в своей "родной" (category_id/
    // subcategory_id), либо как дополнительно привязанный (product_extra_categories) —
    // в админском списке/сортировке он должен появляться в обоих случаях, иначе Мира не
    // увидит его там, где сама же его добавила.
    if (category) {
      where.push(`(p.category_id = ? OR p.id IN (
        SELECT product_id FROM product_extra_categories WHERE category_id = ?
      ))`);
      params.push(Number(category), Number(category));
    }
    if (subcategory) {
      // Как на сайте: подкатегория показывает товары и из своих вложенных подкатегорий —
      // иначе порядок в админке управлял бы только частью того, что видно на странице.
      const idRows = await db.allAsync(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM subcategories WHERE id = ?
           UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
         ) SELECT id FROM tree`, [Number(subcategory)]);
      subcategoryIds = idRows.map(r => r.id);
      const inList = subcategoryIds.length ? subcategoryIds.map(() => '?').join(',') : 'NULL';
      where.push(`(p.subcategory_id IN (${inList}) OR p.id IN (
        SELECT product_id FROM product_extra_categories WHERE subcategory_id IN (${inList})
      ))`);
      params.push(...subcategoryIds, ...subcategoryIds);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // Порядок перетаскиванием осмыслен только внутри одной подкатегории — там же
    // отдаём сразу все товары без постраничной разбивки, чтобы drag-and-drop видел весь список.
    // Важно: sort_order у товара один на все категории, где он показан (своя и
    // дополнительные) — если потащить мышью товар, добавленный сюда как дополнительный,
    // это может сдвинуть его позицию и в его родной категории тоже.
    const noPaging = !!subcategory;
    const countRow = await db.getAsync(`SELECT COUNT(*) as cnt FROM products p ${whereStr}`, params);
    // Помечаем строки, которые попали в список не по своей "родной" категории/подкатегории,
    // а по дополнительной привязке — чтобы в таблице можно было показать отметку об этом.
    const selectExtra = [];
    const selectParams = [];
    if (category) { selectExtra.push('(p.category_id != ?) AS is_extra_category'); selectParams.push(Number(category)); }
    else selectExtra.push('0 AS is_extra_category');
    if (subcategory) {
      const inList = subcategoryIds.length ? subcategoryIds.map(() => '?').join(',') : 'NULL';
      selectExtra.push(`(p.subcategory_id NOT IN (${inList}) OR p.subcategory_id IS NULL) AS is_extra_subcategory`);
      selectParams.push(...subcategoryIds);
    } else selectExtra.push('0 AS is_extra_subcategory');
    const rows = await db.allAsync(
      `SELECT p.*, c.name as category_name, sc.name as subcategory_name, ${selectExtra.join(', ')}
       FROM products p
       JOIN categories c ON p.category_id=c.id
       LEFT JOIN subcategories sc ON p.subcategory_id=sc.id
       ${whereStr} ORDER BY p.sort_order ASC, p.id DESC
       ${noPaging ? '' : 'LIMIT ? OFFSET ?'}`,
      noPaging ? [...selectParams, ...params] : [...selectParams, ...params, Number(limit), Number(offset)]
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

// Галерея фото/видео проектов подкатегории — массив { type:'photo', file } | { type:'video', url };
// отбрасываем всё, что не похоже на такую пару (битый JSON/чужая структура от клиента).
const jsonGallery = (v) => {
  let arr;
  try { arr = Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return '[]'; }
  if (!Array.isArray(arr)) return '[]';
  return JSON.stringify(arr.map(it => {
    if (!it || typeof it !== 'object') return null;
    if (it.type === 'photo' && typeof it.file === 'string' && it.file.trim()) return { type: 'photo', file: it.file.trim() };
    if (it.type === 'video' && typeof it.url === 'string' && it.url.trim()) return { type: 'video', url: it.url.trim() };
    return null;
  }).filter(Boolean));
};

// Технические характеристики — объект { "Характеристика": "Значение" }; админка теперь
// собирает его из строк-полей (не просит писать JSON руками), сюда может прийти и объект,
// и готовая строка — отбрасываем пустые/битые пары, как jsonFaq делает для FAQ.
const jsonSpecs = (v) => {
  let obj;
  try { obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v : JSON.parse(v || '{}'); } catch { return '{}'; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}';
  const out = {};
  for (const [k, val] of Object.entries(obj)) {
    const key = String(k || '').trim();
    const value = String(val == null ? '' : val).trim();
    if (key && value) out[key] = value;
  }
  return JSON.stringify(out);
};

// FAQ раздела — массив пар [вопрос, ответ]; отбрасываем всё, что не похоже на
// нормальную пару непустых строк (битый JSON от клиента не должен попасть в БД как есть).
const jsonFaq = (v) => {
  let arr;
  try { arr = Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return '[]'; }
  if (!Array.isArray(arr)) return '[]';
  return JSON.stringify(arr
    .filter(p => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' && p[0].trim() && p[1].trim())
    .map(p => [p[0].trim(), p[1].trim()]));
};

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

// Товар может быть дополнительно виден ещё в каких-то категориях/подкатегориях, помимо
// своей canonical (products.category_id/subcategory_id) — без дублирования карточки.
// Сохраняем списком "как есть" с нуля — проще и надёжнее, чем вычислять diff.
async function saveExtraCategories(productId, list) {
  await db.runAsync('DELETE FROM product_extra_categories WHERE product_id = ?', [productId]);
  for (const r of (Array.isArray(list) ? list : [])) {
    if (!r || !r.category_id) continue;
    await db.runAsync(
      'INSERT INTO product_extra_categories (product_id, category_id, subcategory_id) VALUES (?, ?, ?)',
      [productId, r.category_id, r.subcategory_id || null]
    );
  }
}

// Отдельная от публичной /api/products/:id — та фильтрует скрытые (published=0) товары,
// а форма редактирования в админке должна открывать и их тоже (иначе скрытый товар
// нельзя будет открыть, чтобы снова включить галочку "Показывать на сайте").
app.get('/api/admin/products/:id', adminAuth, async (req, res) => {
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
    applyDiscount(product);   // для old_price при активной скидке — форма всегда должна показывать базовую цену
    product.extra_categories = await db.allAsync(
      'SELECT category_id, subcategory_id FROM product_extra_categories WHERE product_id = ?', [product.id]);
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const b = req.body;
    // slug для URL (/product/{id}-{slug}) задаётся один раз, здесь, при создании (вручную,
    // если ввели в форме, иначе из названия) — и дальше сам не меняется при переименовании
    // (см. PUT ниже: пустое значение там оставляет прежний slug), иначе переименование
    // товара меняло бы уже проиндексированный Google/Яндексом адрес и плодило бы в Search
    // Console «дубли с другим canonical».
    const result = await db.runAsync(
      `INSERT INTO products (category_id, name, slug, article, brand, description, price, price_on_request, icon, in_stock, featured, specs,
                             subtype, perf, perf_unit, related_ids, bundle_ids, youtube, subtitle, images, subcategory_id,
                             seo_title, seo_description, contact_primary, in_feed, discount_percent, discount_until, discount_price, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.category_id, b.name, slugify(b.slug || b.name), b.article || '', b.brand || '', b.description || '', b.price || 0,
       b.price_on_request ? 1 : 0, b.icon || null, b.in_stock ? 1 : 0, jsonArr(b.featured), jsonSpecs(b.specs),
       b.subtype || null, b.perf || null, b.perf_unit || 'ед./час', jsonArr(b.related_ids), jsonArr(b.bundle_ids),
       b.youtube || null, b.subtitle || null, jsonArr(b.images), b.subcategory_id || null,
       (b.seo_title || '').trim() || null, (b.seo_description || '').trim() || null,
       (b.contact_primary === '1' || b.contact_primary === '2') ? b.contact_primary : null,
       b.in_feed === false ? 0 : 1,
       Math.max(0, Math.min(100, Math.round(Number(b.discount_percent) || 0))),
       /^\d{4}-\d{2}-\d{2}$/.test(b.discount_until) ? b.discount_until : null,
       Number(b.discount_price) > 0 ? Number(b.discount_price) : null,
       b.published === false ? 0 : 1]
    );
    if (b.extra_categories !== undefined) await saveExtraCategories(result.lastID, b.extra_categories);
    res.json({ success: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await db.getAsync('SELECT id, slug FROM products WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Товар не найден' });
    const { sets, params } = partialUpdate({
      category_id: null,
      subcategory_id: v => v || null,
      name: null,
      // slug обычно "заморожен" (см. POST выше) и в форму его трогать не нужно — но если
      // всё же пришло непустое значение (админ сам вписал), используем его. Пустое — оставляем
      // прежний slug как есть, а не пересчитываем из названия, иначе переименование товара
      // опять бы меняло уже проиндексированную ссылку.
      slug: v => (v ? slugify(v) : cur.slug),
      article: v => v || '',
      brand: v => v || '',
      description: v => v || '',
      price: v => v || 0,
      price_on_request: v => (v ? 1 : 0),
      icon: v => v || null,
      in_stock: v => (v ? 1 : 0),
      featured: v => jsonArr(v),
      specs: v => jsonSpecs(v),
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
      in_feed: v => (v ? 1 : 0),
      published: v => (v ? 1 : 0),
      discount_percent: v => Math.max(0, Math.min(100, Math.round(Number(v) || 0))),
      discount_until: v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null,
      discount_price: v => Number(v) > 0 ? Number(v) : null,
    }, b);
    if (sets.length) await db.runAsync(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    if (b.extra_categories !== undefined) await saveExtraCategories(req.params.id, b.extra_categories);
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
              (SELECT COUNT(DISTINCT pid) FROM (
                 SELECT id AS pid FROM products WHERE category_id = c.id
                 UNION
                 SELECT product_id AS pid FROM product_extra_categories WHERE category_id = c.id
               )) as product_count,
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
      `INSERT INTO categories (name, slug, description, icon, seo_title, seo_description, faq, in_feed, published) VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, slug, description || '', icon || null,
       (req.body.seo_title || '').trim() || null, (req.body.seo_description || '').trim() || null,
       jsonFaq(req.body.faq), req.body.in_feed === false ? 0 : 1, req.body.published === false ? 0 : 1]);
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
      faq: v => jsonFaq(v),
      in_feed: v => (v ? 1 : 0),
      published: v => (v ? 1 : 0),
    }, b);
    if (sets.length) await db.runAsync(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    // Галочка "Рекламировать" у категории — это не постоянный фильтр, а разовое массовое
    // действие: включили — сразу включаются ВСЕ товары категории, выключили — выключаются
    // ВСЕ. Дальше решает уже флаг конкретного товара (см. merchantFeed() в seo.js, где
    // участвует только products.in_feed). Срабатывает только если значение реально
    // поменялось — иначе любое сохранение категории затирало бы точечные отключения товаров.
    if ('in_feed' in b) {
      const next = b.in_feed ? 1 : 0;
      if (next !== cur.in_feed) {
        // Каскадом — и все подкатегории этой категории (чтобы при открытии подкатегории
        // галочка не "врала", что она отдельно включена, пока все её товары уже выключены
        // категорией), и все товары.
        await db.runAsync('UPDATE subcategories SET in_feed = ? WHERE category_id = ?', [next, req.params.id]);
        await db.runAsync('UPDATE products SET in_feed = ? WHERE category_id = ?', [next, req.params.id]);
      }
    }
    // Та же разовая каскадная логика — для "Показывать на сайте" (published). Выключили —
    // пропадает и сама категория из навигации/каталога, и все её подкатегории и товары.
    if ('published' in b) {
      const next = b.published ? 1 : 0;
      if (next !== cur.published) {
        await db.runAsync('UPDATE subcategories SET published = ? WHERE category_id = ?', [next, req.params.id]);
        await db.runAsync('UPDATE products SET published = ? WHERE category_id = ?', [next, req.params.id]);
      }
    }
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

// Список характеристик (ключей из поля "Характеристики"), которые реально встречаются
// у товаров этой подкатегории — чтобы в форме подкатегории можно было выбрать любую из
// них фильтром, не вспоминая точное название вручную. С count — сколько товаров её
// заполнили (подсказка, насколько фильтр будет полезен — мало товаров, мало смысла).
app.get('/api/admin/subcategories/:id/spec-keys', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT je.key as k, COUNT(*) as cnt
       FROM products p, json_each(p.specs) je
       WHERE p.subcategory_id = ? AND json_valid(p.specs)
       GROUP BY je.key ORDER BY cnt DESC, je.key`,
      [req.params.id]);
    res.json(rows.map(r => ({ key: r.k, count: r.cnt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    res.json(await db.allAsync(
      `SELECT s.*, c.name as category_name, c.slug as category_slug,
              par.name AS parent_name,
              (SELECT COUNT(DISTINCT pid) FROM (
                 SELECT id AS pid FROM products p WHERE p.subcategory_id = s.id
                 UNION
                 SELECT product_id AS pid FROM product_extra_categories WHERE subcategory_id = s.id
               )) as product_count
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
      `INSERT INTO subcategories (category_id, name, slug, description, sort, icon, seo_title, seo_description, parent_id, faq, in_feed, filter_specs, google_category, gallery, published) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [category_id, name, slug, description || '', sort || 0, icon || null,
       (req.body.seo_title || '').trim() || null, (req.body.seo_description || '').trim() || null,
       req.body.parent_id || null, jsonFaq(req.body.faq), req.body.in_feed === false ? 0 : 1,
       jsonArr(req.body.filter_specs), (req.body.google_category || '').trim() || null, jsonGallery(req.body.gallery),
       req.body.published === false ? 0 : 1]);
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
      faq: v => jsonFaq(v),
      in_feed: v => (v ? 1 : 0),
      filter_specs: v => jsonArr(v),
      google_category: v => (v || '').trim() || null,
      gallery: v => jsonGallery(v),
      published: v => (v ? 1 : 0),
    }, b);
    if (sets.length) await db.runAsync(`UPDATE subcategories SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    // Та же разовая массовая логика, что у категории (см. PUT /api/admin/categories/:id) —
    // только тут ещё и по вложенным подкатегориям (у "Профессиональные пылесосы" внутри
    // могут быть свои подгруппы) — та же рекурсия по дереву, что и в queryProducts().
    if ('in_feed' in b) {
      const next = b.in_feed ? 1 : 0;
      if (next !== cur.in_feed) {
        const idRows = await db.allAsync(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM subcategories WHERE id = ?
             UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
           ) SELECT id FROM tree`, [req.params.id]);
        const ids = idRows.map(r => r.id);
        const inList = ids.map(() => '?').join(',');
        await db.runAsync(`UPDATE products SET in_feed = ? WHERE subcategory_id IN (${inList})`, [next, ...ids]);
      }
    }
    if ('published' in b) {
      const next = b.published ? 1 : 0;
      if (next !== cur.published) {
        const idRows = await db.allAsync(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM subcategories WHERE id = ?
             UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
           ) SELECT id FROM tree`, [req.params.id]);
        const ids = idRows.map(r => r.id);
        const inList = ids.map(() => '?').join(',');
        await db.runAsync(`UPDATE subcategories SET published = ? WHERE id IN (${inList})`, [next, ...ids]);
        await db.runAsync(`UPDATE products SET published = ? WHERE subcategory_id IN (${inList})`, [next, ...ids]);
      }
    }
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

// ==================== ADMIN СТАТЬИ ====================
app.get('/api/admin/articles', adminAuth, async (req, res) => {
  try { res.json(await db.allAsync('SELECT * FROM articles ORDER BY id DESC')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/articles', adminAuth, async (req, res) => {
  try {
    const { title, excerpt, content, cover } = req.body;
    if (!title) return res.status(400).json({ error: 'Укажите заголовок' });
    const slug = req.body.slug ? slugify(req.body.slug) : slugify(title);
    const r = await db.runAsync(
      `INSERT INTO articles (title, slug, excerpt, content, cover, seo_title, seo_description, published) VALUES (?,?,?,?,?,?,?,?)`,
      [title, slug, excerpt || '', content || '', cover || null,
       (req.body.seo_title || '').trim() || null, (req.body.seo_description || '').trim() || null,
       req.body.published === false ? 0 : 1]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть' : e.message }); }
});
app.put('/api/admin/articles/:id', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await db.getAsync('SELECT * FROM articles WHERE id = ?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Не найдено' });
    const { sets, params } = partialUpdate({
      title: null,
      slug: (v, body) => (v ? slugify(v) : slugify(body.title || cur.title)),
      excerpt: v => v || '',
      content: v => v || '',
      cover: v => v || null,
      seo_title: v => (v || '').trim() || null,
      seo_description: v => (v || '').trim() || null,
      published: v => (v ? 1 : 0),
    }, b);
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      await db.runAsync(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: /UNIQUE/.test(e.message) ? 'Такой slug уже есть' : e.message }); }
});
app.delete('/api/admin/articles/:id', adminAuth, async (req, res) => {
  try {
    await db.runAsync('DELETE FROM articles WHERE id=?', [req.params.id]);
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
    await db.runAsync('DELETE FROM product_extra_categories WHERE product_id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN ORDERS ====================
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 30, status, search, sort, dateFrom, dateTo } = req.query;
    const offset = (page - 1) * limit;
    const statuses = status ? String(status).split(',').filter(Boolean) : [];
    const clauses = [], params = [];
    if (statuses.length) { clauses.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    const q = String(search || '').trim();
    if (q) {
      // Телефон могут искать и как "77027900709", и отформатированным — "+7 (702)
      // 790-07-09" — обычный LIKE по сырому номеру такое не найдёт (нет пробелов/скобок
      // в базе), поэтому отдельно сравниваем нормализованный номер с цифрами из запроса.
      const qDigits = q.replace(/\D/g, '').slice(-10); // та же нормализация, что у phoneNormSql — иначе "+7..." (11 цифр с кодом страны) не совпадёт с усечёнными до 10 цифр номерами в базе
      const parts = ['name LIKE ?', 'phone LIKE ?', 'company LIKE ?', 'email LIKE ?', 'city LIKE ?', 'message LIKE ?', 'items LIKE ?'];
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      if (qDigits.length >= 3) { parts.push(`${phoneNormSql('phone')} LIKE ?`); params.push(`%${qDigits}%`); }
      if (/^\d+$/.test(q)) { parts.push('id = ?'); params.push(Number(q)); }
      clauses.push('(' + parts.join(' OR ') + ')');
    }
    // Фильтр «дата закрытия» — по completed_at (когда статус реально стал "Выполнена"),
    // не по дате поступления заявки. У незакрытых заявок completed_at пустой, поэтому
    // они сами отсеются, если задан хотя бы один из dateFrom/dateTo.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || ''))) { clauses.push('completed_at >= ?'); params.push(dateFrom + ' 00:00:00'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || ''))) { clauses.push('completed_at <= ?'); params.push(dateTo + ' 23:59:59'); }
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
       (SELECT remind_at FROM order_notes n WHERE n.order_id = o.id ORDER BY n.id DESC LIMIT 1) AS nextReminder,
       COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = o.id AND reason = 'order_earn'), 0) AS bonus_earned
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
    // completed_at — только пока статус реально "Выполнена"; если статус поменяли
    // обратно, заявка больше не закрыта, и в фильтре по дате закрытия её быть не должно.
    const completedAtSql = status === 'done' ? "datetime('now')" : 'NULL';
    await db.runAsync(`UPDATE orders SET status=?, completed_at=${completedAtSql} WHERE id=?`, [status, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Менеджер сам создаёт заказ (звонок, оффлайн-клиент и т.п.) — та же таблица orders,
// source='manual' отличает его от заявок с сайта; без CRM/WhatsApp-уведомления — она и так знает.
app.post('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { name, phone, email, city, company, message, items, total, customerId } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Укажите имя и телефон' });
    let itemsStr = typeof items === 'string' ? items : JSON.stringify(items || []);
    let computedTotal = Number(total) || 0;
    if (!computedTotal) {
      try {
        const parsed = JSON.parse(itemsStr);
        computedTotal = parsed.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
      } catch {}
    }
    // Клиент найден поиском/автоподстановкой по телефону в форме "Новый заказ" — сразу
    // привязываем заказ к его аккаунту (customer_id), а не только по совпадению
    // телефона (иначе он не попадёт в "Заказы клиента" при смене клиентом телефона —
    // та же история, что и с /api/admin/customers/:id, см. там подробный комментарий).
    // Проверяем, что такой клиент правда существует — customerId пришёл с фронта.
    const customer = customerId ? await db.getAsync('SELECT id FROM customers WHERE id = ?', [customerId]) : null;
    const result = await db.runAsync(
      `INSERT INTO orders (name, phone, email, city, company, message, items, total, source, customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [name, phone, email || '', city || '', company || '', message || '', itemsStr, computedTotal, customer ? customer.id : null]
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
         COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = orders.id AND reason = 'order_earn'), 0) AS bonus_earned,
         (SELECT text FROM order_notes n WHERE n.order_id = orders.id ORDER BY n.id DESC LIMIT 1) AS lastNote,
         (SELECT remind_at FROM order_notes n WHERE n.order_id = orders.id ORDER BY n.id DESC LIMIT 1) AS nextReminder
       FROM orders WHERE ${phoneNormSql('phone')} = ${phoneNormSql('?')} AND id != ? ORDER BY id DESC`,
      [order.phone, order.id]
    );
    // Если заказ привязан к аккаунту клиента (customer_id) — отдаём его текущие имя/
    // телефон/номер клиента отдельно: они могут отличаться от того, что сохранено в
    // самом заказе (имя/телефон заказа — снимок на момент оформления, не обновляется).
    const linkedCustomer = order.customer_id
      ? await db.getAsync('SELECT id, name, phone, client_no FROM customers WHERE id = ?', [order.customer_id])
      : null;
    res.json({ order, history, linkedCustomer });
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
    // Привязка к аккаунту клиента (customer_id) — пришла из "Найти клиента" в карточке
    // заказа (текущую привязку фронт присылает как есть, если её не меняли, см.
    // odFoundCustomerId). Проверяем, что такой клиент правда существует.
    let customerId = cur.customer_id;
    if (req.body.customerId !== undefined) {
      const customer = req.body.customerId ? await db.getAsync('SELECT id FROM customers WHERE id = ?', [req.body.customerId]) : null;
      customerId = customer ? customer.id : null;
    }
    await db.runAsync(
      'UPDATE orders SET name=?, phone=?, email=?, city=?, company=?, message=?, items=?, total=?, customer_id=? WHERE id=?',
      [name, phone, email, city, company, message, items, total, customerId, req.params.id]
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
// ---- Чат с клиентами (вкладка "Чат" в админке) ----
// Список диалогов: только клиенты, у которых есть хоть одно сообщение, последнее
// сообщение + сколько непрочитанных от клиента — по этому списку строится и сам
// пункт меню (суммарный бейдж), и десктоп-уведомление при появлении нового диалога/
// сообщения (см. chatPollAll() в admin.html — опрашивает этот же эндпоинт).
app.get('/api/admin/chats', adminAuth, async (req, res) => {
  try {
    const rows = await db.allAsync(`
      SELECT c.id AS customer_id, c.name, c.phone,
        (SELECT text FROM chat_messages m WHERE m.customer_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastText,
        (SELECT attachment FROM chat_messages m WHERE m.customer_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastAttachment,
        (SELECT sender FROM chat_messages m WHERE m.customer_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastSender,
        (SELECT created_at FROM chat_messages m WHERE m.customer_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastAt,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.customer_id = c.id AND m.sender = 'customer' AND m.read_at IS NULL) AS unread
      FROM customers c
      WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.customer_id = c.id)
      ORDER BY lastAt DESC
      LIMIT 200
    `);
    res.json({ chats: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Открыть диалог с конкретным клиентом — заодно отмечаем его сообщения прочитанными
// (как и у клиента в /api/me/chat/read), чтобы бейдж непрочитанных погас.
app.get('/api/admin/chats/:customerId', adminAuth, async (req, res) => {
  try {
    const customer = await db.getAsync('SELECT id, name, phone, email FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) return res.status(404).json({ error: 'Клиент не найден' });
    const rows = await db.allAsync(
      `SELECT id, sender, admin, text, attachment, created_at, read_at FROM chat_messages WHERE customer_id = ? ORDER BY id ASC LIMIT 200`,
      [req.params.customerId]
    );
    await db.runAsync(
      `UPDATE chat_messages SET read_at = datetime('now') WHERE customer_id = ? AND sender = 'customer' AND read_at IS NULL`,
      [req.params.customerId]
    );
    res.json({ customer, messages: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/chats/:customerId', adminAuth, async (req, res) => {
  try {
    const customer = await db.getAsync('SELECT id FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) return res.status(404).json({ error: 'Клиент не найден' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    const attachment = (req.body && req.body.attachment) || null;
    if (attachment && !/^\/chat-uploads\/[\w.-]+$/.test(attachment)) return res.status(400).json({ error: 'Некорректное вложение' });
    if (!text && !attachment) return res.status(400).json({ error: 'Введите сообщение' });
    const r = await db.runAsync(
      `INSERT INTO chat_messages (customer_id, sender, admin, text, attachment) VALUES (?, 'admin', ?, ?, ?)`,
      [req.params.customerId, req.admin.username, text, attachment]
    );
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/customers', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const q = String(req.query.search || '').trim();
    // Та же история, что и с поиском по заявкам (см. /api/admin/orders) — номер могут
    // ввести отформатированным, сравниваем ещё и по нормализованным цифрам. Ищем и по
    // основному телефону, и по двум доп. номерам (corp_phone/extra_phone), и по номеру
    // клиента (client_no — видимый, его и будет вводить админ) и, на всякий случай, по
    // внутреннему id, если запрос — просто число.
    const qDigits = q.replace(/\D/g, '').slice(-10); // та же нормализация, что у phoneNormSql — иначе "+7..." (11 цифр с кодом страны) не совпадёт с усечёнными до 10 цифр номерами в базе
    const parts = [], params = [];
    if (q) {
      parts.push('name LIKE ?', 'phone LIKE ?', 'email LIKE ?', 'corp_phone LIKE ?', 'extra_phone LIKE ?', 'company LIKE ?', 'city LIKE ?', 'comment LIKE ?');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      if (/^\d+$/.test(q)) { parts.push('id = ?', 'client_no = ?'); params.push(Number(q), Number(q)); }
      if (qDigits.length >= 3) {
        parts.push(`${phoneNormSql('phone')} LIKE ?`, `${phoneNormSql('corp_phone')} LIKE ?`, `${phoneNormSql('extra_phone')} LIKE ?`);
        params.push(`%${qDigits}%`, `%${qDigits}%`, `%${qDigits}%`);
      }
    }
    const where = q ? `WHERE (${parts.join(' OR ')})` : '';
    const total = (await db.getAsync(`SELECT COUNT(*) AS c FROM customers ${where}`, params)).c;
    const rows = await db.allAsync(
      `SELECT c.*, (SELECT COUNT(*) FROM orders o
         WHERE o.customer_id = c.id OR ${phoneNormSql('o.phone')} = ${phoneNormSql('c.phone')}
       ) AS ordersCount
       FROM customers c ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, customers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Карточка клиента + все его заказы — по customer_id (заказы, оформленные вошедшим
// клиентом или привязанные админом) ИЛИ по телефону (более старые гостевые заказы,
// ещё не привязанные к аккаунту) — если смотреть только по телефону, после смены
// номера клиенту все его уже привязанные заказы пропадали бы из карточки.
app.get('/api/admin/customers/:id', adminAuth, async (req, res) => {
  try {
    const customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Не найдено' });
    const orders = await db.allAsync(
      `SELECT id, items, total, status, created_at,
         COALESCE((SELECT SUM(delta) FROM bonus_log WHERE order_id = orders.id AND reason = 'order_earn'), 0) AS bonus_earned,
         (SELECT text FROM order_notes n WHERE n.order_id = orders.id ORDER BY n.id DESC LIMIT 1) AS lastNote,
         (SELECT remind_at FROM order_notes n WHERE n.order_id = orders.id ORDER BY n.id DESC LIMIT 1) AS nextReminder
       FROM orders
       WHERE customer_id = ? OR ${phoneNormSql('phone')} = ${phoneNormSql('?')}
       ORDER BY id DESC`,
      [customer.id, customer.phone]
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
    const corpPhone = req.body.corpPhone != null ? String(req.body.corpPhone).replace(/\D/g, '') : cur.corp_phone;
    const extraPhone = req.body.extraPhone != null ? String(req.body.extraPhone).replace(/\D/g, '') : cur.extra_phone;
    // Комментарий — внутренняя заметка админа о клиенте, клиент её нигде не видит.
    const comment = req.body.comment != null ? String(req.body.comment).trim() : cur.comment;
    // Бонусы клиента правит только superadmin — остальным поле в интерфейсе недоступно,
    // но на всякий случай проверяем и на сервере, а не только прячем в вёрстке.
    const isSuperadmin = (req.admin.role || 'admin') === 'superadmin';
    const bonusBalance = isSuperadmin && req.body.bonusBalance != null
      ? Math.max(0, Math.round(Number(req.body.bonusBalance) || 0)) : cur.bonus_balance;
    // Номер меняется — пока не поздно, привязываем к этому клиенту его старые гостевые
    // заказы (customer_id ещё NULL), которые до сих пор находились только по старому
    // номеру: иначе после смены телефона они отвалятся из карточки клиента насовсем
    // (карточка и список показывают заказы по customer_id ИЛИ по текущему телефону).
    if (phone !== cur.phone) {
      await db.runAsync(
        `UPDATE orders SET customer_id = ? WHERE customer_id IS NULL AND ${phoneNormSql('phone')} = ${phoneNormSql('?')}`,
        [req.params.id, cur.phone]
      );
    }
    try {
      await db.runAsync('UPDATE customers SET name=?, phone=?, email=?, city=?, company=?, comment=?, corp_phone=?, extra_phone=?, bonus_balance=? WHERE id=?', [name, phone, email, city, company, comment, corpPhone, extraPhone, bonusBalance, req.params.id]);
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
    // Чек/квитанция (необязательно) — путь уже получен заранее через POST
    // /api/admin/upload-receipt; проверяем, что это именно оттуда, а не что попало.
    const attachment = req.body && req.body.attachment;
    if (attachment && /^\/receipts\/[\w.-]+$/.test(attachment)) req._logAttachment = attachment;
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
    // Бонус (и начисление, и списание) применяется только один раз — при ПЕРВОМ переводе
    // заказа в статус "выполнен". Если его потом отметят выполненным ещё раз (например,
    // статус меняли туда-обратно), completed_at уже стоит — второй раз не начисляем и не
    // списываем, иначе клиент получал бы бонус за один заказ несколько раз.
    const firstTimeCompleting = !order.completed_at;
    const items = req.body.items || [];
    const itemsStr = JSON.stringify(items);
    const total = Number(req.body.total) || 0;
    // Бонус начисляется всем админам, если бонусная программа включена — просто обычный
    // admin получает ровно автоматически посчитанный процент и не может его подправить
    // руками (это может только superadmin, передав своё значение bonusAward).
    const isSuperadmin = (req.admin.role || 'admin') === 'superadmin';
    const bonusCfg = (await getSettings()).bonus || {};
    const autoBonus = bonusCfg.enabled && bonusCfg.earn_percent ? Math.round(total * bonusCfg.earn_percent / 100) : 0;
    const bonusAward = firstTimeCompleting ? (isSuperadmin ? Math.max(0, Math.round(Number(req.body.bonusAward) || 0)) : autoBonus) : 0;
    req._logBonusAward = bonusAward;   // для журнала — реально применённая сумма, не то, что просто прислали

    await db.runAsync("UPDATE orders SET items=?, total=?, status=?, completed_at=COALESCE(completed_at, datetime('now')) WHERE id=?", [itemsStr, total, 'done', req.params.id]);

    const phone = String(order.phone || '').replace(/\D/g, '');
    // Если заказ привязан к аккаунту (customer_id) — бонус идёт именно туда, по ID, а не
    // по телефону в заказе: иначе, если в заказе потом поменяли телефон (см. PUT .../:id),
    // бонус ушёл бы не тому клиенту (или создал бы левую новую запись на новый номер)
    // вместо того, к кому заказ реально привязан.
    let customer = order.customer_id ? await db.getAsync('SELECT * FROM customers WHERE id = ?', [order.customer_id]) : null;
    if (!customer && phone) customer = await db.getAsync('SELECT * FROM customers WHERE phone = ?', [phone]);
    if (!customer && phone) {
      const r = await db.runAsync('INSERT INTO customers (name, phone, client_no) VALUES (?, ?, ?)', [order.name, phone, await nextClientNo()]);
      customer = await db.getAsync('SELECT * FROM customers WHERE id = ?', [r.lastID]);
    }
    if (customer) req._logCustomerId = customer.id;   // чтобы это попало и в историю клиента

    let bonusBalance = customer ? customer.bonus_balance : null;
    if (bonusAward > 0 && customer) {
      await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance + ? WHERE id = ?', [bonusAward, customer.id]);
      await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)', [customer.id, bonusAward, 'order_earn', order.id]);
      bonusBalance = customer.bonus_balance + bonusAward;
    }

    // Списание бонуса, который клиент попросил при оформлении (см. bonus_requested в
    // database.js) — только сейчас, когда заказ подтверждён, и только один раз
    // (firstTimeCompleting — не списываем повторно, если заказ зачем-то отметят
    // выполненным ещё раз). Остаток на счету мог измениться с момента заказа (например,
    // уже потрачен на другой заказ) — списываем не больше того, что есть сейчас.
    // Клиент мог и передумать уже после оформления — тогда админ снимает галочку в
    // форме завершения (coApplyBonusRedeem), applyBonusRedeem приходит false, и запрос
    // на списание просто снимается с заказа, бонус остаётся у клиента нетронутым.
    let bonusRedeemed = 0;
    const applyBonusRedeem = req.body.applyBonusRedeem !== false;
    if (firstTimeCompleting && customer && order.bonus_requested > 0) {
      if (applyBonusRedeem) {
        bonusRedeemed = Math.max(0, Math.min(order.bonus_requested, bonusBalance || 0));
        if (bonusRedeemed > 0) {
          await db.runAsync('UPDATE customers SET bonus_balance = bonus_balance - ? WHERE id = ?', [bonusRedeemed, customer.id]);
          await db.runAsync('INSERT INTO bonus_log (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)', [customer.id, -bonusRedeemed, 'order_redeem', order.id]);
          bonusBalance -= bonusRedeemed;
        }
        await db.runAsync("UPDATE orders SET bonus_redeemed_at = datetime('now') WHERE id = ?", [order.id]);
      } else {
        await db.runAsync('UPDATE orders SET bonus_requested = 0 WHERE id = ?', [order.id]);
      }
    }

    // Уведомление в личный кабинет — только зарегистрированным (иначе им негде его увидеть,
    // войти в аккаунт по этому номеру они не смогут). Бонусы при этом всё равно
    // начислены/списаны — уведомление лишь информирует. Одно сообщение на оба события,
    // чтобы не присылать два подряд за один и тот же заказ.
    if (customer && customer.registered_at && (bonusAward > 0 || bonusRedeemed > 0)) {
      const parts = [`Заказ №${order.id} выполнен.`];
      if (bonusAward > 0) parts.push(`Начислено ${bonusAward} ₸ бонусами.`);
      if (bonusRedeemed > 0) parts.push(`Списано ${bonusRedeemed} ₸ бонусами.`);
      await notifyCustomer(customer.id, parts.join(' '));
    }
    res.json({ success: true, bonusBalance, bonusAwarded: bonusAward, bonusRedeemed });
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

app.post('/api/admin/upload-icon', adminAuth, mw(upload.single('icon')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const filename = await compressUploadedImage(req.file.path);
  res.json({ filename });
});

// Загрузка фото для чата — отдельным запросом (и для клиента, и для админа),
// путь потом прикладывается к самому сообщению через POST /api/me/chat или
// POST /api/admin/chats/:customerId (поле attachment).
app.post('/api/me/chat-upload', customerAuth, mw(uploadChat.single('photo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ path: '/chat-uploads/' + req.file.filename });
});
app.post('/api/admin/chat-upload', adminAuth, mw(uploadChat.single('photo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ path: '/chat-uploads/' + req.file.filename });
});

// Квитанция/чек — отдаём готовый путь, дальше его прикладывают к конкретному действию
// (сейчас только списание бонуса, см. PUT /api/admin/customers/:id/deduct-bonus).
// Не через compressUploadedImage — она умеет только растровые форматы, а тут бывает PDF.
app.post('/api/admin/upload-receipt', adminAuth, mw(uploadReceipt.single('receipt')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ path: '/receipts/' + req.file.filename });
});

// Несколько изображений сразу
app.post('/api/admin/upload-images', adminAuth, mw(upload.array('images', 12)), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Файлы не загружены' });
  const filenames = await Promise.all(req.files.map(f => compressUploadedImage(f.path)));
  res.json({ filenames });
});

// Фото профиля клиента (личный кабинет)
app.post('/api/me/avatar', customerAuth, mw(upload.single('avatar')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const filename = await compressUploadedImage(req.file.path);
  await db.runAsync('UPDATE customers SET avatar = ? WHERE id = ?', ['/icons/' + filename, req.customer.id]);
  res.json({ avatar: '/icons/' + filename });
});

// ==================== UPLOAD ZIP (иконки) ====================
const multerZip = multer({ dest: '/tmp/' });
app.post('/api/admin/upload-icons-zip', adminAuth, multerZip.single('zip'), async (req, res) => {
  const { execSync } = require('child_process');
  const zipPath = req.file.path;
  const outDir = path.join(__dirname, 'public/icons');
  try {
    // Список файлов — до распаковки, той же командой unzip (не fs.readdirSync после:
    // в outDir уже лежат все остальные иконки сайта, нельзя пережимать их все заново
    // при каждой загрузке нового ZIP).
    const names = execSync(`unzip -Z1 "${zipPath}"`).toString().split('\n').map(s => s.trim()).filter(Boolean);
    execSync(`unzip -o "${zipPath}" -d "${outDir}"`);
    // Та же пережимка/конвертация (BMP/TIFF → JPEG и т.д.), что и при обычной загрузке
    // одной иконки — иначе товары, добавленные через ZIP, остаются с необработанными,
    // "сырыми" картинками (замечено на BMP-иконках — отдавались с неверным Content-Type
    // и проваливали оценку производительности в PageSpeed).
    await Promise.all(names.map(name => compressUploadedImage(path.join(outDir, name))));
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

// Просьба оставить отзыв (WhatsApp) — раз в сутки в 10:00 по Алматы, без выходных
// (суббота/воскресенье пропускаем — клиентов не трогаем, когда никто не ответит).
// Берём заказы со статусом "done", выполненные 3+ дня назад, которым ещё не
// отправляли эту просьбу (review_requested_at NULL — см. database.js).
function almatyNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Almaty', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return { hour: parseInt(get('hour'), 10), weekday: get('weekday'), dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}
// Начало суток (00:00) по времени Алматы (UTC+5, без перехода на летнее) — но в UTC,
// потому что именно в UTC хранятся все ts/created_at в базе (datetime('now') у SQLite
// всегда возвращает UTC). Используется статистикой для "Сегодня"/"Вчера" — раньше там
// был datetime('now','start of day'), а это начало суток по UTC, а не по Алматы: ночью,
// пока в Алматы уже новый день, а в UTC (на 5 часов позади) ещё старый, "Сегодня"
// показывало данные за вчера.
function almatyStartOfDay(daysAgo) {
  const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + ALMATY_OFFSET_MS);   // "который час в Алматы", представленный как UTC-время
  shifted.setUTCDate(shifted.getUTCDate() - (daysAgo || 0));
  shifted.setUTCHours(0, 0, 0, 0);                            // начало суток по Алматы (в той же "сдвинутой" шкале)
  const utcInstant = new Date(shifted.getTime() - ALMATY_OFFSET_MS); // обратно в настоящий UTC-момент
  return utcInstant.toISOString().slice(0, 19).replace('T', ' ');   // формат как у datetime('now') в SQLite
}
let lastReviewRunDate = null;
async function runReviewRequestsIfDue() {
  const { hour, weekday, dateKey } = almatyNow();
  if (hour !== 10 || lastReviewRunDate === dateKey) return;
  if (weekday === 'Sat' || weekday === 'Sun') { lastReviewRunDate = dateKey; return; }
  lastReviewRunDate = dateKey;
  // Переключатель в админке — Вовлечённость → Отзывы (по умолчанию включено,
  // пока админ явно не выключил).
  const revCfg = (await getSettings()).reviews_followup;
  if (revCfg && revCfg.enabled === false) return;
  try {
    const rows = await db.allAsync(
      `SELECT * FROM orders WHERE status = 'done' AND completed_at IS NOT NULL
       AND completed_at <= datetime('now', '-3 days') AND review_requested_at IS NULL
       ORDER BY id LIMIT 200`
    );
    for (const order of rows) {
      try {
        const sent = await notify.sendReviewRequest(order);
        await db.runAsync(`UPDATE orders SET review_requested_at = datetime('now') WHERE id = ?`, [order.id]);
        console.log('Отзыв: запрос отправлен по заказу №' + order.id);
        // Журнал действий — кому и что отправили (видно в карточке заказа и в общем
        // журнале, admin='система', т.к. это фоновая задача, а не действие человека).
        const productLabel = sent && sent.productName ? `${sent.productName} — ` : '';
        await db.runAsync(
          `INSERT INTO admin_log (admin, action, label, detail, order_id) VALUES (?,?,?,?,?)`,
          ['система', 'notify', `Отзыв: запрос отправлен — ${order.name || ''} (${order.phone})`,
           `WhatsApp review_request: ${productLabel}${sent && sent.link}`, order.id]
        );
      } catch (e) {
        notify.logFail('review_request', 'заказ №' + order.id + ': ' + e.message);
      }
    }
  } catch (e) {
    notify.logFail('review_request_batch', e.message);
  }
}
// Проверяем раз в час, не наступило ли 10:00 — не раз в сутки таймером, чтобы
// не потерять запуск при перезапуске сервера (pm2) ровно в этот час.
setInterval(() => { runReviewRequestsIfDue().catch(() => {}); }, 60 * 60 * 1000);
runReviewRequestsIfDue().catch(() => {});

app.listen(PORT, () => {
  console.log(`✅ SIGMA MARKET Shop запущен: http://localhost:${PORT}`);
  console.log(`🛠  Админ-панель: http://localhost:${PORT}/admin.html`);
});
