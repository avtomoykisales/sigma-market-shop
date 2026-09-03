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
    quiz:      JSON.stringify(DEFAULT_QUIZ)
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

  // Products — seed only if empty
  const count = await db.getAsync('SELECT COUNT(*) as cnt FROM products');
  if (count.cnt === 0) {
    const getCatId = async (slug) => {
      const row = await db.getAsync('SELECT id FROM categories WHERE slug=?', [slug]);
      return row.id;
    };

    const ins = async (slug, name, article, brand, desc, price, priceReq, icon, inStock, featured, specs) => {
      const catId = await getCatId(slug);
      await db.runAsync(
        `INSERT INTO products (category_id,name,article,brand,description,price,price_on_request,icon,in_stock,featured,specs) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [catId, name, article||'', brand||'', desc||'', price||0, priceReq?1:0, icon||null, inStock?1:0, featured?1:0, specs||'{}']
      );
    };

    const P = JSON.stringify, S1 = '{"Производительность":"до 30 авто/час","Экономия воды":"70%"}';
    // ===== АВТОМОЙКИ =====
    await ins('avtomoyki','Роботизированная автомойка HP-212','HP-212','ISTOBAL','Бесконтактная роботизированная автомойка для легковых и коммерческих автомобилей.',18500000,0,'hp-212.png',1,1,P({"Производительность":"до 30 авто/час","Экономия воды":"70%","Тип":"Роботизированная"}));
    await ins('avtomoyki','Роботизированная автомойка HP-261','HP-261','ISTOBAL','Для легковых и коммерческих автомобилей без физического контакта с кузовом.',21000000,0,'hp-261.png',1,1,P({"Производительность":"до 30 авто/час","Экономия воды":"70%"}));
    await ins('avtomoyki','Туннельная автомойка CC-650','CC-650','ChRiST','Туннельная автомойка конвейерного типа с 5 щётками. Производительность до 55 авто/час.',34560000,0,'cc-650.png',1,1,P({"Производительность":"до 55 авто/час","Экономия воды":"60%","Тип":"Туннельная"}));
    await ins('avtomoyki','Портальная автомойка CB-730','CB-730','ISTOBAL','Портальная автомойка для автобусов и грузовых автомобилей.',0,1,'cb-730.png',1,1,P({"Производительность":"до 15 авто/час","Тип":"Портальная"}));
    await ins('avtomoyki',"Портальная автомойка M'WASH OPTI 2L",'OPTI-2L','ISTOBAL','Двухщёточная портальная мойка для легковых автомобилей.',8900000,0,null,1,0,'{}');
    await ins('avtomoyki',"Портальная автомойка M'WASH OPTI 4L",'OPTI-4L','ISTOBAL','Четырёхщёточная портальная мойка с высокой производительностью.',12500000,0,null,1,0,'{}');
    await ins('avtomoyki','Туннельная мойка WashTec SoftCare Xtec','SOFT-XTEC','WashTec','Туннельная автомойка с системой мягкой мойки.',0,1,null,1,0,'{}');
    await ins('avtomoyki','Аппарат высокого давления PT-150','PT-150C','PORTOTECNICA','Аппарат высокого давления с холодной водой, 150 бар, электрический.',450000,0,null,1,0,P({"Давление":"150 бар","Вода":"Холодная"}));
    await ins('avtomoyki','Аппарат высокого давления PT-180 горячая вода','PT-180H','PORTOTECNICA','Аппарат высокого давления с подогревом воды, 180 бар.',890000,0,null,1,0,P({"Давление":"180 бар","Вода":"Горячая до 95°C"}));
    await ins('avtomoyki','Пеногенератор для автомойки FG-30','FG-30','IDROBASE','Пеногенератор на 30 л/мин для нанесения активной пены.',350000,0,null,1,0,P({"Расход":"30 л/мин"}));
    await ins('avtomoyki','Пистолет для мойки высокого давления IDR-200','IDR-200','IDROBASE','Профессиональный пистолет 200 бар.',45000,0,null,1,0,'{}');
    await ins('avtomoyki','Рукав высокого давления 10м','HOSE-10','IDROBASE','Армированный рукав 200 бар, 10 м.',32000,0,null,1,0,P({"Длина":"10 м","Давление":"200 бар"}));
    await ins('avtomoyki','Рукав высокого давления 15м','HOSE-15','IDROBASE','Армированный рукав 200 бар, 15 м.',45000,0,null,1,0,P({"Длина":"15 м"}));
    await ins('avtomoyki','Система рекуперации воды RWS-1000','RWS-1000','IDROBASE','Система рекуперации и очистки воды для автомоек, 1000 л.',1200000,0,null,1,0,'{}');
    await ins('avtomoyki','Насадка турбо TURBO-25','TURBO-25','IDROBASE','Вращающаяся турбонасадка 250 бар.',55000,0,null,1,0,P({"Давление":"250 бар"}));
    await ins('avtomoyki','Пеногенератор-пистолет FOAM-GUN','FOAM-GUN','IDROBASE','Пенный пистолет для нанесения активной пены, 1 л.',32000,0,null,1,0,'{}');
    await ins('avtomoyki','Дозатор шампуня DS-20','DS-20','IDROBASE','Автоматический дозатор шампуня для туннельных моек.',180000,0,null,1,0,'{}');
    await ins('avtomoyki','Система нанесения воска WX-300','WX-300','IDROBASE','Автоматическая система нанесения жидкого воска.',250000,0,null,1,0,'{}');
    await ins('avtomoyki','Щётка моечная полиэтиленовая 600мм','BRUSH-600','ChRiST','Щётка для роботизированных и портальных автомоек.',95000,0,null,1,0,P({"Диаметр":"600 мм"}));
    await ins('avtomoyki','Щётка моечная из пеноматериала 700мм','BRUSH-700F','ChRiST','Мягкая пенная щётка, диаметр 700 мм.',120000,0,null,1,0,P({"Диаметр":"700 мм","Материал":"Пена"}));
    await ins('avtomoyki','Химия — активная пена 20л','CHEM-FOAM','SIGMA','Концентрат активной пены для бесконтактной мойки, 20 л.',22000,0,null,1,0,P({"Объём":"20 л","Разбавление":"1:50"}));
    await ins('avtomoyki','Химия — воск жидкий 10л','CHEM-WAX','SIGMA','Жидкий воск для защиты лакокрасочного покрытия, 10 л.',18000,0,null,1,0,P({"Объём":"10 л"}));
    await ins('avtomoyki','Химия — шампунь 20л','CHEM-SHAM','SIGMA','Концентрат шампуня для щёточных моек, 20 л.',15000,0,null,1,0,P({"Объём":"20 л"}));
    await ins('avtomoyki','Ёмкость для реагентов 500л','PE-500','SIGMA','Полиэтиленовая ёмкость 500 л для хранения химии.',85000,0,null,1,0,P({"Объём":"500 л"}));
    await ins('avtomoyki','Ёмкость для реагентов 1000л','PE-1000','SIGMA','Полиэтиленовая ёмкость 1000 л.',145000,0,null,1,0,P({"Объём":"1000 л"}));
    await ins('avtomoyki','Фильтр воды магистральный FV-100','FV-100','IDROBASE','Магистральный фильтр 100 л/мин.',35000,0,null,1,0,'{}');
    await ins('avtomoyki','Насос высокого давления 200 бар 15л/мин','PUMP-200','PORTOTECNICA','Плунжерный насос для мойки ВД.',280000,0,null,1,0,P({"Давление":"200 бар","Расход":"15 л/мин"}));
    await ins('avtomoyki','Датчик наличия автомобиля SENS-IR','SENS-IR','ChRiST','Инфракрасный датчик для автоматических моечных комплексов.',45000,0,null,1,0,'{}');
    await ins('avtomoyki','Терминал оплаты для автомойки TERM-4G','TERM-4G','ChRiST','Терминал самообслуживания с поддержкой наличных и карт.',0,1,null,1,0,'{}');
    await ins('avtomoyki','Система LED-подсветки для автомойки','LED-KIT','ChRiST','Комплект LED-освещения для туннельных и портальных моечных комплексов.',380000,0,null,1,0,'{}');
    await ins('avtomoyki','Шланг подачи воды армированный 25мм 50м','WSHOSE-50','IDROBASE','Армированный шланг подачи воды, 25 мм, 50 м.',38000,0,null,1,0,'{}');
    await ins('avtomoyki','Пароочиститель PT-STEAM','PT-STEAM','PORTOTECNICA','Профессиональный пароочиститель для детейлинга.',650000,0,null,1,0,P({"Температура":"160°C","Давление":"4 бар"}));
    await ins('avtomoyki','Контроллер ПЛК для автомойки PLC-Touch','PLC-TOUCH','ChRiST','Сенсорный контроллер управления автомойкой.',0,1,null,1,0,'{}');
    await ins('avtomoyki','Конвейер для автомойки 20м','CONV-20','ChRiST','Цепной конвейер для туннельных моек, длина 20 м.',0,1,null,0,0,P({"Длина":"20 м"}));
    await ins('avtomoyki','Воздушный сушильный портал AP-6000','AP-6000','WashTec','Мощная система воздушной сушки для туннельных и портальных моек.',0,1,null,1,0,'{}');
    await ins('avtomoyki','Копьё для пены Lance FG-120','LANCE-FG','IDROBASE','Пенное копьё для нанесения шампуня.',28000,0,null,1,0,'{}');
    await ins('avtomoyki','Переходник M22 для форсунки','ADAPT-M22','IDROBASE','Переходник для форсунок мойки ВД.',2500,0,null,1,0,'{}');
    await ins('avtomoyki','Форсунки 15° 1,8мм (уп. 5шт)','NOZ-15-18','IDROBASE','Форсунки для мойки высокого давления 15°, 5 шт.',12000,0,null,1,0,'{}');
    await ins('avtomoyki','Форсунки 25° 2,0мм (уп. 5шт)','NOZ-25-20','IDROBASE','Форсунки для мойки высокого давления 25°, 5 шт.',12000,0,null,1,0,'{}');

    // ===== СТО И АВТОСЕРВИС =====
    await ins('sto','Автоподъёмник двухстоечный RAV-4.0T','RAV-4T','RAVAGLIOLLI','Двухстоечный электрогидравлический подъёмник, г/п 4 т.',1850000,0,null,1,1,P({"Г/п":"4 т","Тип":"Двухстоечный"}));
    await ins('sto','Автоподъёмник четырёхстоечный RAV-4S','RAV-4S','RAVAGLIOLLI','Четырёхстоечный подъёмник для схождения/развала, г/п 4 т.',2700000,0,null,1,1,P({"Г/п":"4 т","Тип":"Четырёхстоечный"}));
    await ins('sto','Ножничный подъёмник RAV-3.5N','RAV-3N','RAVAGLIOLLI','Ножничный подъёмник для низкопрофильных автомобилей, г/п 3,5 т.',2200000,0,null,1,0,P({"Г/п":"3,5 т"}));
    await ins('sto','Балансировочный станок HOFFMAN GEODYNA 980','GEO-980','HOFFMAN','Полностью автоматический балансировочный станок с лазерным измерением.',1450000,0,null,1,1,P({"Диаметр диска":"до 30 дюймов","Точность":"±1 г"}));
    await ins('sto','Шиномонтажный станок HOFFMAN MONTY 8132','MON-8132','HOFFMAN','Автоматический шиномонтажный станок для легковых и SUV.',1200000,0,null,1,1,P({"Диаметр диска":"10–26 дюймов"}));
    await ins('sto','Шиномонтажный станок HOFFMAN MONTY 8232','MON-8232','HOFFMAN','Шиномонтажный станок для грузовых автомобилей.',2100000,0,null,1,0,P({"Диаметр диска":"до 56 дюймов"}));
    await ins('sto','Компрессор поршневой REMEZA СБ4/С-100','REMEZA-100','REMEZA','Поршневой компрессор 100 л, 10 бар, 1,5 кВт.',320000,0,null,1,0,P({"Объём":"100 л","Давление":"10 бар","Мощность":"1,5 кВт"}));
    await ins('sto','Компрессор поршневой REMEZA СБ4/С-200','REMEZA-200','REMEZA','Поршневой компрессор 200 л, 10 бар, 3 кВт.',580000,0,null,1,0,P({"Объём":"200 л","Давление":"10 бар"}));
    await ins('sto','Компрессор винтовой Sobek.PRO S-7.5','SOBEK-75','Sobek.PRO','Винтовой компрессор 7,5 кВт, 10 бар, 0,9 м³/мин.',1250000,0,null,1,1,P({"Мощность":"7,5 кВт","Давление":"10 бар"}));
    await ins('sto','Компрессор винтовой Sobek.PRO S-15','SOBEK-15','Sobek.PRO','Винтовой компрессор 15 кВт, 10 бар, 1,8 м³/мин.',2100000,0,null,1,0,P({"Мощность":"15 кВт"}));
    await ins('sto','Сварочный инвертор HELVI GALAXY 200','HLV-200','HELVI','Сварочный инвертор MMA/MIG 200А.',185000,0,null,1,0,P({"Ток":"200А","Процесс":"MMA/MIG"}));
    await ins('sto','Пускозарядное устройство HELVI BOOST 1000','HLV-BST','HELVI','Профессиональный бустер пуска двигателя 1000А, 12/24В.',320000,0,null,1,0,P({"Ток пуска":"1000А"}));
    await ins('sto','Зарядное устройство HELVI GIGABAT 100','HLV-GIG','HELVI','Автоматическое зарядное устройство 100А, 12/24В.',280000,0,null,1,0,P({"Ток":"100А"}));
    await ins('sto','Гайковёрт пневматический Chicago CP-7748','CP-7748','Chicago Pneumatics','Пневматический ударный гайковёрт 1" 2700 Нм.',185000,0,null,1,0,P({"Присоединение":"1 дюйм","Момент":"2700 Нм"}));
    await ins('sto','Гайковёрт пневматический Chicago CP-7741','CP-7741','Chicago Pneumatics','Пневматический ударный гайковёрт 1/2" 1000 Нм.',85000,0,null,1,0,P({"Момент":"1000 Нм"}));
    await ins('sto','Набор ключей BETA 2100 72 предмета','BETA-2100','BETA','Профессиональный набор комбинированных ключей, 72 предмета.',285000,0,null,1,1,P({"Предметов":"72"}));
    await ins('sto','Тележка инструментальная BETA C24S','BETA-C24S','BETA','Передвижная инструментальная тележка, 7 ящиков.',580000,0,null,1,0,P({"Ящиков":"7"}));
    await ins('sto','Домкрат подкатной 3т Low Profile','JACK-3T','SIGMA','Низкопрофильный подкатной домкрат 3 т.',95000,0,null,1,0,P({"Г/п":"3 т"}));
    await ins('sto','Домкрат бутылочный 10т','JACK-10B','SIGMA','Гидравлический бутылочный домкрат 10 т.',45000,0,null,1,0,P({"Г/п":"10 т"}));
    await ins('sto','Стенд сход-развал 3D WHEEL-3D','WHEEL-3D','HOFFMAN','Профессиональный стенд 3D для регулировки углов установки колёс.',0,1,null,1,1,'{}');
    await ins('sto','Пресс гидравлический 20т напольный','PRESS-20T','SIGMA','Напольный гидравлический пресс 20 т.',185000,0,null,1,0,P({"Усилие":"20 т"}));
    await ins('sto','Маслозаменная установка SAMOA','SAMOA-OIL','SAMOA','Установка для замены масла под давлением с насосом.',850000,0,null,1,0,'{}');
    await ins('sto','Откачной насос SAMOA 60:1','SAMOA-60','SAMOA','Пневматический насос для перекачки масла 60:1.',185000,0,null,1,0,'{}');
    await ins('sto','Диагностический сканер OBD-II PRO','OBD-PRO','SIGMA','Профессиональный автосканер для чтения и сброса кодов ошибок.',185000,0,null,1,0,'{}');
    await ins('sto','Прибор для заправки кондиционеров AC-1234','AC-1234','SIGMA','Установка для обслуживания кондиционеров R134a.',0,1,null,1,0,'{}');
    await ins('sto','Тормозной стенд роликовый ROLS-4','ROLS-4','HOFFMAN','Роликовый стенд для проверки тормозной системы.',0,1,null,1,0,'{}');
    await ins('sto','Пневмогайковёрт для грузовых CP-6920','CP-6920','Chicago Pneumatics','Пневматический гайковёрт 3" для грузового транспорта, 5500 Нм.',450000,0,null,1,0,P({"Момент":"5500 Нм"}));
    await ins('sto','Ключ динамометрический 1/2" 20-200Нм','TORQ-200','BETA','Щелчковый динамометрический ключ, диапазон 20–200 Нм.',55000,0,null,1,0,'{}');
    await ins('sto','Азотный генератор для шин NIT-10','NIT-10','SIGMA','Генератор азота для накачки шин, 10 л/мин.',380000,0,null,1,0,P({"Производительность":"10 л/мин"}));
    await ins('sto','Подъёмник для мотоциклов 500кг','MOTO-LIFT','RAVAGLIOLLI','Гидравлический стол-подъёмник для мотоциклов.',380000,0,null,1,0,P({"Г/п":"500 кг"}));
    await ins('sto','Маслораздаточная колонка SAMOA MC-10','SAMOA-MC','SAMOA','Колонка для раздачи масла с электронным счётчиком.',0,1,null,1,0,'{}');
    await ins('sto','Комплект пневматики для СТО (блок FRL)','PNEU-BOX','Chicago Pneumatics','Распределительный блок пневматики с манометром и FRL.',85000,0,null,1,0,'{}');
    await ins('sto','Окрасочная камера 6×3×2,5м','PAINT-CAM','SIGMA','Профессиональная окрасочная камера с вентиляцией.',0,1,null,1,0,P({"Размер":"6×3×2,5 м"}));
    await ins('sto','Пустой шиномонтажный стол','TYRE-TABLE','SIGMA','Поворотный стол для шиномонтажного оборудования.',55000,0,null,1,0,'{}');
    await ins('sto','Стеллаж инструментальный металлический','RACK-TOOL','SIGMA','Металлический стеллаж для хранения инструментов.',55000,0,null,1,0,'{}');
    await ins('sto','Промывка форсунок ультразвуковая','INJ-CLEAN','SIGMA','Ультразвуковая ванна для промывки форсунок.',145000,0,null,1,0,'{}');
    await ins('sto','Устройство замены тормозной жидкости','BRK-FLUSH','SIGMA','Аппарат для замены тормозной жидкости под давлением.',85000,0,null,1,0,'{}');
    await ins('sto','Шлифмашина пневматическая Chicago CP-7225','CP-7225','Chicago Pneumatics','Угловая пневматическая шлифмашина 12000 об/мин.',48000,0,null,1,0,'{}');
    await ins('sto','Пневмодрель Chicago CP-9290','CP-9290','Chicago Pneumatics','Пневматическая дрель прямая 2600 об/мин.',55000,0,null,1,0,'{}');
    await ins('sto','Набор насадок BETA 900 60 предметов','BETA-900','BETA','Набор бит и насадок 1/4" и 1/2", 60 предметов.',145000,0,null,1,0,'{}');
    await ins('sto','Съёмник подшипников универсальный','BEAR-PULL','BETA','Универсальный гидравлический съёмник подшипников.',65000,0,null,1,0,'{}');
    await ins('sto','Дымогенератор для поиска утечек','SMOKE-GEN','SIGMA','Прибор для обнаружения утечек во впускной системе.',125000,0,null,1,0,'{}');

    // ===== КЛИНИНГ =====
    await ins('klining','Поломоечная машина GANSOW GT 50 B/45','GAN-50B45','GANSOW','Аккумуляторная поломоечная машина, ширина 45 см, бак 50 л.',2800000,0,null,1,1,P({"Ширина захвата":"45 см","Бак":"50 л","Тип":"Аккумуляторная"}));
    await ins('klining','Поломоечная машина GANSOW GT 85 B/55','GAN-85B55','GANSOW','Аккумуляторная поломоечная машина, ширина 55 см, бак 85 л.',3850000,0,null,1,1,P({"Ширина захвата":"55 см","Бак":"85 л"}));
    await ins('klining','Поломоечная машина GANSOW GT 50 E/45','GAN-50E45','GANSOW','Сетевая поломоечная машина, ширина 45 см, бак 50 л.',2200000,0,null,1,0,P({"Ширина захвата":"45 см","Тип":"Сетевая"}));
    await ins('klining','Поломоечная машина GANSOW GT 110 E/75','GAN-110E75','GANSOW','Большая сетевая поломоечная машина, ширина 75 см, бак 110 л.',5200000,0,null,1,0,P({"Ширина захвата":"75 см","Бак":"110 л"}));
    await ins('klining','Поломоечная машина-кабина GANSOW GT 185 BT','GAN-185BT','GANSOW','Крупная кабинная поломоечная машина для больших площадей.',0,1,null,1,0,P({"Тип":"Кабинная","Бак":"185 л"}));
    await ins('klining','Подметальная машина HAAGA 355','HAA-355','HAAGA','Аккумуляторная подметальная машина, ширина 55 см.',1850000,0,null,1,1,P({"Ширина захвата":"55 см","Тип":"Аккумуляторная"}));
    await ins('klining','Подметальная машина HAAGA 477','HAA-477','HAAGA','Аккумуляторная подметальная машина, ширина 77 см, 3 щётки.',2450000,0,null,1,0,P({"Ширина захвата":"77 см"}));
    await ins('klining','Подметальная машина HAAGA 697 i-Sweep','HAA-697','HAAGA','Самоходная подметальная машина с интеллектуальным управлением.',3800000,0,null,1,0,P({"Тип":"Самоходная"}));
    await ins('klining','Промышленный пылесос SOTECO PLANET 120','SOT-PL120','SOTECO','Промышленный пылесос 120 л, 3000 Вт, сухая уборка.',680000,0,null,1,0,P({"Объём":"120 л","Мощность":"3000 Вт"}));
    await ins('klining','Пылеводосос SOTECO OCEAN 200','SOT-OC200','SOTECO','Пылеводосос 200 л, нержавеющий бак.',1250000,0,null,1,1,P({"Объём":"200 л","Тип":"Сухая/влажная"}));
    await ins('klining','Экстрактор для химчистки SOTECO WASH 50','SOT-WA50','SOTECO','Моющий пылесос (экстрактор) 50 л.',980000,0,null,1,0,P({"Объём":"50 л","Тип":"Экстрактор"}));
    await ins('klining','Экстрактор для химчистки SOTECO WASH 100','SOT-WA100','SOTECO','Профессиональный экстрактор 100 л.',1450000,0,null,1,0,P({"Объём":"100 л","Тип":"Экстрактор"}));
    await ins('klining','Аппарат высокого давления PT-150 ECO','PT-150E','PORTOTECNICA','Компактный аппарат 150 бар для клинингового использования.',380000,0,null,1,0,P({"Давление":"150 бар"}));
    await ins('klining','Аппарат высокого давления PT-200 HOT','PT-200H','PORTOTECNICA','Аппарат с горячей водой 200 бар, нагрев до 95°C.',950000,0,null,1,0,P({"Давление":"200 бар","Вода":"Горячая"}));
    await ins('klining','Поломоечная машина однодисковая OD-430','OD-430','GANSOW','Однодисковая машина для полировки и мойки полов.',650000,0,null,1,0,P({"Диаметр":"430 мм"}));
    await ins('klining','Щётка для поломоечной машины 50см','BRUSH-50','GANSOW','Цилиндрическая щётка, диаметр 50 см.',38000,0,null,1,0,P({"Диаметр":"50 см"}));
    await ins('klining','Сквидж (резиновое полотно) 45см','SQUEEGE-45','GANSOW','Резиновое полотно для сбора воды, 45 см.',25000,0,null,1,0,'{}');
    await ins('klining','Профессиональная швабра телескопическая','MOP-TEL','SIGMA','Профессиональная мопная система с телескопической ручкой.',15000,0,null,1,0,'{}');
    await ins('klining','Мопная насадка микрофибра 40см','MOP-MF40','SIGMA','Насадка для мопа из микрофибры, 40 см.',4500,0,null,1,0,'{}');
    await ins('klining','Уборочная тележка 2×14л','CART-2X14','SIGMA','Двухвёдерная тележка с прессом для отжима мопа.',55000,0,null,1,0,'{}');
    await ins('klining','Дозатор жидкого мыла настенный 1л','SOAP-1L','SIGMA','Настенный дозатор жидкого мыла из ABS-пластика.',8500,0,null,1,0,'{}');
    await ins('klining','Сушилка для рук 1200Вт JET','DRYER-JET','SIGMA','Высокоскоростная сушилка для рук с датчиком.',85000,0,null,1,0,P({"Мощность":"1200 Вт"}));
    await ins('klining','Мусорный бак с педалью 60л нержавейка','BIN-60L','SIGMA','Мусорный бак 60 л из нержавеющей стали с педалью.',28000,0,null,1,0,'{}');
    await ins('klining','Поломоечная машина роботизированная GANSOW R-480','GAN-R480','GANSOW','Автономная роботизированная поломоечная машина.',0,1,null,1,0,P({"Тип":"Роботизированная","Ширина":"48 см"}));
    await ins('klining','Комплект для мойки окон 3м','WIN-CLEAN','SIGMA','Профессиональный комплект для мойки окон с телескопической штангой.',45000,0,null,1,0,'{}');
    await ins('klining','Средство для мытья полов 5л','FLOOR-CL','SIGMA','Профессиональное средство для уборки полов, 5 л.',8500,0,null,1,0,P({"Объём":"5 л"}));
    await ins('klining','Средство для мытья стёкол 5л','GLASS-CL','SIGMA','Концентрат для мойки стёкол и зеркал, 5 л.',7500,0,null,1,0,'{}');
    await ins('klining','Дезинфицирующее средство 5л','DESINFECT','SIGMA','Профессиональный дезинфектант для поверхностей, 5 л.',9500,0,null,1,0,'{}');
    await ins('klining','Щётка дисковая для поломоечной машины 430мм','DISC-430','GANSOW','Дисковая щётка, диаметр 430 мм.',22000,0,null,1,0,'{}');
    await ins('klining','Пад полировочный белый 430мм','PAD-WH430','SIGMA','Белый полировочный пад, диаметр 430 мм.',12000,0,null,1,0,'{}');
    await ins('klining','Пад красный (чистка) 430мм','PAD-RD430','SIGMA','Красный пад для интенсивной чистки, диаметр 430 мм.',12000,0,null,1,0,'{}');
    await ins('klining','Фильтр для пылесоса SOTECO HEPA','SOT-HEPA','SOTECO','HEPA фильтр для промышленных пылесосов SOTECO.',18000,0,null,1,0,'{}');
    await ins('klining','Мешок для пылесоса SOTECO (уп. 10шт)','SOT-BAG','SOTECO','Одноразовые мешки-пылесборники, 10 шт.',8500,0,null,1,0,'{}');
    await ins('klining','Сигнальный конус уборки 50см','CONE-50','SIGMA','Пластиковый конус «Осторожно, мокрый пол!».',5500,0,null,1,0,'{}');
    await ins('klining','Отжимная тележка 25л с прессом','WRINGER-25','SIGMA','Уборочная тележка с ведром 25 л и отжимом мопа.',38000,0,null,1,0,'{}');
    await ins('klining','Микрофибровая ткань 40×40 (уп. 10 шт)','MICROF-10','SIGMA','Профессиональные микрофибровые тряпки, 10 шт.',9800,0,null,1,0,'{}');
    await ins('klining','Аппарат для мойки фасадов PT-300 HOT','PT-300H','PORTOTECNICA','Горячая вода 300 бар для мойки фасадов.',0,1,null,1,0,P({"Давление":"300 бар"}));
    await ins('klining','Промышленный пылесос SOTECO VENTO','SOT-VENTO','SOTECO','Мощный промышленный пылесос для строительных работ.',850000,0,null,1,0,'{}');
    await ins('klining','Совок и щётка для пола (напольный набор)','DUSTPAN-SET','SIGMA','Набор: совок и щётка для уборки на длинных ручках.',9500,0,null,1,0,'{}');
    await ins('klining','Швабра для уборки воды 60см','SQUEEGEE-60','SIGMA','Резиновая швабра 60 см.',12000,0,null,1,0,'{}');
    await ins('klining','Нейтрализатор запаха 5л','ODOR-NEU','SIGMA','Профессиональный нейтрализатор запахов, 5 л.',9000,0,null,1,0,'{}');

    // ===== СИСТЕМЫ ОЧИСТКИ И ВОДОПОДГОТОВКИ =====
    await ins('voda','Система очистки воды RO-1000','RO-1000','IDROBASE','Система обратного осмоса 1000 л/сутки.',850000,0,null,1,1,P({"Производительность":"1000 л/сут","Тип":"Обратный осмос"}));
    await ins('voda','Система очистки воды RO-2000','RO-2000','IDROBASE','Система обратного осмоса 2000 л/сутки.',1450000,0,null,1,0,P({"Производительность":"2000 л/сут"}));
    await ins('voda','Жироуловитель GS-1000','GS-1000','IDROBASE','Жироуловитель-нефтеуловитель 1000 л.',450000,0,null,1,0,P({"Объём":"1000 л"}));
    await ins('voda','Жироуловитель GS-3000','GS-3000','IDROBASE','Жироуловитель-нефтеуловитель 3000 л.',950000,0,null,1,0,P({"Объём":"3000 л"}));
    await ins('voda','Система рекуперации воды RWS-2000','RWS-2000','IDROBASE','Полная система рециркуляции воды, 2000 л/ч.',2200000,0,null,1,1,P({"Производительность":"2000 л/ч"}));
    await ins('voda','Умягчитель воды UM-300','UM-300','SIGMA','Ионообменный умягчитель воды 300 л/ч.',380000,0,null,1,0,P({"Производительность":"300 л/ч"}));
    await ins('voda','Умягчитель воды UM-1000','UM-1000','SIGMA','Ионообменный умягчитель воды 1000 л/ч.',750000,0,null,1,0,P({"Производительность":"1000 л/ч"}));
    await ins('voda','Фильтр механической очистки 50мкм','FM-50','SIGMA','Картриджный фильтр грубой очистки 50 мкм.',28000,0,null,1,0,'{}');
    await ins('voda','Фильтр механической очистки 5мкм','FM-5','SIGMA','Картриджный фильтр тонкой очистки 5 мкм.',32000,0,null,1,0,'{}');
    await ins('voda','УФ-обеззараживатель воды UV-10','UV-10','SIGMA','Ультрафиолетовый обеззараживатель воды 10 м³/ч.',180000,0,null,1,0,P({"Производительность":"10 м³/ч"}));
    await ins('voda','Угольный фильтр для воды UC-500','UC-500','SIGMA','Фильтр активированного угля.',95000,0,null,1,0,'{}');
    await ins('voda','Насос водоснабжения центробежный 1,1кВт','PUMP-11','SIGMA','Центробежный насос 1,1 кВт, 3 м³/ч.',85000,0,null,1,0,P({"Мощность":"1,1 кВт","Производительность":"3 м³/ч"}));
    await ins('voda','Насос водоснабжения центробежный 2,2кВт','PUMP-22','SIGMA','Центробежный насос 2,2 кВт, 6 м³/ч.',145000,0,null,1,0,P({"Мощность":"2,2 кВт"}));
    await ins('voda','Гидроаккумулятор 100л','HYDRO-100','SIGMA','Гидроаккумулятор 100 л.',75000,0,null,1,0,P({"Объём":"100 л"}));
    await ins('voda','Гидроаккумулятор 500л','HYDRO-500','SIGMA','Гидроаккумулятор 500 л промышленный.',280000,0,null,1,0,P({"Объём":"500 л"}));
    await ins('voda','Система мониторинга качества воды WQM','WQM-1','SIGMA','Онлайн-система мониторинга pH, TDS, температуры.',0,1,null,1,0,'{}');
    await ins('voda','Дозатор реагентов химический DR-5','DR-5','SIGMA','Перистальтический дозатор реагентов 5 л/ч.',145000,0,null,1,0,'{}');
    await ins('voda','Картридж для обратного осмоса RO-MEM','RO-MEM','SIGMA','Мембранный картридж для систем обратного осмоса.',45000,0,null,1,0,'{}');
    await ins('voda','Соль для умягчителя воды 25кг','SALT-25','SIGMA','Таблетированная соль для ионообменных умягчителей.',5500,0,null,1,0,P({"Вес":"25 кг","Форма":"Таблетки"}));
    await ins('voda','Флотационная установка FLOT-500','FLOT-500','IDROBASE','Флотационная установка очистки стоков 500 л/ч.',0,1,null,1,0,'{}');
    await ins('voda','Сепаратор нефтепродуктов SN-100','SN-100','IDROBASE','Сепаратор для отделения нефтепродуктов из стоков.',380000,0,null,1,0,'{}');
    await ins('voda','Манометр для систем водоснабжения 0-10 бар','MAN-10','SIGMA','Манометр для контроля давления.',4500,0,null,1,0,'{}');
    await ins('voda','Счётчик воды DN25','WM-25','SIGMA','Крыльчатый счётчик воды, DN25.',12000,0,null,1,0,'{}');
    await ins('voda','Система нейтрализации стоков NS-1000','NS-1000','IDROBASE','Установка нейтрализации pH сточных вод.',0,1,null,1,0,'{}');
    await ins('voda','Фильтр-картридж полипропиленовый 5мкм','CART-5','SIGMA','Полипропиленовый картридж, 10 дюймов.',3500,0,null,1,0,'{}');
    await ins('voda','Обеззараживание озоном OZO-100','OZO-100','SIGMA','Озонатор воды 100 мг/ч.',280000,0,null,1,0,'{}');
    await ins('voda','Трубопровод ПНД 25мм (100м)','PIPE-25','SIGMA','Труба ПНД 25 мм, бухта 100 м.',22000,0,null,1,0,'{}');
    await ins('voda','Шаровый кран нержавейка DN32','VALVE-32','SIGMA','Нержавеющий шаровый кран DN32.',18000,0,null,1,0,'{}');
    await ins('voda','Пескоуловитель DN50','SAND-50','SIGMA','Механический пескоуловитель DN50.',18000,0,null,1,0,'{}');
    await ins('voda','Клапан электромагнитный 24В DN15','SOLENOID-15','SIGMA','Электромагнитный клапан 24В DC, DN15.',22000,0,null,1,0,'{}');

    // ===== АКСЕССУАРЫ И ЗАПЧАСТИ =====
    await ins('aksessuary','Масло гидравлическое HLP-46 20л','HYD-46','SIGMA','Гидравлическое масло HLP 46, 20 л.',28000,0,null,1,0,P({"Объём":"20 л","Класс":"HLP 46"}));
    await ins('aksessuary','Масло компрессорное 10л','COMP-OIL','SIGMA','Компрессорное масло для поршневых и винтовых компрессоров, 10 л.',18500,0,null,1,0,'{}');
    await ins('aksessuary','Смазка литиевая 400г','GREASE-400','SIGMA','Многоцелевая литиевая смазка, 400 г.',5500,0,null,1,0,'{}');
    await ins('aksessuary','Манометр цифровой для шин 0-10 бар','TIRE-MAN','SIGMA','Цифровой манометр для проверки давления в шинах.',12000,0,null,1,0,'{}');
    await ins('aksessuary','Быстросъёмные штуцеры 1/4" (уп. 10шт)','QUICK-14','Chicago Pneumatics','Быстросъёмные штуцеры для пневмосистем, 10 шт.',12000,0,null,1,0,'{}');
    await ins('aksessuary','Шланг пневматический полиуретановый 10м','AIR-HOSE','SIGMA','Шланг для пневмоинструмента, 8×12 мм, 10 м.',15000,0,null,1,0,P({"Длина":"10 м"}));
    await ins('aksessuary','Ремень клиновой A-63 для компрессора','BELT-A63','SIGMA','Клиновой ремень A-63 для поршневых компрессоров.',2800,0,null,1,0,'{}');
    await ins('aksessuary','Воздушный фильтр для компрессора (унив.)','AIR-FILT','SIGMA','Сменный воздушный фильтр для поршневых компрессоров.',4500,0,null,1,0,'{}');
    await ins('aksessuary','Сальник для насоса ВД 15мм (уп. 5шт)','SEAL-15','PORTOTECNICA','Уплотнительный сальник d15 мм, 5 шт.',8500,0,null,1,0,'{}');
    await ins('aksessuary','Клапан перепускной 200 бар','REL-200','PORTOTECNICA','Предохранительный перепускной клапан, 200 бар.',15000,0,null,1,0,'{}');
    await ins('aksessuary','Форсунки 15° 1,8мм (уп. 5шт)','NOZ-15-18A','IDROBASE','Форсунки для мойки ВД 15°, 5 шт.',12000,0,null,1,0,'{}');
    await ins('aksessuary','Форсунки 25° 2,0мм (уп. 5шт)','NOZ-25-20A','IDROBASE','Форсунки для мойки ВД 25°, 5 шт.',12000,0,null,1,0,'{}');
    await ins('aksessuary','Клапан электромагнитный 220В DN25','SOLENOID-25','SIGMA','Электромагнитный клапан 220В, DN25.',32000,0,null,1,0,'{}');
    await ins('aksessuary','Манометр высокого давления 0-250 бар','MANO-250','SIGMA','Глицериновый манометр 0–250 бар.',8500,0,null,1,0,'{}');
    await ins('aksessuary','Аккумулятор 12В 75Ач AGM','BATT-75','SIGMA','AGM аккумулятор 12В 75Ач для подъёмников.',55000,0,null,1,0,'{}');
    await ins('aksessuary','Зарядное для поломоечной машины GANSOW 24В','CHAR-24V','GANSOW','Зарядное устройство 24В для аккумуляторных машин GANSOW.',85000,0,null,1,0,'{}');
    await ins('aksessuary','Контактная смазка WD-40 400мл','WD40-400','SIGMA','Многофункциональная смазка WD-40 в аэрозоле.',3500,0,null,1,0,'{}');
    await ins('aksessuary','Герметик прокладочный анаэробный 50мл','SEALER-50','SIGMA','Анаэробный герметик для резьбовых соединений.',4800,0,null,1,0,'{}');
    await ins('aksessuary','Рукав для насосов SAMOA 1/2" 5м','SAMOA-HOSE','SAMOA','Маслостойкий рукав 1/2", 5 м.',18000,0,null,1,0,'{}');
    await ins('aksessuary','Счётчик масла SAMOA с пистолетом','SAMOA-COUNT','SAMOA','Счётчик расхода масла с пистолетом-раздатчиком.',85000,0,null,1,0,'{}');
    await ins('aksessuary','Лампа LED переносная для СТО','LED-LAMP','SIGMA','Переносная LED-лампа 12 Вт с магнитом.',12000,0,null,1,0,P({"Мощность":"12 Вт"}));
    await ins('aksessuary','Очиститель тормозов аэрозоль 500мл','BRAKE-CL','SIGMA','Аэрозоль для очистки тормозных дисков, 500 мл.',3800,0,null,1,0,'{}');
    await ins('aksessuary','Балансировочные грузики набор 5г–60г','WEIGHTS-SET','SIGMA','Набор клеевых и кованых балансировочных грузиков.',8500,0,null,1,0,'{}');
    await ins('aksessuary','Монтировка для шин 450мм','LEVER-450','HOFFMAN','Профессиональная монтировка для шиномонтажного оборудования.',8000,0,null,1,0,'{}');
    await ins('aksessuary','Защитная накладка для диска (уп. 5шт)','RIM-PROT','HOFFMAN','Пластиковые накладки для защиты дисков, 5 шт.',4500,0,null,1,0,'{}');
    await ins('aksessuary','Вентиль TR-413 (уп. 50шт)','VALVE-TR','SIGMA','Резиновый вентиль TR-413 для дисков, 50 шт.',9500,0,null,1,0,'{}');
    await ins('aksessuary','Угольные щётки для электродвигателя (уп.4шт)','CARBON-4','SIGMA','Угольные щётки для электродвигателей, 4 шт.',4500,0,null,1,0,'{}');
    await ins('aksessuary','Запасное колесо для тележки 125мм','WHEEL-125','SIGMA','Колесо с тормозом для уборочных тележек.',4500,0,null,1,0,'{}');
    await ins('aksessuary','Преобразователь ржавчины 500мл','RUST-CON','SIGMA','Преобразователь ржавчины на кислотной основе.',3200,0,null,1,0,'{}');
    await ins('aksessuary','Вулканизационный клей 50мл','VULC-50','SIGMA','Холодная вулканизация, клей для ремонта шин.',3500,0,null,1,0,'{}');
    await ins('aksessuary','Шплинт для ремонта шин 3мм (уп. 100шт)','TIRE-PIN','SIGMA','Шплинты для ремонта проколов, 100 шт.',5500,0,null,1,0,'{}');
    await ins('aksessuary','Уплотнительная лента ФУМ 19мм (10м)','FUM-10','SIGMA','Фторопластовая уплотнительная лента.',1200,0,null,1,0,'{}');
    await ins('aksessuary','Адаптер для грузовых шин 22.5"','ADAPT-225','HOFFMAN','Адаптер для шиномонтажного станка грузовых шин.',25000,0,null,1,0,'{}');
    await ins('aksessuary','Угловой штуцер 1/4"М х 1/4"Г','ELB-14','IDROBASE','Угловой штуцер для соединения шлангов ВД.',3500,0,null,1,0,'{}');
    await ins('aksessuary','Запасная щётка для подметальной машины','HAAGA-BRUSH','HAAGA','Сменная щётка для подметальных машин HAAGA.',45000,0,null,1,0,'{}');
    await ins('aksessuary','Набор сёдел клапанов для насоса ВД','VALVE-KIT','PORTOTECNICA','Набор клапанных сёдел для ремонта насосов ВД.',25000,0,null,1,0,'{}');

    // ===== ПРОМЫШЛЕННОЕ ОБОРУДОВАНИЕ =====
    await ins('promyshlennoe','Компрессор винтовой Sobek.PRO S-22','SOBEK-22','Sobek.PRO','Промышленный винтовой компрессор 22 кВт, 10 бар.',3200000,0,null,1,1,P({"Мощность":"22 кВт","Давление":"10 бар","Производительность":"2,8 м³/мин"}));
    await ins('promyshlennoe','Компрессор винтовой Sobek.PRO S-37','SOBEK-37','Sobek.PRO','Промышленный винтовой компрессор 37 кВт.',5500000,0,null,1,0,P({"Мощность":"37 кВт"}));
    await ins('promyshlennoe','Ресивер для компрессора 500л','RECV-500','SIGMA','Вертикальный ресивер 500 л, 16 бар.',280000,0,null,1,0,P({"Объём":"500 л","Давление":"16 бар"}));
    await ins('promyshlennoe','Ресивер для компрессора 1000л','RECV-1000','SIGMA','Вертикальный ресивер 1000 л, 16 бар.',450000,0,null,1,0,P({"Объём":"1000 л"}));
    await ins('promyshlennoe','Осушитель воздуха холодильный 0,8 м³/мин','DRYER-08','SIGMA','Рефрижераторный осушитель сжатого воздуха.',350000,0,null,1,0,P({"Производительность":"0,8 м³/мин"}));
    await ins('promyshlennoe','Осушитель воздуха холодильный 2 м³/мин','DRYER-2','SIGMA','Рефрижераторный осушитель воздуха 2 м³/мин.',650000,0,null,1,0,'{}');
    await ins('promyshlennoe','Аппарат плазменной резки HELVI PLASMA 50','HLV-PL50','HELVI','Аппарат плазменной резки, ток 50А, рез до 20 мм.',850000,0,null,1,0,P({"Ток":"50А","Рез до":"20 мм"}));
    await ins('promyshlennoe','Сварочный полуавтомат HELVI MIG-250','HLV-MIG250','HELVI','Сварочный полуавтомат MIG/MAG 250А.',650000,0,null,1,0,P({"Ток":"250А","Процесс":"MIG/MAG"}));
    await ins('promyshlennoe','Аргонодуговая сварка HELVI TIG-200','HLV-TIG200','HELVI','Аппарат аргонодуговой сварки TIG 200А.',780000,0,null,1,0,P({"Ток":"200А","Процесс":"TIG"}));
    await ins('promyshlennoe','Кран-балка электрическая 1т 6м','CRANE-1T','SIGMA','Мостовой электрический кран 1 т, пролёт 6 м.',0,1,null,1,0,'{}');
    await ins('promyshlennoe','Таль электрическая цепная 2т','HOIST-2T','SIGMA','Электрическая цепная таль 2 т с пультом.',580000,0,null,1,0,P({"Г/п":"2 т"}));
    await ins('promyshlennoe','Таль ручная рычажная 1,5т','HOIST-15M','SIGMA','Ручная рычажная таль 1,5 т.',85000,0,null,1,0,'{}');
    await ins('promyshlennoe','Погрузчик ручной гидравлический 2,5т','JACK-PAL','SIGMA','Ручная гидравлическая тележка-погрузчик 2,5 т.',125000,0,null,1,0,P({"Г/п":"2,5 т"}));
    await ins('promyshlennoe','Стеллаж металлический 2000×1000×500мм','SHELF-2T','SIGMA','Металлический стеллаж 5-полочный.',38000,0,null,1,0,'{}');
    await ins('promyshlennoe','Верстак металлический с тисками 1200мм','BENCH-120','SIGMA','Сварной верстак с тисками, 1200×600 мм.',95000,0,null,1,0,'{}');
    await ins('promyshlennoe','Вентилятор осевой промышленный 560мм','FAN-560','SIGMA','Осевой вентилятор 560 мм, 4000 м³/ч.',85000,0,null,1,0,'{}');
    await ins('promyshlennoe','Воздушная завеса тепловая 2кВт 90см','CURTAIN-2K','SIGMA','Тепловая завеса для ворот шириной 90 см.',85000,0,null,1,0,'{}');
    await ins('promyshlennoe','Воздушная завеса тепловая 6кВт 150см','CURTAIN-6K','SIGMA','Тепловая воздушная завеса для ворот шириной 150 см.',145000,0,null,1,0,'{}');
    await ins('promyshlennoe','Тепловая пушка 15кВт промышленная','HEAT-15K','SIGMA','Электрическая тепловая пушка 15 кВт.',125000,0,null,1,0,P({"Мощность":"15 кВт"}));
    await ins('promyshlennoe','Дизельная тепловая пушка 35кВт','HEAT-D35','SIGMA','Дизельная тепловая пушка 35 кВт.',380000,0,null,1,0,P({"Мощность":"35 кВт","Тип":"Дизельная"}));
    await ins('promyshlennoe','Сверлильный станок СС-16','SS-16','SIGMA','Настольный сверлильный станок, патрон 16 мм.',85000,0,null,1,0,'{}');
    await ins('promyshlennoe','Ленточная пила для металла ЛП-250','LP-250','SIGMA','Ленточная пила для металла, диаметр 250 мм.',285000,0,null,1,0,'{}');
    await ins('promyshlennoe','Зачистная машина угловая 230мм 2400Вт','GRIND-230','Chicago Pneumatics','Мощная угловая шлифмашина 230 мм, 2400 Вт.',85000,0,null,1,0,'{}');
    await ins('promyshlennoe','Бетономешалка 140л','MIX-140','SIGMA','Электрическая бетономешалка 140 л, 0,55 кВт.',145000,0,null,1,0,P({"Объём":"140 л"}));
    await ins('promyshlennoe','Мойка высокого давления PT-250 PRO','PT-250PRO','PORTOTECNICA','Промышленный аппарат 250 бар, 20 л/мин, нагрев до 95°C.',1850000,0,null,1,0,P({"Давление":"250 бар","Расход":"20 л/мин"}));
    await ins('promyshlennoe','Ёмкость топливная 1000л IBC','IBC-1000','SIGMA','Кубовый контейнер IBC 1000 л из нержавеющей стали.',250000,0,null,1,0,'{}');
    await ins('promyshlennoe','Насосная станция дренажная 2,2кВт','DRAIN-22','SIGMA','Дренажная насосная станция 2,2 кВт.',320000,0,null,1,0,P({"Мощность":"2,2 кВт"}));
    await ins('promyshlennoe','Промышленный холодильный шкаф для хранения','TOOL-FRIDGE','SIGMA','Холодильный шкаф для хранения инструментов и материалов.',0,1,null,1,0,'{}');
    await ins('promyshlennoe','Система молниезащиты для здания','LIGHTNING','SIGMA','Комплект молниезащиты для промышленного здания.',0,1,null,1,0,'{}');
    await ins('promyshlennoe','Вибратор глубинный для бетона','VIBR-BET','SIGMA','Электрический глубинный вибратор для уплотнения бетона.',125000,0,null,1,0,'{}');

    console.log('✅ 250 товаров добавлены в базу данных');
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
});

module.exports = db;
