#!/usr/bin/env python3
"""
Строит карту 301-редиректов avtomoyki.kz -> b2btech.kz.
Источники: экспорт Satu (.xlsx), sigma.db магазина, живые sitemap avtomoyki.kz.
Пишет рядом с собой: avtomoyki-map.conf, redirect-map.csv.
Перед запуском поставь свежий SATU_XLSX (экспорт Товары+Группы из Satu).
Запуск:  python3 build-redirect-map.py
"""
import openpyxl, sqlite3, re, gzip, urllib.request

SATU_XLSX = '/Users/mira/Downloads/export-products-28-08-26_10-04-07.xlsx'
DB  = '/Users/mira/Documents/MyProjects/sigma-shop/sigma.db'
NEW = 'https://b2btech.kz'

def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[«»"\'()]', '', str(s or ''))).strip().lower()
def path(u):
    return re.sub(r'^https?://[^/]+', '', u)

# ЧПУ: должно совпадать со slugName() в seo.js / index.html
_TR = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
       'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
       'х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'}
def slug_name(s):
    s = ''.join(_TR.get(ch, ch) for ch in str(s or '').lower())
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:70].rstrip('-')
    return s
def cat_path(cat, sub=None):
    if not cat or cat == 'all':
        return '/catalog'
    return '/catalog/' + cat + ('/' + sub if sub else '')
def prod_path(pid, name):
    return '/product/' + str(pid) + ('-' + slug_name(name) if name else '')

def sm(name):
    raw = urllib.request.urlopen(f'https://avtomoyki.kz/sitemap_{name}-0.xml', timeout=25).read()
    try: raw = gzip.decompress(raw)
    except Exception: pass
    return re.findall(r'<loc>([^<]+)</loc>', raw.decode('utf-8', 'replace'))

live_products, live_groups = sm('products'), sm('groups')
live_root, live_articles = sm('root'), sm('articles')

db = sqlite3.connect(DB)
cats = {slug: name for slug, name in db.execute('SELECT slug,name FROM categories')}
subs = {}          # norm(name) -> (cat, sub)  — подкатегории с непустым ПОДДЕРЕВОМ
sub_slugs = set()
_srow = {}         # id -> {cat, slug, name, parent, own}
for sid, pid, cslug, sslug, sname, own in db.execute(
        '''SELECT s.id, s.parent_id, c.slug, s.slug, s.name,
                  (SELECT COUNT(*) FROM products p WHERE p.subcategory_id=s.id)
           FROM subcategories s JOIN categories c ON s.category_id=c.id'''):
    sub_slugs.add((cslug, sslug))
    _srow[sid] = {'cat': cslug, 'slug': sslug, 'name': sname, 'parent': pid, 'cnt': own}
for sid, r in list(_srow.items()):        # свернуть own вверх по дереву
    pid = r['parent']
    while pid and pid in _srow:
        _srow[pid]['cnt'] += r['cnt']; pid = _srow[pid]['parent']
for r in _srow.values():
    if r['cnt'] > 0:
        subs[norm(r['name'])] = (r['cat'], r['slug'])
prod_by_art, prod_by_name = {}, {}
for pid, name, art, cslug, sslug in db.execute(
        '''SELECT p.id,p.name,p.article,c.slug,sc.slug FROM products p
           JOIN categories c ON p.category_id=c.id
           LEFT JOIN subcategories sc ON p.subcategory_id=sc.id'''):
    if art: prod_by_art[str(art).strip()] = (pid, cslug, sslug, name)
    prod_by_name.setdefault(norm(name), (pid, cslug, sslug, name))

wb = openpyxl.load_workbook(SATU_XLSX, data_only=True, read_only=True)
r = wb['Export Products Sheet'].iter_rows(values_only=True); next(r)
satu_url_to_art, satu_url_to_grp = {}, {}
for row in r:
    art, grp, url = row[0], row[13], row[28]
    if url:
        p = path(url).strip()
        if art: satu_url_to_art[p] = str(art).strip()
        if grp: satu_url_to_grp[p] = str(grp)
r = wb['Export Groups Sheet'].iter_rows(values_only=True); next(r)
gmeta = {}
for row in r:
    num, name, _, parent = row[0], row[1], row[2], row[3]
    if num is not None:
        gmeta[str(num)] = {'name': name, 'parent': str(parent) if parent else None}

TOPCAT = {'524741': 'avtomojka', '3183127': 'sto', '4395418': 'klining'}
STATIC = {'/':'/', '/about_us':'/about', '/contacts':'/contacts', '/delivery_info':'/delivery',
          '/return_policy':'/delivery', '/testimonials':'/reviews', '/product_list':'/catalog',
          '/articles':'/reviews'}
# запасные правила по ключевым словам в слаге (когда точной карточки нет)
KW = [
    (r'chetyrehstoechn', ('sto','chetyrehstoechnye-podemniki')),
    (r'nozhnichn.*podem', ('sto','nozhnichnye-podemniki-dlya-avto')),
    (r'dvuhstoechn.*(podem|avtopodem)', ('sto','dvuhstoechnye-podemniki')),
    (r'shinomontazhn', ('sto','shinomontazhnoe-oborudovanie')),
    (r'balansirovochn', ('sto','balansirovochnye-stanki-dlya-shinomontazha')),
    (r'(kompressor-porshnev|resiver)', ('sto','kompressory-porshnevye-vozdushnye')),
    (r'press', ('sto','pressy-gidravlicheskie-dlya-sto-i-avtoservisa')),
    (r'(maslorazd|maslostojk|razdachi|katushka|nasosa-samoa)', ('sto','maslorazdatochnoe-oborudovanie')),
    (r'konsistentn', ('sto','oborudovanie-dlya-konsistentnoy-smazki')),
    (r'(vulkanizator|bortorasshiritel|derzhatel|kolchan|zaschita-shlangov|filtr-setka)', ('sto',None)),
    (r'konvejern.*avtomojk', ('avtomojka','avtomaticheskie-konveyernye-avtomoyki-tunnelnogo')),
    (r'portaln.*(avtomojk|schetochn|robotizirovann)', ('avtomojka','portalnye-avtomoyki')),
    (r'beskontaktn.*robotizir|robotizir.*beskontaktn', ('avtomojka','beskontaktnye-robotizirovannye-avtomoyki')),
    (r'(avtomatichesk.*(mojk|portaln)|robotizirovann)', ('avtomojka','avtomaticheskie-moyki-dlya-mashin-robotizirovann')),
    (r'polomoechn', ('klining','polomoechnye-mashiny')),
    (r'podmetaln|podmetalno', ('klining','podmetalnye-mashiny')),
    (r'ekstraktor', ('avtomojka','pylesosy-ekstraktory')),
    (r'moyusch.*pylevodosos|moyusch.*pyleso', ('avtomojka','professionalnye-moyuschie-pylesosy')),
    (r'pylevodosos', ('avtomojka','professionalnye-pylevodososy')),
    (r'pyleso', ('avtomojka','professionalnye-pylesosy')),
    (r'(apparat|mojk).*vysokogo-davleni|avd', ('avtomojka','apparaty-vysokogo-davleniya-avd')),
    (r'ochistn|ochistk', ('avtomojka','ochistnye-sooruzheniya-dlya-avtomoyki')),
]

rules, unmapped, review = [], [], []

def add(old, new, note):
    rules.append((old, new, note))

for u in live_root:
    p = path(u)
    add(p, STATIC.get(p, '/'), 'страница' if p in STATIC else 'нет пары → главная')
    if p not in STATIC: unmapped.append(p)
for u in live_articles:
    add(path(u), '/reviews', 'статья → отзывы')

def group_target(gid):
    if gid in TOPCAT: return cat_path(TOPCAT[gid])
    m = gmeta.get(gid)
    if m:
        s = subs.get(norm(m['name']))
        if s: return cat_path(s[0], s[1])
        par, seen = m['parent'], set()
        while par and par not in TOPCAT and par not in seen:
            seen.add(par); par = gmeta.get(par, {}).get('parent')
        if par in TOPCAT: return cat_path(TOPCAT[par])
    return None

for u in live_groups:
    p = path(u); gid = re.match(r'/g(\d+)', p).group(1)
    t = group_target(gid)
    if t: add(p, t, 'раздел')
    else: add(p, '/catalog', 'раздел без пары → каталог'); unmapped.append(p)

def kw_target(slug):
    for rx, (c, s) in KW:
        if re.search(rx, slug):
            return cat_path(c, s)
    return None

m_art = m_name = m_grp = m_kw = m_fb = 0
for u in live_products:
    p = path(u)
    art = satu_url_to_art.get(p)
    hit = prod_by_art.get(art) if art else None
    if hit:
        add(p, prod_path(hit[0], hit[3]), 'товар (по коду)'); m_art += 1; continue
    slug = re.sub(r'^/p\d+-|\.html$', '', p)
    # по названию
    cand = None
    for nkey, val in prod_by_name.items():
        knorm = re.sub(r'[^a-z0-9]+', '-', nkey).strip('-')
        if slug and len(slug) > 6 and (slug in knorm or knorm[:len(slug)] == slug):
            cand = val; break
    if cand:
        add(p, prod_path(cand[0], cand[3]), 'товар (по названию)'); m_name += 1; continue
    # по группе Satu
    gid = satu_url_to_grp.get(p)
    t = group_target(gid) if gid else None
    if t:
        add(p, t, 'товар → раздел (из экспорта)'); m_grp += 1; review.append((p, t)); continue
    # по ключевым словам
    t = kw_target(slug)
    if t:
        add(p, t, 'товар → раздел (по ключевым словам)'); m_kw += 1; review.append((p, t)); continue
    add(p, '/catalog', 'товар без пары → каталог'); m_fb += 1; unmapped.append(p)

# Товары из ЭКСПОРТА, которых нет в живом sitemap (сняты с публикации), но по старым
# адресам ещё возможны переходы из Google/закладок → ведём на точную карточку.
satu_url_to_name = {}
r2 = wb['Export Products Sheet'].iter_rows(values_only=True); next(r2)
for row in r2:
    if row[28]:
        satu_url_to_name[path(row[28]).strip()] = row[1]
live_paths = {path(u) for u in live_products}
added_old = {o for o, _, _ in rules}
m_extra = 0
for p in satu_url_to_art:
    if not p.startswith('/p') or p in live_paths or p in added_old:
        continue
    hit = prod_by_art.get(satu_url_to_art[p]) or prod_by_name.get(norm(satu_url_to_name.get(p)))
    if hit:
        add(p, prod_path(hit[0], hit[3]), 'товар (снят с публикации на Satu)'); m_extra += 1

# dedupe
seen, uniq = set(), []
for old, new, note in rules:
    if old in seen: continue
    seen.add(old); uniq.append((old, new, note))

import os
OUT = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(OUT, 'avtomoyki-map.conf'), 'w') as f:
    f.write('# avtomoyki.kz -> b2btech.kz  |  /etc/nginx/conf.d/avtomoyki-map.conf\n')
    f.write('map $uri $b2b_redirect {\n    default "";\n')
    for old, new, _ in uniq:
        f.write(f'    {old:<64} "{new}";\n')   # значения В КАВЫЧКАХ (в них ? & = #)
    f.write('}\n')

with open(os.path.join(OUT, 'redirect-map.csv'), 'w') as f:
    f.write('Старый адрес,Новый адрес,Тип,Проверить\n')
    for old, new, note in uniq:
        chk = 'да' if ('раздел' in note and 'товар' in note) or 'без пары' in note else ''
        f.write(f'https://avtomoyki.kz{old},{NEW}{new},{note},{chk}\n')

print(f'Всего правил: {len(uniq)}')
print(f'  страницы:  9')
print(f'  разделы:   {len(live_groups)}')
print(f'  товары:    {len(live_products)}')
print(f'     точно (код):        {m_art}')
print(f'     точно (название):   {m_name}')
print(f'     в раздел (экспорт): {m_grp}')
print(f'     в раздел (кл.слова):{m_kw}')
print(f'     в общий каталог:    {m_fb}')
print(f'  + карточки снятых с Satu товаров: {m_extra}')
print(f'\nВ общий каталог (нужна ручная привязка или свежий экспорт): {m_fb}')
for u in unmapped:
    if u.startswith('/p'): print('  ', u)
