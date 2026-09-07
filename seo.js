/* ============================================================
   SIGMA MARKET — серверная SEO-обвязка
   Вставляет в <head> корректные <title>, description, canonical,
   Open Graph / Twitter и JSON-LD (Organization, WebSite, Product,
   BreadcrumbList) в зависимости от URL и query-параметров.
   Плюс генерация robots.txt и sitemap.xml.
   ============================================================ */
const db = require('./database');

// Пред-запусковый режим: весь сайт закрыт от индексации (robots.txt + <meta robots>
// + заголовок X-Robots-Tag в server.js). Включается SITE_NOINDEX=1. Снять в день запуска.
const NOINDEX = /^(1|true|yes)$/i.test(process.env.SITE_NOINDEX || '');

const SITE_NAME = 'SIGMA MARKET';
const DEFAULT_TITLE = 'SIGMA MARKET — профессиональное оборудование для автомоек, СТО и клининга';
const DEFAULT_DESC =
  'SIGMA MARKET — профессиональное оборудование для автомоек, СТО и автосервиса, клининга. ' +
  'Поставка, монтаж и сервис по всему Казахстану с 2012 года.';
const ORG = {
  phone: '+7 (707) 420-20-03',
  phoneRaw: '+77074202003',
  email: 'avtomoyki.sales@gmail.com',
  locality: 'Алматы',
  street: 'пр-т Рыскулова 103/18Б, оф. 202',
  country: 'KZ',
};

function baseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Обрезать до n символов по границе слова, снять html-теги/переводы строк
function clip(s, n = 160) {
  s = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/[\s.,;:–—-]+\S*$/, '') + '…';
}

const jsonLd = (obj) =>
  `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

// ---- ЧПУ ----
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function slugName(s) {
  return String(s || '').toLowerCase()
    .replace(/[а-яё]/g, (ch) => (TRANSLIT[ch] != null ? TRANSLIT[ch] : ch))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70).replace(/-+$/, '');
}
function catalogPath(cat, sub) {
  if (!cat || cat === 'all') return '/catalog';
  return '/catalog/' + cat + (sub ? '/' + sub : '');
}
function productPath(p) {
  return '/product/' + p.id + (p && p.name ? '-' + slugName(p.name) : '');
}
// Старый ?category=/?product= → адрес нового формата (для 301)
async function legacyRedirect(req) {
  const q = req.query || {};
  if (q.product) {
    const p = await db.getAsync('SELECT id, name FROM products WHERE id = ?', [q.product]);
    return p ? productPath(p) : null;
  }
  if (q.category) {
    const subs = String(q.subcategory || '').split(',').filter(Boolean);
    if (subs.length > 1) return '/catalog/' + q.category + '?subcategory=' + subs.join(',');
    return catalogPath(q.category, subs[0] || '');
  }
  return null;
}

function orgLd(base) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: base + '/',
    logo: base + '/assets/icons/logo.png',
    foundingDate: '2012',
    email: ORG.email,
    telephone: ORG.phoneRaw,
    sameAs: ['https://www.instagram.com/sigmamarket.kz'],
    address: {
      '@type': 'PostalAddress',
      addressCountry: ORG.country,
      addressLocality: ORG.locality,
      streetAddress: ORG.street,
    },
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: ORG.phoneRaw,
      contactType: 'sales',
      areaServed: 'KZ',
      availableLanguage: ['ru', 'kk'],
    },
  };
}

function websiteLd(base) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: base + '/',
    inLanguage: 'ru',
    potentialAction: {
      '@type': 'SearchAction',
      target: base + '/?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  };
}

function breadcrumbLd(base, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: base + path,
    })),
  };
}

const STATIC_PAGES = {
  '/about.html': {
    crumb: 'О компании',
    title: 'О компании SIGMA MARKET — поставки оборудования для автобизнеса с 2012 года',
    desc: 'SIGMA MARKET — поставщик профессионального оборудования для автомоек, СТО и клининга в Казахстане. ' +
      'С 2012 года: подбор, поставка, монтаж и сервисное обслуживание, более 500 реализованных проектов.',
  },
  '/delivery.html': {
    crumb: 'Доставка и оплата',
    title: 'Доставка и оплата оборудования — SIGMA MARKET',
    desc: 'Условия доставки и оплаты оборудования SIGMA MARKET по Казахстану: способы оплаты, сроки, ' +
      'самовывоз в Алматы, транспортные компании, гарантия и документы.',
  },
  '/contacts.html': {
    crumb: 'Контакты',
    title: 'Контакты SIGMA MARKET — Алматы, отдел продаж',
    desc: 'Свяжитесь с SIGMA MARKET: ' + ORG.phone + ', ' + ORG.email + '. ' +
      'Офис в Алматы, ' + ORG.street + '. Часы работы и форма обратной связи.',
  },
  '/reviews.html': {
    crumb: 'Отзывы',
    title: 'Отзывы клиентов SIGMA MARKET',
    desc: 'Отзывы клиентов о работе с SIGMA MARKET: поставка и монтаж оборудования для автомоек, ' +
      'СТО и клининга, качество сервиса и поддержки.',
  },
};

const CAT_COPY = {
  avtomojka: {
    title: 'Оборудование для автомойки — купить в Казахстане | SIGMA MARKET',
    desc: 'Оборудование для автомоек: аппараты высокого давления, пеногенераторы, системы очистки и ' +
      'оборотного водоснабжения, пылесосы, сушка. Поставка и монтаж по Казахстану.',
  },
  sto: {
    title: 'Оборудование для СТО и автосервиса — купить в Казахстане | SIGMA MARKET',
    desc: 'Оборудование для СТО и автосервиса: подъёмники, шиномонтаж, компрессоры, пневмоинструмент, ' +
      'оборудование для смазки и замены жидкостей. Поставка и сервис по Казахстану.',
  },
  klining: {
    title: 'Оборудование для клининга — купить в Казахстане | SIGMA MARKET',
    desc: 'Профессиональное клининговое оборудование: поломоечные и подметальные машины, ' +
      'профессиональные пылесосы, аппараты высокого давления. Поставка и обслуживание по Казахстану.',
  },
};

async function productSeo(base, id, seo) {
  const p = await db.getAsync(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
            sc.name AS subcategory_name, sc.slug AS subcategory_slug, sc.parent_id AS subcategory_parent_id
     FROM products p JOIN categories c ON p.category_id = c.id
     LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
     WHERE p.id = ?`, [id]);

  if (!p) {
    seo.title = 'Товар не найден — ' + SITE_NAME;
    seo.description = 'Запрошенный товар не найден. Посмотрите каталог оборудования SIGMA MARKET.';
    seo.robots = 'noindex, follow';
    seo.canonical = base + '/';
    return seo;
  }

  const brand = p.brand ? p.brand + ' ' : '';
  seo.title = p.seo_title
    ? clip(p.seo_title, 70)
    : clip(p.name + ' — ' + brand + '| ' + SITE_NAME, 65);
  seo.h1 = p.name;
  seo.description = clip(p.seo_description || p.description || p.subtitle ||
    (p.name + '. Профессиональное оборудование от ' + SITE_NAME + '. Поставка по Казахстану.'), 175);
  seo.canonical = base + productPath(p);

  let gallery = [];
  try { gallery = JSON.parse(p.images || '[]'); } catch {}
  gallery = [...new Set([p.icon, ...gallery].filter(Boolean))].map((f) => base + '/icons/' + f);
  if (gallery.length) seo.image = gallery[0];

  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: seo.description,
    sku: p.article || String(p.id),
    category: p.subcategory_name || p.category_name,
  };
  if (gallery.length) product.image = gallery;
  if (p.brand) product.brand = { '@type': 'Brand', name: p.brand };
  if (!p.price_on_request && p.price > 0) {
    product.offers = {
      '@type': 'Offer',
      url: seo.canonical,
      priceCurrency: 'KZT',
      price: String(p.price),
      availability: p.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: SITE_NAME },
    };
  }

  const crumbs = [['Главная', '/'], ['Товары и услуги', '/catalog'],
    [p.category_name, catalogPath(p.category_slug)]];
  if (p.subcategory_slug) {
    for (const [pName, pPath] of await subcatChain(
        { parent_id: p.subcategory_parent_id }, p.category_slug)) crumbs.push([pName, pPath]);
    crumbs.push([p.subcategory_name, catalogPath(p.category_slug, p.subcategory_slug)]);
  }
  crumbs.push([p.name, productPath(p)]);

  seo.jsonld.push(product, breadcrumbLd(base, crumbs));
  return seo;
}

async function categorySeo(base, slug, subSlug, seo) {
  const cat = await db.getAsync('SELECT * FROM categories WHERE slug = ?', [slug]);
  if (!cat) { seo.robots = 'noindex, follow'; return seo; }

  const subs = String(subSlug || '').split(',').filter(Boolean);
  let sub = null;
  if (subs.length === 1) {
    sub = await db.getAsync(
      'SELECT * FROM subcategories WHERE slug = ? AND category_id = ?', [subs[0], cat.id]);
    // подкатегория без товаров в поддереве — не индексируем
    if (sub) {
      const n = await db.getAsync(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM subcategories WHERE id = ?
           UNION ALL SELECT s.id FROM subcategories s JOIN tree t ON s.parent_id = t.id
         ) SELECT COUNT(*) AS c FROM products WHERE subcategory_id IN (SELECT id FROM tree)`, [sub.id]);
      if (!n || !n.c) seo.robots = 'noindex, follow';
    }
  }

  const copy = CAT_COPY[slug] || {};
  seo.h1 = sub ? sub.name : cat.name;
  if (sub) {
    seo.title = sub.seo_title
      ? clip(sub.seo_title, 70)
      : clip(sub.name + ' — ' + cat.name + ' | ' + SITE_NAME, 65);
    seo.description = clip(sub.seo_description || sub.description ||
      (sub.name + ' — ' + cat.name.toLowerCase() + '. Поставка, монтаж и сервис по Казахстану от ' + SITE_NAME + '.'), 175);
    seo.canonical = base + catalogPath(slug, sub.slug);
  } else {
    seo.title = cat.seo_title
      ? clip(cat.seo_title, 70)
      : (copy.title || (cat.name + ' — ' + SITE_NAME));
    seo.description = cat.seo_description || copy.desc || clip(cat.description ||
      (cat.name + '. Профессиональное оборудование от ' + SITE_NAME + '. Поставка по Казахстану.'), 175);
    seo.canonical = base + catalogPath(slug);
    if (subs.length > 1) seo.robots = 'noindex, follow';
  }

  const crumbs = [['Главная', '/'], ['Товары и услуги', '/catalog'],
    [cat.name, catalogPath(slug)]];
  if (sub) {
    for (const [pName, pSlug] of await subcatChain(sub, slug)) crumbs.push([pName, pSlug]);
    crumbs.push([sub.name, catalogPath(slug, sub.slug)]);
  }
  seo.jsonld.push(breadcrumbLd(base, crumbs));
  return seo;
}

// Цепочка родительских подкатегорий (от верхней к нижней), без самой sub
async function subcatChain(sub, catSlug) {
  const out = [];
  let cur = sub;
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const par = await db.getAsync('SELECT id, name, slug, parent_id FROM subcategories WHERE id = ?', [cur.parent_id]);
    if (!par) break;
    out.unshift([par.name, catalogPath(catSlug, par.slug)]);
    cur = par;
  }
  return out;
}

/* Собрать SEO-контекст для страницы. relPath — как в middleware ("/index.html", "/about.html"…) */
async function build(req, relPath, opts = {}) {
  const base = baseUrl(req);
  const q = req.query || {};
  const seo = {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESC,
    canonical: base + (relPath === '/index.html' ? '/' : req.path),
    robots: 'index, follow',
    image: base + '/assets/icons/banner.png',
    jsonld: [orgLd(base), websiteLd(base)],
  };

  // ---- ЧПУ ----
  const pathname = decodeURIComponent(req.path);
  let mp = pathname.match(/^\/product\/(\d+)/);
  if (mp) return productSeo(base, mp[1], seo);
  let mc = pathname.match(/^\/catalog(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
  if (mc) {
    if (!mc[1]) {   // /catalog — весь каталог
      seo.title = 'Каталог оборудования — ' + SITE_NAME;
      seo.h1 = 'Товары и услуги';
      seo.canonical = base + '/catalog';
      seo.jsonld.push(breadcrumbLd(base, [['Главная', '/'], ['Товары и услуги', '/catalog']]));
      return seo;
    }
    return categorySeo(base, mc[1], mc[2] || q.subcategory || '', seo);
  }

  if (opts.softFallback && req.path !== '/') {
    seo.robots = 'noindex, follow';
    seo.canonical = base + '/';
    return seo;
  }

  if (relPath === '/index.html') {
    if (q.product) return productSeo(base, q.product, seo);
    if (q.category) return categorySeo(base, q.category, q.subcategory, seo);
    if (q.q) {
      seo.title = clip('Поиск: ' + q.q + ' — ' + SITE_NAME, 65);
      seo.description = 'Результаты поиска по каталогу SIGMA MARKET: ' + clip(q.q, 80) + '.';
      seo.h1 = clip('Поиск: ' + q.q, 80);
      seo.robots = 'noindex, follow';
      seo.canonical = base + '/';
      return seo;
    }
    seo.h1kind = 'home';
    seo.jsonld.push(breadcrumbLd(base, [['Главная', '/']]));
    return seo;
  }

  const st = STATIC_PAGES[relPath];
  if (st) {
    seo.title = st.title;
    seo.description = st.desc;
    seo.canonical = base + req.path.replace(/\.html$/, '');
    seo.jsonld.push(breadcrumbLd(base, [['Главная', '/'], [st.crumb, seo.canonical.replace(base, '')]]));
  }
  return seo;
}

function renderHead(seo) {
  if (NOINDEX) seo.robots = 'noindex, nofollow';   // пред-запусковый режим
  const t = esc(seo.title);
  const d = esc(seo.description);
  const url = esc(seo.canonical);
  const img = esc(seo.image);
  const tags = [
    `<link rel="icon" href="/assets/icons/logo.png">`,
    `<link rel="apple-touch-icon" href="/assets/icons/logo.png">`,
    `<meta name="description" id="metaDescription" content="${d}">`,
    `<meta name="robots" content="${esc(seo.robots)}">`,
    `<link rel="canonical" id="linkCanonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:locale" content="ru_RU">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${img}">`,
    `<meta name="theme-color" content="#1B6B37">`,
  ];
  if (NOINDEX) tags.push(`<script>window.SITE_NOINDEX=1</script>`); // чтобы SPA не перезаписал <meta robots>
  for (const obj of seo.jsonld || []) tags.push(jsonLd(obj));
  return tags.join('\n');
}

/* Перетегировать/переписать <h1 id="..."> в статичном html (SPA-заглушка index.html) */
function setH1(html, id, tag, text) {
  const re = new RegExp(`<h1([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/h1>`, 'i');
  return html.replace(re, (m, attrs, inner) =>
    `<${tag}${attrs}>${text != null ? esc(text) : inner}</${tag}>`);
}

/* Вставить SEO в готовый html-документ */
function inject(html, seo) {
  const head = renderHead(seo);
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(seo.title)}</title>`);
  } else {
    html = html.replace(/<head>/i, `<head>\n<title>${esc(seo.title)}</title>`);
  }

  // Ровно один <h1> на страницу и он соответствует разделу.
  // В index.html два статичных <h1>: #homeH1 (главная) и #catalogTitle (каталог).
  if (seo.h1kind === 'home') {
    html = setH1(html, 'catalogTitle', 'h2');
  } else if (seo.h1) {
    html = setH1(html, 'homeH1', 'h2');
    html = setH1(html, 'catalogTitle', 'h1', seo.h1);
  }

  return html.replace(/<\/head>/i, head + '\n</head>');
}

async function robots(req) {
  const base = baseUrl(req);
  // пред-запусковый режим (SITE_NOINDEX=1) — закрываем весь сайт
  if (NOINDEX) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /api/',
    'Disallow: /*?*q=',
    '',
    'Sitemap: ' + base + '/sitemap.xml',
    '',
  ].join('\n');
}

async function sitemap(req) {
  const base = baseUrl(req);
  const rows = [];
  const add = (loc, opts = {}) => rows.push({ loc, ...opts });

  add('/', { priority: '1.0', changefreq: 'daily' });
  add('/catalog', { priority: '0.7', changefreq: 'weekly' });
  add('/about', { priority: '0.5', changefreq: 'monthly' });
  add('/delivery', { priority: '0.5', changefreq: 'monthly' });
  add('/contacts', { priority: '0.5', changefreq: 'monthly' });
  add('/reviews', { priority: '0.4', changefreq: 'monthly' });

  const cats = await db.allAsync('SELECT slug FROM categories ORDER BY id');
  for (const c of cats) add(catalogPath(c.slug), { priority: '0.8', changefreq: 'weekly' });

  const subRows = await db.allAsync(
    `SELECT s.id, s.slug, s.parent_id, c.slug AS cat,
            (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) AS own
     FROM subcategories s JOIN categories c ON s.category_id = c.id
     ORDER BY c.id, s.sort, s.name`);
  const _sm = new Map(subRows.map((r) => [r.id, r]));
  subRows.forEach((r) => { r.cnt = r.own; });
  subRows.forEach((r) => {
    let pid = r.parent_id;
    while (pid && _sm.has(pid)) { _sm.get(pid).cnt += r.own; pid = _sm.get(pid).parent_id; }
  });
  for (const s of subRows.filter((r) => r.cnt > 0)) {
    add(catalogPath(s.cat, s.slug), { priority: '0.7', changefreq: 'weekly' });
  }

  const prods = await db.allAsync('SELECT id, name, created_at FROM products ORDER BY id');
  for (const p of prods) {
    add(productPath(p), {
      priority: '0.6', changefreq: 'weekly',
      lastmod: (p.created_at || '').slice(0, 10) || undefined,
    });
  }

  const body = rows.map((u) => {
    let s = '  <url><loc>' + esc(base + u.loc) + '</loc>';
    if (u.lastmod) s += '<lastmod>' + u.lastmod + '</lastmod>';
    if (u.changefreq) s += '<changefreq>' + u.changefreq + '</changefreq>';
    if (u.priority) s += '<priority>' + u.priority + '</priority>';
    return s + '</url>';
  }).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body + '\n</urlset>\n';
}

module.exports = { build, inject, robots, sitemap, baseUrl, legacyRedirect, productPath, catalogPath, slugName };
