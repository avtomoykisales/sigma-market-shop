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

# Ручные правки — точные карточки/разделы, которые SEO-менеджер (Евгений) нашёл вручную
# и которые автоматическое сопоставление не смогло найти (код/название не совпали),
# плюс разделы, которых нет на ЖИВОМ avtomoyki.kz (поэтому наш скрипт их не видит вообще).
# Перекрывают автоматический результат для тех же старых адресов. Сверено с базой sigma.db
# 2026-09-11 (все id товаров и слаги подкатегорий существуют на момент проверки).
MANUAL_OVERRIDES = {
    # ИСПРАВЛЕНО 2026-09-14 (Евгений поймал на живом сайте): подкатегория на боевом
    # сервере называется длиннее, чем в локальной sigma.db на момент первой сборки карты
    # (локальная копия базы отстала от боевой). Проверено через живой /api/products —
    # реальный слаг: avtomaticheskie-moyki-dlya-mashin-robotizirovann.
    '/g9248215-avtomaticheskie-mojki-dlya': '/catalog/avtomojka/avtomaticheskie-moyki-dlya-mashin-robotizirovann',
    # 239/240 — новые товары, добавлены в магазин 2026-09-11 (id совпали с тем, что
    # предсказал Евгений); в момент генерации карты их ещё не было в sigma.db, поэтому
    # прописаны явно, а не найдены автосопоставлением.
    '/p134844871-monoschetochnaya-moechnaya-ustanovka.html': '/product/239-monoschetochnaya-moechnaya-ustanovka-dlya-gruzovogo-transporta-mono-ro',
    '/p128286202-portalnaya-avtomaticheskaya-mojka.html': '/product/240-portalnaya-avtomaticheskaya-moyka-dlya-gruzovogo-avtobusnogo-avtotrans',
    '/g508383-professionalnye-kompressory-porshnevye-marki-sobekpro': '/catalog/sto/professionalnye-kompressory-porshnevye-marki-sob',
    '/g9469291-chetyrehstoechnye-podemniki': '/catalog/sto/chetyrehstoechnye-podemniki',
    '/g9469295-nozhnichnye-podemniki-dlya': '/catalog/sto/nozhnichnye-podemniki-dlya-avto',
    '/p122771497-dvuhstoechnyj-podemnik-445s.html': '/product/158-dvuhstoechnyy-podemnik-4-45s',
    '/p122804735-dvuhstoechnyj-podemnik-345.html': '/product/159-dvuhstoechnyy-podemnik-3-45-a',
    '/p122911976-dvuhstoechnyj-podemnik-342s.html': '/product/160-dvuhstoechnyy-podemnik-3-42s',
    '/p122912114-dvuhstoechnyj-podemnik-242s.html': '/product/161-dvuhstoechnyy-podemnik-2-42s',
    '/p122912167-dvuhstoechnyj-podemnik-power.html': '/product/162-dvuhstoechnyy-podemnik-power-lift-slh-4600-advanced',
    '/p122912320-dvuhstoechnyj-avtopodemnik-power.html': '/product/163-dvuhstoechnyy-avtopodemnik-power-lift-hf-3s-3500dt',
    '/p122912360-dvuhstoechnyj-avtopodemnik-smart.html': '/product/164-dvuhstoechnyy-avtopodemnik-smart-lift-2-30-sl-dt',
    '/p122922666-stanok-shinomontazhnyj-s110.html': '/product/165-stanok-shinomontazhnyy-s110',
    '/p122922705-stanok-shinomontazhnyj-c110.html': '/product/166-stanok-shinomontazhnyy-c110-te',
    '/p122923037-stanok-shinomontazhnyj-s222.html': '/product/167-stanok-shinomontazhnyy-s222',
    '/p122923077-stanok-shinomontazhnyj-c224.html': '/product/168-stanok-shinomontazhnyy-c224-e',
    '/p125223792-yangzi-s13-promyshlennaya.html': '/product/174-yangzi-s13-promyshlennaya-podmetalnaya-mashina-dlya-pola',
    '/p125313103-yangzi-s14-podmetalno.html': '/product/175-yangzi-s14-podmetalno-uborochnaya-mashina',
    '/p125325272-yangzi-s10-privodnaya.html': '/product/176-yangzi-s10-privodnaya-promyshlennaya-podmetalno-uborochnaya-mashina-dl',
    '/p125329524-yangzi-podmetalnaya-mashinu.html': '/product/177-yangzi-s8-podmetalnaya-mashinu-dlya-promyshlennyh-polov',
    '/p125332199-s12-promyshlennaya-podmetalnaya.html': '/product/178-yz-s12-promyshlennaya-podmetalnaya-mashina-dlya-pola-s-privodom',
    '/p125332208-yangzi-s11-podmetalno.html': '/product/179-yangzi-s11-podmetalno-uborochnaya-mashina-dlya-ulic',
    '/p125332339-yangzi-s15-polnostyu.html': '/product/180-yangzi-s15-polnostyu-zakrytaya-podmetalnaya-mashina-dlya-pola',
    '/p126915413-avtomaticheskaya-portalnaya-schetochnaya.html': '/product/190-avtomaticheskaya-portalnaya-schetochnaya-avtomoyka-risense-cf-340',
    '/p126915607-avtomaticheskaya-portalnaya-schetochnaya.html': '/product/191-avtomaticheskaya-portalnaya-schetochnaya-moyka-risense-cf-360',
    '/p126915920-portalnaya-robotizirovannaya-schetochnaya.html': '/product/192-portalnaya-robotizirovannaya-schetochnaya-moechnaya-ustanovka-dlya-moy',
    '/p126916565-robotizirovannaya-beskontaktnaya-moechnaya.html': '/product/193-robotizirovannaya-beskontaktnaya-moechnaya-ustanovka-risense-hp-232',
    '/p126919797-beskontaktnaya-robotizirovannaya-obraznaya.html': '/product/194-beskontaktnaya-robotizirovannaya-g-obraznaya-avtomaticheskaya-moyka-ri',
    '/p126920013-avtomaticheskaya-portalnaya-beskontaktnaya.html': '/product/195-avtomaticheskaya-portalnaya-beskontaktnaya-dvuhrychazhnaya-moyka-risen',
    '/p126920049-konvejernaya-avtomojka-tunnelnogo.html': '/product/196-konveyernaya-avtomoyka-tunnelnogo-tipa-risense-cc-650',
    '/p126938920-podmetalnaya-uborochnaya-mashina.html': '/product/197-podmetalnaya-uborochnaya-mashina-yangzi-s4',
    '/p126939182-podmetalnaya-uborochnaya-mashina.html': '/product/198-podmetalnaya-uborochnaya-mashina-yangzi-s5',
    '/p126939193-podmetalnaya-uborochnaya-mashina.html': '/product/199-podmetalnaya-uborochnaya-mashina-yangzi-s6',
    '/p126939231-podmetalnaya-uborochnaya-mashina.html': '/product/200-podmetalnaya-uborochnaya-mashina-yangzi-s18f',
    '/p126939328-avtomaticheskaya-tunnelnaya-avtomojka.html': '/product/201-avtomaticheskaya-tunnelnaya-avtomoyka-risense-cc-670',
    '/p126939552-avtomaticheskaya-tunnelnaya-avtomojka.html': '/product/202-avtomaticheskaya-tunnelnaya-avtomoyka-risense-cc-690',
    '/p126939647-konvejernaya-avtomojka-tunnelnogo.html': '/product/203-konveyernaya-avtomoyka-tunnelnogo-tipa-risense-cc-692',
    '/p126939702-avtomaticheskaya-tunnelnaya-konvejernaya.html': '/product/204-avtomaticheskaya-tunnelnaya-konveyernaya-avtomoyka-risense-cc-695',
    '/p126973503-beskontaktnaya-obraznaya-mojka.html': '/product/205-beskontaktnaya-g-obraznaya-moyka-ekonom-klassa-risense-nr-212',
    '/p126978244-robotizirovannaya-podmetalnaya-mashina.html': '/product/206-robotizirovannaya-podmetalnaya-mashina-s100n',
    '/p126978350-avtonomnaya-polomoechnaya-mashina.html': '/product/207-avtonomnaya-polomoechnaya-mashina-yangzi-sc50',
    '/p126978529-avtomatizirovannaya-polomoechnaya-mashinasc80.html': '/product/208-avtomatizirovannaya-polomoechnaya-mashinasc80',
    '/p127456350-kompressor-401-tandem.html': '/product/209-kompressor-ae-401-tandem',
    '/p134666385-beskontaktnaya-robotizirovannaya-avtomaticheskaya.html': '/product/238-beskontaktnaya-robotizirovannaya-avtomaticheskaya-moyka-risense-hp-262',
    '/p2464547-professionalnyj-moyuschij-pylevodosos.html': '/product/10-professionalnyy-moyuschiy-pylevodosos-ekstraktor-gamma-700',
    '/p2476841-resiver-arv-500.html': '/product/28-resiver-arv-500',
    '/p2575781-podmetalnaya-mashina-ruchnaya.html': '/product/34-podmetalnaya-mashina-ruchnaya-chancee-u90-skylight',
    '/p46093309-filtr-setka-dlya.html': '/product/70-filtr-setka-dlya-penokomplekta-idrobase-tabletka',
    '/p46093383-stanok-balansirovochnyj-dlya.html': '/product/72-stanok-balansirovochnyy-dlya-l-a-geodyna-4500-2',
    '/p46093440-stanok-balansirovochnyj-dlya.html': '/product/75-stanok-balansirovochnyy-dlya-g-a-geodyna-980-l',
    '/p46144200-kompressor-porshnevoj-301.html': '/product/77-kompressor-porshnevoy-ae-301',
    '/p49937623-kompressor-porshnevoj-302.html': '/product/82-kompressor-porshnevoy-ae-302',
    '/p52411212-zaschita-shlangov-vysokogo.html': '/product/83-zaschita-shlangov-vysokogo-davleniya-opletka-na-rvd',
    '/p59194898-bortorasshiritel-td102.html': '/product/95-bortorasshiritel-td102',
    '/p59199872-vulkanizator-101.html': '/product/96-vulkanizator-te-101',
    '/p59437441-shlang-dlya-nasosa.html': '/product/105-shlang-dlya-nasosa-605000',
    '/p59437642-pistolet-dlya-razdachi.html': '/product/108-pistolet-dlya-razdachi-masla-365535',
    '/p59437706-katushka-maslostojkim-shlangom.html': '/product/109-katushka-s-maslostoykim-shlangom-501200',
    '/p76345458-derzhatel-kolchan-dlya.html': '/product/122-derzhatel-kolchan-dlya-pistoletov-na-avtomoyke-iz-nerzhaveyuschey-stal',
}

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

# применяем ручные правки: либо заменяем найденный автоматически результат, либо
# добавляем новую строку (для разделов, которых нет на живом sitemap вообще)
m_manual = 0
by_old = {old: i for i, (old, _, _) in enumerate(uniq)}
for old, new in MANUAL_OVERRIDES.items():
    note = 'ручная правка (Евгений/проверено)'
    if old in by_old:
        i = by_old[old]
        if uniq[i][1] != new:
            uniq[i] = (old, new, note)
            m_manual += 1
    else:
        uniq.append((old, new, note))
        by_old[old] = len(uniq) - 1
        m_manual += 1

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
print(f'  + ручные правки (сверка с файлом Евгения): {m_manual}')
still_unmapped = [u for u in unmapped if u.startswith('/p') and u not in MANUAL_OVERRIDES]
print(f'\nВ общий каталог, БЕЗ ручной правки (нужна привязка или свежий экспорт): {len(still_unmapped)}')
for u in still_unmapped: print('  ', u)
