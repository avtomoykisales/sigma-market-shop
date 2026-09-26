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

  await db.runAsync(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, phone TEXT NOT NULL,
    email TEXT, city TEXT, message TEXT,
    items TEXT NOT NULL, total REAL, status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

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
    try { await db.runAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); } catch (e) { /* уже есть */ }
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
  // Миграция со старой версии (был пароль) — переносим клиентов в новую схему без password_hash.
  const custCols = await db.allAsync(`PRAGMA table_info(customers)`);
  if (custCols.some(c => c.name === 'password_hash')) {
    await db.runAsync(`ALTER TABLE customers RENAME TO customers_old_pw`);
    await db.runAsync(`CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      bonus_balance INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    await db.runAsync(`INSERT INTO customers (id, name, phone, email, bonus_balance, created_at)
      SELECT id, name, phone, email, bonus_balance, created_at FROM customers_old_pw`);
    await db.runAsync(`DROP TABLE customers_old_pw`);
  }
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

  // Дата настоящей регистрации (сам вошёл по коду) — отдельно от created_at, который
  // проставляется и когда запись клиента создаётся автоматически при начислении бонуса
  // за заказ (клиент сам ничего не регистрировал, это не «регистрация»).
  await addCol('customers', 'registered_at', 'TEXT');

  // ---- Личный кабинет: аватар, избранное, «мои отзывы» ----
  await addCol('customers', 'avatar', 'TEXT');       // путь к загруженному фото профиля
  await addCol('customers', 'company', 'TEXT');       // название компании клиента (заполняет сам в личном кабинете)
  await addCol('customers', 'city', 'TEXT');          // город клиента (заполняется в админке)
  await addCol('reviews', 'customer_id', 'INTEGER'); // кто оставил отзыв, если был вошедшим (для "Мои отзывы")
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

  const DEFAULT_QUIZ = {
    enabled: true,
    title: 'Подбор оборудования за 3 шага',
    subtitle: 'Ответьте на три вопроса — покажем 2–3 подходящие модели',
    steps: [
      { key: 'biz', label: 'Тип бизнеса', options: [
        { id: 'wash',  label: 'Автомойка',           category: 'avtomojka' },
        { id: 'sto',   label: 'СТО / автосервис',     category: 'sto' },
        { id: 'clean', label: 'Клининговая компания', category: 'klining' }
      ]},
      { key: 'load', label: 'Поток / объём работы', options: [
        { id: 's', label: 'Небольшой',            perfMax: 15 },
        { id: 'm', label: 'Средний',              perfMin: 10, perfMax: 45 },
        { id: 'l', label: 'Большой / интенсивный', perfMin: 40 }
      ]},
      { key: 'budget', label: 'Бюджет', options: [
        { id: 'b1', label: 'до 5 млн ₸',      priceMax: 5000000 },
        { id: 'b2', label: '5–20 млн ₸',      priceMin: 5000000, priceMax: 20000000 },
        { id: 'b3', label: 'от 20 млн ₸',     priceMin: 20000000 },
        { id: 'b0', label: 'Пока не определился' }
      ]}
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
