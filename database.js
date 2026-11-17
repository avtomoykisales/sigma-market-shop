const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'sigma.db');
const db = new sqlite3.Database(dbPath);

// Promisified helpers
db.runAsync = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, function(err) { if(err) rej(err); else res(this); }));
db.getAsync = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err, row) => { if(err) rej(err); else res(row); }));
db.allAsync = (sql, params=[]) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if(err) rej(err); else res(rows||[]); }));

db.serialize(async () => {
  await db.runAsync('PRAGMA journal_mode = WAL');

  await db.runAsync(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    description TEXT, icon TEXT
  )`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL, article TEXT, brand TEXT, description TEXT,
    price REAL, price_on_request INTEGER DEFAULT 0,
    unit TEXT DEFAULT 'шт', icon TEXT,
    in_stock INTEGER DEFAULT 1, featured INTEGER DEFAULT 0,
    specs TEXT, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  // Товар может быть виден не только в своей основной категории/подкатегории (category_id/
  // subcategory_id в products — она же определяет URL и хлебные крошки, т.е. "каноническая"),
  // но и дополнительно ещё в одной-нескольких — без дублирования самой карточки товара
  // (другой подход плодил бы дубли контента и путал индексацию в Google).
  await db.runAsync(`CREATE TABLE IF NOT EXISTS product_extra_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    subcategory_id INTEGER,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (subcategory_id) REFERENCES subcategories(id)
  )`);

  // products.featured был просто галочкой "Хит продаж" (0/1) — теперь это НАБОР значков
  // на карточке (товар может быть и "Хит продаж", и "Выгодная цена" одновременно, см.
  // BADGES в server.js/seo.js/index.html), хранится как JSON-массив ключей текстом, тем
  // же способом, что related_ids/bundle_ids/images (см. jsonArr() в server.js). SQLite не
  // проверяет типы строго, так что переводим в одно действие из ЛЮБОЙ более старой схемы:
  // integer 0/1 (самая первая версия) или одиночный текстовый ключ без массива (версия
  // между — только у меня локально во время разработки, на проде её не было).
  try {
    const rows = await db.allAsync(`SELECT id, featured FROM products`);
    for (const r of rows) {
      let next = null;
      if (typeof r.featured === 'number') next = r.featured ? '["hit"]' : '[]';
      else if (typeof r.featured === 'string' && !r.featured.trimStart().startsWith('[')) {
        next = r.featured ? JSON.stringify([r.featured]) : '[]';
      }
      if (next !== null) await db.runAsync(`UPDATE products SET featured = ? WHERE id = ?`, [next, r.id]);
    }
  } catch (e) {}

  await db.runAsync(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, phone TEXT NOT NULL,
    email TEXT, city TEXT, message TEXT,
    items TEXT NOT NULL, total REAL, status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // IP отправителя — чтобы по повторным подозрительным заявкам (боты и т.п.) была видна
  // закономерность. У уже существующих старых заявок будет пусто — это нормально.
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN ip TEXT`); } catch (e) {}
  // Дата закрытия заявки (когда статус стал "Выполнена") — отдельно от created_at
  // (даты поступления заявки), чтобы можно было фильтровать именно по тому, когда
  // сделку реально закрыли, а не когда клиент оставил заявку.
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN completed_at TEXT`); } catch (e) {}
  // Способ оплаты/доставки, выбранные клиентом на шаге оформления заказа в корзине —
  // нужны, чтобы чекаут был полноценным оформлением заказа (с реальным выбором способа
  // оплаты), а не просто формой "оставьте телефон", см. CHECKOUT_PAYMENT_METHODS в server.js.
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN payment_method TEXT`); } catch (e) {}
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN delivery_method TEXT`); } catch (e) {}
  // Когда клиенту отправили просьбу оставить отзыв (WhatsApp, через 3+ дня после
  // выполнения заказа) — NULL, пока не отправили; не даёт слать повторно при каждом
  // прогоне ежедневной задачи (см. runReviewRequestsIfDue в server.js).
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN review_requested_at TEXT`); } catch (e) {}
  // Бонус, который клиент попросил списать при оформлении (см. useBonus в /api/orders) —
  // с его счёта пока НЕ списывается, только сумма заказа уменьшается сразу. Реально
  // списываем и уведомляем клиента только когда заказ подтверждён (см. /api/admin/orders/
  // :id/complete) — если заказ отменят, бонус останется нетронутым, возвращать не придётся.
  // bonus_redeemed_at пуст, пока не списали — не даёт списать второй раз, если заказ
  // зачем-то отметят выполненным повторно.
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN bonus_requested INTEGER DEFAULT 0`); } catch (e) {}
  try { await db.runAsync(`ALTER TABLE orders ADD COLUMN bonus_redeemed_at TEXT`); } catch (e) {}

  await db.runAsync(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, password TEXT NOT NULL
  )`);
  // Роль admin | superadmin — только superadmin может менять бонусы (закрытие/правка
  // заявки, карточка клиента) и управлять другими администраторами. Миграция первый раз:
  // все уже существующие администраторы получают superadmin (чтобы никого не заблокировать
  // задним числом), а понижает их потом сама Мира вручную через панель «Администраторы».
  try {
    await db.runAsync(`ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'`);
    await db.runAsync(`UPDATE admins SET role = 'superadmin'`);
  } catch (e) { /* уже есть */ }

  await db.runAsync(`CREATE TABLE IF NOT EXISTS subcategories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL, slug TEXT NOT NULL,
    description TEXT,
    sort INTEGER DEFAULT 0,
    UNIQUE(category_id, slug),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  )`);

  // ---- Миграции: доп. поля товаров для блоков/фильтров/квиза ----
  const addCol = async (table, col, decl) => {
    try { await db.runAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); return true; }
    catch (e) { return false; /* уже есть */ }
  };
  await addCol('products', 'subtype', 'TEXT');          // тип (Портальная / Туннельная / …) — для фильтра
  await addCol('products', 'perf', 'INTEGER');          // производительность числом — для фильтра-диапазона
  await addCol('products', 'perf_unit', "TEXT DEFAULT 'ед./час'");
  await addCol('products', 'related_ids', "TEXT DEFAULT '[]'");   // аксессуары/запчасти для этой модели
  await addCol('products', 'bundle_ids', "TEXT DEFAULT '[]'");    // «с этим оборудованием берут»
  await addCol('products', 'youtube', 'TEXT');                    // ссылка на видео-обзор
  await addCol('products', 'subtitle', 'TEXT');                   // подзаголовок под названием
  await addCol('products', 'images', "TEXT DEFAULT '[]'");        // доп. изображения (галерея), JSON []
  await addCol('products', 'subcategory_id', 'INTEGER');          // подкатегория (опционально)
  await addCol('subcategories', 'icon', 'TEXT');                  // иконка подкатегории (опционально)
  await addCol('subcategories', 'parent_id', 'INTEGER');         // родительская подкатегория (иерархия)
  await addCol('products', 'contact_primary', 'TEXT');           // какой контакт показывать первым: '1' | '2' | null (= основной)
  await addCol('orders', 'source', "TEXT DEFAULT 'site'");       // site (с сайта) | manual (создан админом)
  await addCol('orders', 'customer_id', 'INTEGER');               // зарегистрированный клиент, если оформлял вошедшим
  await addCol('orders', 'company', 'TEXT');                      // название компании клиента (заполняется в админке)
  await addCol('products', 'sort_order', 'INTEGER DEFAULT 0');    // ручной порядок показа в каталоге (перетаскивание в админке)

  // ---- SEO-переопределения (пусто → генерируется автоматически) ----
  await addCol('products', 'seo_title', 'TEXT');
  await addCol('products', 'seo_description', 'TEXT');
  await addCol('categories', 'seo_title', 'TEXT');
  await addCol('categories', 'seo_description', 'TEXT');
  await addCol('subcategories', 'seo_title', 'TEXT');
  await addCol('subcategories', 'seo_description', 'TEXT');

  // FAQ-блок раздела (вопросы-ответы на странице категории/подкатегории + разметка
  // FAQPage для Google) — JSON-массив пар [вопрос, ответ], редактируется в админке.
  await addCol('categories', 'faq', "TEXT DEFAULT '[]'");
  await addCol('subcategories', 'faq', "TEXT DEFAULT '[]'");

  // Включение в фид Google Merchant Center (см. merchantFeed() в seo.js) — реально решает
  // только products.in_feed, фид смотрит только на него. Галочка у категории/подкатегории —
  // не постоянное ограничение, а разовое массовое действие: переключили — сразу
  // проставляется то же значение всем товарам внутри (см. PUT /api/admin/categories/:id и
  // /api/admin/subcategories/:id в server.js); дальше товары донастраиваются по отдельности.
  await addCol('categories', 'in_feed', 'INTEGER DEFAULT 1');
  await addCol('subcategories', 'in_feed', 'INTEGER DEFAULT 1');
  await addCol('products', 'in_feed', 'INTEGER DEFAULT 1');
  // Скидка на товар — процент + необязательная дата окончания (YYYY-MM-DD). Пусто в
  // discount_until = скидка действует, пока её не уберут вручную в админке. Сама цена
  // (products.price) при этом остаётся "настоящей"/базовой — скидка считается на лету
  // при показе (см. applyDiscount в queries.js), чтобы админ в форме товара всегда видел
  // и правил именно базовую цену, а не уже уценённую.
  await addCol('products', 'discount_percent', 'INTEGER DEFAULT 0');
  await addCol('products', 'discount_until', 'TEXT');
  // Альтернатива проценту — готовая цена со скидкой (вместо "−N%"), для случаев, когда
  // удобнее просто назначить конечную цену, а не считать процент в уме. Если заполнен
  // процент — используется он (см. applyDiscount), discount_price игнорируется.
  await addCol('products', 'discount_price', 'REAL');
  // Скрыть товар с сайта, не удаляя его — для случаев вроде "этот бренд сейчас снят с
  // продажи" (товар остаётся в админке и доступен для возврата галочкой назад, но не
  // показывается в каталоге/поиске/карточке/фиде/sitemap). По умолчанию виден (1).
  await addCol('products', 'published', 'INTEGER DEFAULT 1');

  // URL товара (/product/{id}-{slug}) раньше всегда собирался на лету из ТЕКУЩЕГО названия —
  // стоило переименовать товар в админке, и уже проиндексированный Google/Яндексом старый
  // адрес переставал совпадать с новым canonical (Search Console жаловался на «дубли с другим
  // canonical»). Теперь slug сохраняется один раз при создании товара и больше не меняется
  // сам при редактировании названия (см. POST/PUT /api/admin/products в server.js). Здесь —
  // разовый бэкфилл для уже существующих товаров, чтобы у них тоже появился "замороженный"
  // slug, сейчас совпадающий с текущим названием (чтобы не менять уже рабочие ссылки).
  await addCol('products', 'slug', 'TEXT');
  {
    const TRANSLIT_RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
    const noSlug = await db.allAsync(`SELECT id, name FROM products WHERE slug IS NULL OR slug = ''`);
    for (const row of noSlug) {
      const slug = String(row.name || '').toLowerCase()
        .replace(/[а-яё]/g, (ch) => (TRANSLIT_RU[ch] != null ? TRANSLIT_RU[ch] : ch))
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
      await db.runAsync(`UPDATE products SET slug = ? WHERE id = ?`, [slug, row.id]);
    }
  }

  // Универсальный список фильтров по характеристикам — для каждой подкатегории свой,
  // JSON-массив названий характеристик (как они названы в поле "Характеристики" у
  // товара), которые включены фильтром именно здесь. Тип фильтра (список значений вроде
  // "Да/Нет" или диапазон "от-до") определяется на лету по самим данным (см. queries.js,
  // SPEC_FILTER_IS_NUMERIC) — не нужно отдельно указывать для каждой характеристики.
  // Раньше тут были 3 отдельные колонки под 3 конкретные характеристики (filter_power/
  // filter_seat/filter_perfarea) — переносим их значения в новый формат один раз, дальше
  // этими старыми колонками уже не пользуемся (оставлены в БД просто чтобы не писать
  // миграцию по удалению столбца).
  const specFiltersColAdded = await addCol('subcategories', 'filter_specs', "TEXT DEFAULT '[]'");
  if (specFiltersColAdded) {
    const hasLegacyCols = await db.allAsync(`PRAGMA table_info(subcategories)`)
      .then(cols => cols.some(c => c.name === 'filter_power'));
    if (hasLegacyCols) {
      const rows = await db.allAsync(`SELECT id, filter_power, filter_seat, filter_perfarea FROM subcategories`);
      for (const r of rows) {
        const keys = [];
        if (r.filter_power) keys.push('Тип питания');
        if (r.filter_seat) keys.push('Сиденье для оператора');
        if (r.filter_perfarea) keys.push('Производительность по площади');
        if (keys.length) await db.runAsync(`UPDATE subcategories SET filter_specs = ? WHERE id = ?`, [JSON.stringify(keys), r.id]);
      }
    }
  }

  // Категория Google Merchant Center для товаров этой подкатегории — вручную, текстом
  // (как её показывает сама форма Merchant Center, например "Бизнес и промышленность")
  // или числовым ID из таксономии Google. Если не заполнено — тег google_product_category
  // в фиде (seo.js/merchantFeed) просто не отправляется, и Google определяет категорию
  // сам — так Мира попросила вместо того, чтобы всем неизвестным товарам подряд
  // проставлять общую "Бизнес и промышленность" по умолчанию.
  await addCol('subcategories', 'google_category', 'TEXT');

  // Скрыть всю категорию/подкатегорию с сайта (навигация, каталог, поиск, фид) — та же
  // кнопка и тот же разовый каскад в товары, что уже есть у "Рекламировать в Google
  // Merchant Center" (in_feed): включили/выключили — сразу проставляется всем вложенным
  // подкатегориям и товарам, дальше можно точечно донастроить отдельный товар отдельно.
  await addCol('categories', 'published', 'INTEGER DEFAULT 1');
  await addCol('subcategories', 'published', 'INTEGER DEFAULT 1');

  // Фото/видео реализованных проектов на странице подкатегории (под описанием) — JSON-
  // массив [{type:'photo', file:'xxx.jpg'}, {type:'video', url:'https://youtube.com/...'}]
  // в порядке показа. Фото хранятся как файлы в public/icons (как и иконки товаров),
  // видео — просто ссылкой на YouTube, без хранения самого файла на сервере.
  await addCol('subcategories', 'gallery', "TEXT DEFAULT '[]'");

  // ---- Статьи (экспертный контент: ответы на вопросы покупателей, разборы и сравнения
  // оборудования) — для SEO и ИИ-поисковиков (ChatGPT/Perplexity и т.п.), которым нужен
  // не каталог, а связный текст, отвечающий на конкретный вопрос. Публикуется в админке.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    excerpt TEXT, content TEXT, cover TEXT,
    seo_title TEXT, seo_description TEXT,
    published INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug)`);

  // ---- Журнал действий администраторов ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    admin TEXT,                 -- логин администратора (или '—' при неудачном входе)
    action TEXT,                -- login | login_fail | create | update | delete
    label TEXT,                 -- человекочитаемое описание («Добавлен товар «X»»)
    detail TEXT,                -- доп. детали (опционально)
    ip TEXT
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_admin_log_ts ON admin_log(id DESC)`);
  await addCol('admin_log', 'order_id', 'INTEGER');   // чтобы показывать журнал конкретной заявки в её карточке
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_admin_log_order ON admin_log(order_id)`);
  await addCol('admin_log', 'customer_id', 'INTEGER');   // то же самое, но для карточки клиента
  await addCol('admin_log', 'attachment', 'TEXT');   // путь к приложенному файлу (напр. чек при списании бонуса), необязательно
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_admin_log_customer ON admin_log(customer_id)`);

  // ---- Статистика сайта: просмотры страниц, поисковые запросы, просмотры товаров ----
  // Лёгкий свой счётчик для админки (в дополнение к Яндекс.Метрике на самом сайте) —
  // чтобы не переключаться на другой сайт ради топа поисковых запросов и товаров.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS stats_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    type TEXT,        -- pageview | search | product_view
    path TEXT,         -- адрес страницы (для pageview)
    value TEXT,         -- поисковый запрос / название товара
    ref_id INTEGER       -- id товара (для product_view)
  )`);
  // IP — чтобы в «Когда и что смотрели» в админке было видно, один и тот же
  // посетитель повторяет заходы на одну страницу (похоже на проблему с рекламой/
  // ботами) или это разные люди.
  try { await db.runAsync(`ALTER TABLE stats_events ADD COLUMN ip TEXT`); } catch (e) {}
  // User-Agent — честные боты (Google/Яндекс/простые скрипты) сами о себе пишут в UA,
  // это видно сразу. Настоящий скликивающий бот обычно маскируется под телефон, так что
  // это не защита от фрода, а просто ещё один факт для глаз в том же отчёте.
  try { await db.runAsync(`ALTER TABLE stats_events ADD COLUMN ua TEXT`); } catch (e) {}
  // Источник визита: referrer (откуда пришли — Google, Яндекс, сам сайт и т.п.) и
  // исходная строка запроса (там же, где gclid/utm-метки рекламы, если переход с рекламы).
  try { await db.runAsync(`ALTER TABLE stats_events ADD COLUMN ref TEXT`); } catch (e) {}
  try { await db.runAsync(`ALTER TABLE stats_events ADD COLUMN entry_query TEXT`); } catch (e) {}
  // Номер телефона/WhatsApp, по которому реально кликнули (кнопка "Позвонить"/WhatsApp) —
  // когда в настройках указано два номера, иначе видно только, что кликнули "звонок",
  // но не ясно, по какому из них.
  try { await db.runAsync(`ALTER TABLE stats_events ADD COLUMN phone TEXT`); } catch (e) {}
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_stats_events_type_ts ON stats_events(type, ts)`);

  // ---- Ошибки на сайте (JS-ошибки у посетителей, видно в админке) ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS client_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    message TEXT,
    context TEXT,       -- откуда: submitOrder | submitConsult | window.onerror | ...
    url TEXT,
    ip TEXT
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_client_errors_ts ON client_errors(id DESC)`);

  // ---- Отзывы (форма на карточке товара + общая страница /reviews), после модерации ----
  // product_id пустой = общий отзыв о компании (страница /reviews), иначе — отзыв на товар.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    name TEXT NOT NULL,
    phone TEXT,                       -- необязательно, для связи, на сайте не показывается
    company TEXT,                     -- необязательно: «компания, город» — только для общих отзывов
    rating INTEGER NOT NULL,          -- 1..5
    text TEXT,
    status TEXT DEFAULT 'pending',    -- pending | approved | rejected
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status)`);

  // ---- Комментарии к статьям (форма под статьёй), после модерации — тот же принцип, что
  // и у отзывов на товары выше, но без оценки (звёзд), статья — не товар, тут не рейтинг,
  // а мнение/обсуждение.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS article_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT DEFAULT 'pending',    -- pending | approved | rejected
    reply TEXT,                       -- официальный ответ администрации, показывается под комментарием
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_article_comments_article ON article_comments(article_id, status)`);

  // ---- Примечания менеджеров к заказам (история обработки) ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS order_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    admin TEXT,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_order_notes_order ON order_notes(order_id)`);
  await addCol('order_notes', 'remind_at', 'TEXT');   // дата напоминания (YYYY-MM-DD), необязательно

  // ---- Зарегистрированные клиенты сайта + бонусы ----
  // Вход без пароля — по одноразовому коду в WhatsApp (резерв — SMS), см. otp_codes.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    bonus_balance INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Раньше тут была обратная миграция (убирали password_hash, переходили на вход по
  // одноразовому коду без пароля). Теперь вход снова по паролю (email/Telegram) — см.
  // password_hash/telegram_id ниже через addCol. Саму авто-миграцию убрали: иначе она
  // бы при каждом запуске сервера тут же стирала password_hash обратно.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS customer_sessions (
    token TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS bonus_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,        -- +начислено / -списано
    reason TEXT,                   -- register | order_earn | order_redeem
    order_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`);
  // ---- Одноразовые коды входа (WhatsApp, резерв — SMS) ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone)`);

  // ---- Скачивание КП с сайта (после подтверждения телефона по коду) ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS kp_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_kp_leads_created ON kp_leads(id DESC)`);

  // ---- Уведомления клиенту (личный кабинет → «Мои уведомления») ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id, id DESC)`);
  // NULL — ещё не прочитано (показываем красным числом рядом с "Мои уведомления" в
  // личном кабинете); проставляется при открытии вкладки, см. /api/me/notifications/read.
  await addCol('notifications', 'read_at', 'TEXT');

  // ---- Чат клиент ↔ админ (личный кабинет «Чат с нами» / админка «Чат») ----
  // sender: 'customer' | 'admin'. admin — логин админа, который ответил (NULL у сообщений
  // клиента). read_at — когда сообщение прочитала ДРУГАЯ сторона (у сообщений клиента —
  // когда прочитал админ, у сообщений админа — когда прочитал клиент); NULL — ещё не
  // прочитано, по нему считаем бейджи непрочитанного с обеих сторон.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    admin TEXT,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    read_at TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_chat_messages_customer ON chat_messages(customer_id, id DESC)`);
  await addCol('chat_messages', 'attachment', 'TEXT');   // путь к приложенному фото, необязательно

  // Дата настоящей регистрации (сам вошёл по коду) — отдельно от created_at, который
  // проставляется и когда запись клиента создаётся автоматически при начислении бонуса
  // за заказ (клиент сам ничего не регистрировал, это не «регистрация»).
  await addCol('customers', 'registered_at', 'TEXT');

  // ---- Личный кабинет: аватар, избранное, «мои отзывы» ----
  await addCol('customers', 'avatar', 'TEXT');       // путь к загруженному фото профиля
  await addCol('customers', 'company', 'TEXT');       // название компании клиента (заполняет сам в личном кабинете)
  await addCol('customers', 'city', 'TEXT');          // город клиента (заполняется в админке)
  await addCol('customers', 'comment', 'TEXT');       // внутренняя заметка админа о клиенте — клиент её не видит
  await addCol('customers', 'corp_phone', 'TEXT');    // корпоративный номер (доп. контакт, не для входа)
  await addCol('customers', 'extra_phone', 'TEXT');   // ещё один доп. номер (доп. контакт, не для входа)

  // ---- Номер клиента (показывается в админке и личном кабинете вместо внутреннего id) ----
  // customers.id — чисто внутренний технический ключ (на него ссылаются заказы, бонусы,
  // чат и т.д.) — его лучше никогда не менять задним числом, иначе придётся вручную
  // перепривязывать кучу других таблиц. client_no — отдельный, видимый клиенту/админу
  // номер, им можно управлять свободно (нумерация с 2261 — см. nextClientNo() в server.js).
  await addCol('customers', 'client_no', 'INTEGER');
  await db.runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_client_no ON customers(client_no) WHERE client_no IS NOT NULL`);
  // Бэкфилл для уже существующих клиентов, у которых номера ещё нет — по порядку
  // регистрации (id), начиная с 2261. Апдейт трогает только NULL, так что безопасно
  // гонять при каждом запуске сервера — новым клиентам номер уже присваивается при создании.
  await db.runAsync(`
    UPDATE customers SET client_no = (
      SELECT 2260 + COUNT(*) FROM customers c2 WHERE c2.id <= customers.id
    ) WHERE client_no IS NULL
  `);

  // ---- Вход по email+паролю и/или Telegram (см. auth.js) ----
  // password_hash пустой у клиентов, пришедших только через Telegram — вход у них через
  // виджет, не через пароль. phone остаётся обязательным для начисления бонусов, но
  // спрашивается отдельным шагом после подтверждения email/Telegram, не как логин.
  await addCol('customers', 'password_hash', 'TEXT');
  await addCol('customers', 'telegram_id', 'TEXT');
  await db.runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_telegram ON customers(telegram_id) WHERE telegram_id IS NOT NULL`);
  // Email у старых клиентов (регистрировались по телефону) мог не быть уникальным/быть
  // пустым — уникальный индекс только там, где email реально задан.
  await db.runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email IS NOT NULL AND email != ''`);

  // Коды подтверждения email при регистрации — тот же принцип, что раньше был у
  // otp_codes (для телефона), только по email и с более коротким временем жизни токена
  // подтверждения (verified_token), который разрешает следующий шаг (телефон+пароль)
  // без повторного ввода кода.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Короткоживущий "билет" на завершение регистрации — выдаётся сразу после верного
  // кода, чтобы шаг "телефон + пароль" не требовал повторно слать код на почту.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS email_verified_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  await addCol('reviews', 'customer_id', 'INTEGER'); // кто оставил отзыв, если был вошедшим (для "Мои отзывы")
  await addCol('reviews', 'reply', 'TEXT'); // официальный ответ администрации, показывается под отзывом на сайте
  // Когда начислен бонус за этот отзыв (при публикации, см. PUT /api/admin/reviews/:id) —
  // NULL, пока не начислен; не даёт начислить повторно, если отзыв сняли и опубликовали снова.
  await addCol('reviews', 'bonus_awarded_at', 'TEXT');
  await db.runAsync(`CREATE TABLE IF NOT EXISTS customer_favorites (
    customer_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (customer_id, product_id),
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);

  // ---- Настройки сайта (редактируются в админке) ----
  await db.runAsync(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

  // Шаг "type" ветвится по ответу на "biz" (optionsByBranch вместо options) — у каждого
  // бизнеса свой набор техники, и общий вопрос "поток/объём" (старая версия) сравнивал
  // несравнимые единицы измерения производительности (л/ч, м³/ч, машин/час и т.д.) —
  // отсюда и неточные подборки. Теперь вопрос №2 сразу бьёт по реальной подкатегории.
  const DEFAULT_QUIZ = {
    enabled: true,
    title: 'Подбор оборудования',
    subtitle: 'Ответьте на несколько вопросов — покажем подходящие модели',
    steps: [
      { key: 'biz', label: 'Тип бизнеса', options: [
        { id: 'wash',  label: 'Автомойка',           category: 'avtomojka' },
        { id: 'sto',   label: 'СТО / Шиномонтаж',     category: 'sto' },
        { id: 'clean', label: 'Клининговая компания', category: 'klining' }
      ]},
      // "Очистные сооружения"/"Доп. оборудование" (wash) и варианты СТО — уже конечный
      // выбор, сразу subcategory, без третьего шага. А "Пылесосы", "Аппараты высокого
      // давления", "Автоматические мойки", "Поломоечная"/"Подметальная машина" —
      // ещё не конечный: у них есть третий шаг (см. "subtype" ниже), поэтому тут без
      // subcategory, его подставит выбор на третьем шаге. Бюджет убрали отдельным шагом —
      // вместо фильтра по деньгам показываем сразу список на выбор (см. /api/products/quiz).
      { key: 'type', label: 'Какое оборудование интересует?', branchBy: 'biz', optionsByBranch: {
        wash: [
          { id: 'pylesos', label: 'Пылесосы' },
          { id: 'avd',     label: 'Аппараты высокого давления' },
          { id: 'auto',    label: 'Автоматические мойки' },
          { id: 'ochistka',label: 'Очистные сооружения',         subcategory: 'ochistnye-sooruzheniya-dlya-avtomoyki' },
          { id: 'extra',   label: 'Доп. оборудование для комплекса', subcategory: 'dopolnitelnoe-oborudovanie-dlya-avtomoechnyh-kom' }
        ],
        sto: [
          { id: 'shina',   label: 'Шиномонтажное оборудование',     subcategory: 'shinomontazhnoe-oborudovanie' },
          { id: 'balans',  label: 'Балансировочные станки',          subcategory: 'balansirovochnye-stanki-dlya-shinomontazha' },
          { id: 'podemnik',label: 'Автоподъёмники',                  subcategory: 'avtopodemniki-dlya-sto-i-avtoservisa' },
          { id: 'press',   label: 'Гидравлические прессы',           subcategory: 'pressy-gidravlicheskie-dlya-sto-i-avtoservisa' },
          { id: 'compr',   label: 'Компрессоры',                     subcategory: 'kompressory-porshnevye-vozdushnye' },
          { id: 'pnevmo',  label: 'Пневматическое оборудование',     subcategory: 'pnevmaticheskoe-oborudovanie' },
          { id: 'maslo',   label: 'Оборудование для замены масла',   subcategory: 'oborudovanie-dlya-zameny-masla-samoa' }
        ],
        clean: [
          { id: 'pylesos_klining', label: 'Пылесосы' },
          { id: 'polomoyka', label: 'Поломоечная машина' },
          { id: 'podmet',    label: 'Подметальная машина' }
        ]
      }},
      // Третий шаг — только для тех ответов второго шага, где он реально нужен (см.
      // quizStepOptions на клиенте и ту же логику на сервере — остальные ветки сразу
      // уходят в результаты). "Автономные" ищем по слову "бензин" в названии (отдельной
      // подкатегории под это на сайте нет) — nameKeyword. "По площади" — по характеристике
      // "Производительность по площади" у товара (specKey), а не по подкатегории: если
      // характеристика не заполнена, товар просто не покажется в выдаче (не выдумываем).
      { key: 'subtype', label: 'Уточните вариант', branchBy: 'type', optionsByBranch: {
        pylesos: [
          { id: 'pylesos_vac',  label: 'Пылеводосос',                          subcategory: 'professionalnye-pylevodososy' },
          { id: 'pylesos_extr', label: 'Пылесос для влажной уборки (экстрактор)', subcategory: 'professionalnye-pylesosy-ekstraktory' },
          { id: 'pylesos_steam',label: 'Парогенератор',                        subcategory: 'professionalnye-parogeneratory' },
          { id: 'pylesos_prom', label: 'Промышленный пылесос',                 subcategory: 'promyshlennye-pylesosy' }
        ],
        // У "Клининга" для пылесосов — СВОИ подкатегории в каталоге (не те же самые, что
        // у "Автомойки" выше, хоть названия и совпадают) — отдельный slug на сайте для
        // каждой из них, поэтому отдельная ветка, а не общая с "pylesos". Если бы использовали
        // те же slug'и — товары не находились бы вовсе (категория у них в базе другая) и
        // квиз откатывался бы к показу всего подряд из категории "Клининг".
        pylesos_klining: [
          { id: 'pylesos_vac',  label: 'Пылеводосос',                          subcategory: 'professional-nye-pylevodososy' },
          { id: 'pylesos_extr', label: 'Пылесос для влажной уборки (экстрактор)', subcategory: 'professional-nye-moyuschie-pylesosy-ekstraktory' },
          { id: 'pylesos_steam',label: 'Парогенератор',                        subcategory: 'professional-nye-parogeneratory' },
          { id: 'pylesos_prom', label: 'Промышленный пылесос',                 subcategory: 'promyshlennye-pylesosy' }
        ],
        avd: [
          { id: 'avd_cold', label: 'Без подогрева',          subcategory: 'moyka-holodnoy-vodoy' },
          { id: 'avd_hot',  label: 'С подогревом',           subcategory: 'moyka-goryachey-vodoy' },
          { id: 'avd_auto', label: 'Автономные (бензиновые)', scopeSubcategory: 'apparaty-vysokogo-davleniya-avd', nameKeyword: 'бензин' }
        ],
        auto: [
          { id: 'auto_legk', label: 'Для легковых авто',  subcategory: 'avtomaticheskie-moyki-dlya-mashin-robotizirovann' },
          { id: 'auto_gruz', label: 'Для грузовых авто',  subcategory: 'avtomaticheskie-moyki-dlya-gruzovyh-avtomobiley' }
        ],
        polomoyka: [
          { id: 'area_s', label: 'Площадь до 1500 м²',        scopeSubcategory: 'polomoechnye-mashiny', specKey: 'Производительность по площади', specMax: 1500 },
          { id: 'area_m', label: 'Площадь 1500–2500 м²',      scopeSubcategory: 'polomoechnye-mashiny', specKey: 'Производительность по площади', specMin: 1500, specMax: 2500 },
          { id: 'area_l', label: 'Площадь более 2500 м²',     scopeSubcategory: 'polomoechnye-mashiny', specKey: 'Производительность по площади', specMin: 2500 }
        ],
        podmet: [
          { id: 'area_s', label: 'Площадь до 1500 м²',        scopeSubcategory: 'podmetalnye-mashiny', specKey: 'Производительность по площади', specMax: 1500 },
          { id: 'area_m', label: 'Площадь 1500–2500 м²',      scopeSubcategory: 'podmetalnye-mashiny', specKey: 'Производительность по площади', specMin: 1500, specMax: 2500 },
          { id: 'area_l', label: 'Площадь более 2500 м²',     scopeSubcategory: 'podmetalnye-mashiny', specKey: 'Производительность по площади', specMin: 2500 }
        ]
      }}
    ]
  };

  const defaultSettings = {
    blocks:    JSON.stringify({ accessories: true, bundle: true, similar: true, recent: true }),
    filters:   JSON.stringify({ enabled: true, brand: true, subtype: true, price: true, perf: true }),
    compare:   'true',
    favorites: 'true',
    quiz:      JSON.stringify(DEFAULT_QUIZ),
    contacts:  JSON.stringify({ phone1: '+7 (707) 420-20-03', phone2: '' }),
    crm:       JSON.stringify({ bitrix_webhook: '' }),
    bonus:     JSON.stringify({ enabled: true, visible: false, register_bonus: 500, earn_percent: 3 })
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    await db.runAsync(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  }
  db.DEFAULT_QUIZ = DEFAULT_QUIZ;

  // Categories seed — только если таблица пуста (после реального импорта не трогаем)
  const catCount = await db.getAsync('SELECT COUNT(*) as cnt FROM categories');
  if (catCount.cnt === 0) {
    const cats = [
      ['Автомойки','avtomoyki','Портальные, туннельные и роботизированные комплексы','cat-wash.png'],
      ['СТО и автосервис','sto','Оборудование для ремонта и обслуживания автомобилей','cat-sto.png'],
      ['Клининг','klining','Профессиональные машины и инвентарь для уборки','cat-clean.png'],
      ['Системы очистки и водоподготовки','voda','Системы фильтрации и водоподготовки','cat-water.png'],
      ['Аксессуары и запчасти','aksessuary','Запчасти, расходники и аксессуары','cat-parts.png'],
      ['Промышленное оборудование','promyshlennoe','Решения для производственных предприятий','cat-industrial.png'],
    ];
    for (const c of cats) {
      await db.runAsync(`INSERT OR IGNORE INTO categories (name,slug,description,icon) VALUES (?,?,?,?)`, c);
    }
  }

  // Иконки категорий: копируем стандартные из assets в /icons/ (чтобы работал единый путь),
  // и чиним старые значения icon у сидовых категорий
  const catIconFix = await db.getAsync(`SELECT value FROM settings WHERE key='caticons_v1'`);
  if (!catIconFix) {
    const fs = require('fs');
    const srcDir = path.join(__dirname, 'public/assets/icons');
    const dstDir = path.join(__dirname, 'public/icons');
    try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
    for (const f of ['cat-wash.png','cat-sto.png','cat-clean.png','cat-water.png','cat-parts.png','cat-industrial.png']) {
      try { if (fs.existsSync(path.join(srcDir, f)) && !fs.existsSync(path.join(dstDir, f))) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); } catch {}
    }
    const iconMap = { 'car-wash.png':'cat-wash.png','sto.png':'cat-sto.png','cleaning.png':'cat-clean.png','water.png':'cat-water.png','accessories.png':'cat-parts.png','industrial.png':'cat-industrial.png' };
    for (const [oldn, newn] of Object.entries(iconMap)) {
      await db.runAsync(`UPDATE categories SET icon=? WHERE icon=?`, [newn, oldn]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO settings (key,value) VALUES ('caticons_v1','done')`);
    console.log('✅ Иконки категорий приведены к /icons/');
  }

  // Admin seed — пароль из ENV, иначе разовый случайный (печатается в лог)
  const adminExists = await db.getAsync('SELECT COUNT(*) as c FROM admins');
  if (adminExists.c === 0) {
    const pw = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
    await db.runAsync(`INSERT INTO admins (username,password) VALUES (?,?)`, ['admin', pw]);
    if (!process.env.ADMIN_PASSWORD) console.log('⚠️  Сгенерирован пароль администратора:', pw, '— смените командой UPDATE admins.');
  }

  // ---- Однократный бэкфилл: subtype / perf / связанные товары ----
  const bf = await db.getAsync(`SELECT value FROM settings WHERE key='backfill_v1'`);
  if (!bf) {
    const all = await db.allAsync('SELECT id, category_id, brand, price, price_on_request, specs FROM products');
    const numFrom = (s) => { const m = String(s || '').match(/(\d[\d\s.,]*)/); return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null; };
    for (const p of all) {
      let sp = {}; try { sp = JSON.parse(p.specs || '{}'); } catch {}
      const subtype = sp['Тип'] || null;
      const perf = numFrom(sp['Производительность'] || sp['Ширина захвата'] || '');
      // аксессуары: недорогие товары той же категории
      const acc = all.filter(x => x.category_id === p.category_id && x.id !== p.id
        && !x.price_on_request && x.price > 0 && x.price < 200000).slice(0, 6).map(x => x.id);
      // «с этим берут»: другие заметные товары той же категории
      const bundle = all.filter(x => x.category_id === p.category_id && x.id !== p.id
        && (x.price >= 200000 || x.price_on_request)).slice(0, 4).map(x => x.id);
      await db.runAsync(
        `UPDATE products SET subtype=?, perf=?, related_ids=?, bundle_ids=? WHERE id=?`,
        [subtype, perf, JSON.stringify(acc), JSON.stringify(bundle), p.id]
      );
    }
    await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('backfill_v1','done')`);
    console.log('✅ Бэкфилл subtype/perf/связей выполнен');
  }

  // ---- Подкатегории: сид + автопривязка товаров по ключевым словам ----
  const sc = await db.getAsync(`SELECT value FROM settings WHERE key='subcats_v1'`);
  if (!sc) {
    const catId = async (slug) => (await db.getAsync('SELECT id FROM categories WHERE slug=?', [slug]) || {}).id;
    // [катслаг, слаг, название, [ключевые слова в названии товара]]
    const seed = [
      ['avtomoyki', 'portalnye',   'Портальные мойки',        ['портальн']],
      ['avtomoyki', 'tunnelnye',   'Туннельные мойки',        ['туннельн']],
      ['avtomoyki', 'robot',       'Роботизированные мойки',  ['роботизирован']],
      ['avtomoyki', 'apparaty-vd', 'Аппараты высокого давления', ['высокого давления', 'аппарат вд']],
      ['avtomoyki', 'himiya',      'Химия и расходники',      ['химия', 'пена', 'воск', 'шампун']],
      ['sto',       'podyemniki',  'Подъёмники',              ['подъёмник', 'подъемник']],
      ['sto',       'shinomontazh','Шиномонтаж и балансировка', ['шиномонтаж', 'балансиров']],
      ['sto',       'kompressory', 'Компрессоры',             ['компрессор']],
      ['sto',       'instrument',  'Инструмент',              ['ключ', 'гайковёрт', 'гайковерт', 'тележка инструмент', 'набор']],
      ['klining',   'polomoechnye','Поломоечные машины',      ['поломоечн']],
      ['klining',   'podmetalnye', 'Подметальные машины',     ['подметальн']],
      ['klining',   'pylesosy',    'Пылесосы и экстракторы',  ['пылесос', 'экстрактор', 'пылеводос']],
      ['klining',   'inventar',    'Инвентарь и химия',       ['швабра', 'моп', 'тележк', 'дозатор', 'средство', 'салфет', 'микрофибр']],
      ['voda',      'osmos',       'Обратный осмос',          ['обратн', 'осмос', 'ro-']],
      ['voda',      'ochistka',    'Очистка стоков',          ['жироуловитель', 'сепаратор', 'флотац', 'нейтрализ']],
      ['voda',      'umyagchenie', 'Умягчение и фильтрация',  ['умягчител', 'фильтр', 'картридж']],
      ['promyshlennoe', 'kompressornoe', 'Компрессорное оборудование', ['компрессор', 'ресивер', 'осушитель']],
      ['promyshlennoe', 'svarka',       'Сварка и резка',            ['сварочн', 'плазменн', 'аргонодугов']],
      ['promyshlennoe', 'gruzopodyem',  'Грузоподъёмное',            ['кран', 'таль', 'погрузчик', 'домкрат']],
    ];
    const scByCat = {};   // {catId: [{id, kw}]}
    let ord = 0;
    for (const [cslug, slug, name, kw] of seed) {
      const cid = await catId(cslug);
      if (!cid) continue;
      await db.runAsync(
        `INSERT OR IGNORE INTO subcategories (category_id, slug, name, sort) VALUES (?,?,?,?)`,
        [cid, slug, name, ord++]);
      const row = await db.getAsync('SELECT id FROM subcategories WHERE category_id=? AND slug=?', [cid, slug]);
      (scByCat[cid] = scByCat[cid] || []).push({ id: row.id, kw });
    }
    // автопривязка товаров
    const prods = await db.allAsync('SELECT id, category_id, name FROM products WHERE subcategory_id IS NULL');
    for (const p of prods) {
      const opts = scByCat[p.category_id] || [];
      const nm = p.name.toLowerCase();
      const hit = opts.find(o => o.kw.some(k => nm.includes(k)));
      if (hit) await db.runAsync('UPDATE products SET subcategory_id=? WHERE id=?', [hit.id, p.id]);
    }
    await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('subcats_v1','done')`);
    console.log('✅ Подкатегории созданы и привязаны');
  }

  // ---- Иерархия подкатегорий: восстановить дерево «групп» со старого сайта avtomoyki.kz ----
  const treeDone = await db.getAsync(`SELECT value FROM settings WHERE key='subcat_tree_v1'`);
  if (!treeDone) {
    const TREE = {   // родитель(slug) -> [дети(slug)]
      'professionalnye-pylesosy': ['moyuschie-pylesosy-elsea', 'professionalnye-pylesosy-soteco',
        'professionalnye-pylesosy-chancee', 'professionalnye-moyuschie-pylesosy',
        'professionalnye-pylevodososy', 'pylesosy-ekstraktory'],
      'avtomaticheskie-moyki-dlya-mashin-robotizirovann': ['portalnye-avtomoyki',
        'avtomaticheskie-konveyernye-avtomoyki-tunnelnogo', 'beskontaktnye-robotizirovannye-avtomoyki'],
      'apparaty-vysokogo-davleniya-avd': ['moyki-vysokogo-davleniya-dlya-avto'],
      'moyki-vysokogo-davleniya-dlya-avto': ['professionalnye-moyki-vysokogo-davleniya',
        'moyki-vysokogo-davleniya-s-podogrevom-vody', 'promyshlennye-moyki-vysokogo-davleniya',
        'benzinovye-moyki-vysokogo-davleniya'],
      'avtopodemniki-dlya-sto-i-avtoservisa': ['dvuhstoechnye-podemniki',
        'chetyrehstoechnye-podemniki', 'nozhnichnye-podemniki-dlya-avto'],
      'pnevmaticheskoe-oborudovanie': ['professionalnye-kompressory-porshnevye-marki-sob',
        'pnevmaticheskoe-oborudovanie-chicago-pneumatic'],
      'oborudovanie-dlya-zameny-masla-samoa': ['maslorazdatochnoe-oborudovanie',
        'oborudovanie-dlya-konsistentnoy-smazki'],
    };
    for (const [parentSlug, childSlugs] of Object.entries(TREE)) {
      const par = await db.getAsync('SELECT id FROM subcategories WHERE slug = ?', [parentSlug]);
      if (!par) continue;
      for (const cs of childSlugs) {
        await db.runAsync('UPDATE subcategories SET parent_id = ? WHERE slug = ? AND parent_id IS NULL', [par.id, cs]);
      }
    }
    await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('subcat_tree_v1','done')`);
    console.log('✅ Иерархия подкатегорий восстановлена');
  }
});

module.exports = db;
