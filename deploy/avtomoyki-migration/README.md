# Переезд avtomoyki.kz → b2btech.kz (301-редиректы)

Старый сайт `avtomoyki.kz` (витрина на Satu.kz) закрывается, весь трафик по
старым адресам 301-редиректится на новый сайт `b2btech.kz`.

## Файлы

| Файл | Куда на сервере | Что это |
|---|---|---|
| `avtomoyki-map.conf` | `/etc/nginx/conf.d/avtomoyki-map.conf` | `map` со всеми правилами (старый путь → новый) |
| `nginx-avtomoyki.conf` | `/etc/nginx/sites-available/avtomoyki` (+ symlink в `sites-enabled/`) | server-блок для домена |
| `nginx-map-hash-size.conf` | `/etc/nginx/conf.d/00-map-hash-size.conf` | увеличивает `map_hash_bucket_size` — без него `nginx -t` падает (карта длинная) |
| `redirect-map.csv` | — | человекочитаемая карта для проверки SEO-менеджером |
| `build-redirect-map.py` | — | генератор карты (⚠️ больше нельзя просто перезапускать, см. ниже) |
| `apply-overrides.py` | — | безопасно накатывает новые `MANUAL_OVERRIDES` на уже готовую карту, без обращения к живым sitemap |

## Что покрыто (карта от 2026-09-11, 284 правила — сверена с Евгением, 252/253)

Новый сайт использует ЧПУ-адреса: `/catalog/{категория}/{подкатегория}` и
`/product/{id}-{слаг}`. Карта ведёт сразу на них.

- **Главная** → `b2btech.kz/`
- **8 статических страниц** (о нас, контакты, доставка, отзывы …) → соответствующие
- **37 разделов** `avtomoyki.kz/g…` → `b2btech.kz/catalog/{кат}/{подкат}` (35 с живого
  sitemap + 2 вручную — их нет на живом avtomoyki.kz, но они есть в экспорте Satu)
- **237 товаров** `avtomoyki.kz/p…` → **все 237 на точные карточки** товара на b2btech.kz
- Всё неизвестное → главная b2btech.kz

### Проверка от Евгения (2026-09-11, дополнено 2026-09-14)

Карту сверили с файлом SEO-менеджера `Редиректы для нового домена.xlsx` (253 адреса
им проверены вручную). 59 адресов в нашей карте были улучшены его ручными находками
(карточки товаров, которые автоматическое сопоставление не нашло, + 2 товара,
добавленных в магазин уже после первой сверки) — всё встроено в `build-redirect-map.py`
как `MANUAL_OVERRIDES`, переживёт пересборку карты.

14.09.2026 Евгений поймал на живом сайте ещё один баг: `/g9248215-avtomaticheskie-mojki-dlya`
редиректил на `/catalog/avtomojka/avtomaticheskie-moyki-dlya` — такой подкатегории на
боевом сервере не существует (в прошлый раз я ошибочно посчитал это неточной находкой
Евгения, сверяя со своей отставшей локальной копией базы). Проверка через живой
`/api/products` подтвердила: Евгений был прав, реальный слаг —
`avtomaticheskie-moyki-dlya-mashin-robotizirovann`. Исправлено в `MANUAL_OVERRIDES`.

**Важно:** живые sitemap `avtomoyki.kz` (на которых строится автосопоставление в
`build-redirect-map.py`) с 2026-09-11/12 больше недоступны в исходном виде — домен
теперь сам указывает на наш сервер и любой запрос к нему улетает 301-редиректом на
b2btech.kz. Поэтому **`build-redirect-map.py` больше нельзя просто перезапускать** —
он тихо (без ошибки) получит 0 разделов и 0 товаров с sitemap и сломает карту. Новые
точечные правки теперь нужно вносить только через `MANUAL_OVERRIDES` в самом скрипте
(`build-redirect-map.py`) и накатывать командой `python3 apply-overrides.py` (она берёт
текущий `avtomoyki-map.conf`/`redirect-map.csv` как базу и добавляет только новые/
изменённые пары `old → new`) — не через полный перезапуск генератора.

**Иерархия разделов восстановлена.** На b2btech.kz у подкатегорий появился «родитель»
(поле `subcategories.parent_id`), дерево «групп» Satu воссоздано (миграция `subcat_tree_v1`
в database.js). Промежуточные разделы (Автоматические мойки для машин, Профессиональные
пылесосы, Автоподъёмники и т.д.) — теперь настоящие страницы, показывают товары всех
дочерних подгрупп, индексируются. Редиректы `g…` ведут прямо в эти разделы.

> Если добавите в магазин ещё товары/разделы со старого сайта — впишите пару
> `old → new` в `MANUAL_OVERRIDES` (шапка `build-redirect-map.py`) и запустите
> `python3 apply-overrides.py` (см. предупреждение выше про сам генератор).

## Порядок деплоя (без простоя)

Делать в этом порядке, старый сайт до шага 5 продолжает работать на Satu.

### 1. DNS-зона в ps.kz (заранее, NS пока НЕ менять)
- ps.kz → Управление DNS → создать зону `avtomoyki.kz`
- A-запись: `avtomoyki.kz` → `185.146.1.112`
- A-запись: `www` → `185.146.1.112` (или CNAME `www` → `avtomoyki.kz`)

### 2. Точечные правки карты (по необходимости)

Если нужно добавить/исправить адрес — допишите пару в `MANUAL_OVERRIDES` в шапке
`build-redirect-map.py` и запустите `python3 deploy/avtomoyki-migration/apply-overrides.py`
(⚠️ не сам `build-redirect-map.py` — см. предупреждение выше).

### 3. Залить конфиги на сервер
С Мака:
```bash
scp -o PubkeyAuthentication=no -o PreferredAuthentications=password \
  deploy/avtomoyki-migration/avtomoyki-map.conf \
  deploy/avtomoyki-migration/nginx-avtomoyki.conf \
  deploy/avtomoyki-migration/nginx-map-hash-size.conf \
  ubuntu@185.146.1.112:/tmp/
```
На сервере:
```bash
sudo mv /tmp/avtomoyki-map.conf      /etc/nginx/conf.d/avtomoyki-map.conf
sudo mv /tmp/nginx-avtomoyki.conf    /etc/nginx/sites-available/avtomoyki
sudo mv /tmp/nginx-map-hash-size.conf /etc/nginx/conf.d/00-map-hash-size.conf
sudo ln -s /etc/nginx/sites-available/avtomoyki /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
(`00-map-hash-size.conf` увеличивает `map_hash_bucket_size` — без него `nginx -t`
падает с `could not build map_hash`, в карте много длинных адресов)
(конфиг пока только на порту 80 — этого достаточно, чтобы редиректы заработали
сразу после смены NS; HTTPS добавит certbot в шаге 5)

### 4. Сменить NS у регистратора avtomoyki.kz
`ns1.promdns.net` / `ns2` / `ns3` → `ns1.ps.kz` / `ns2.ps.kz` / `ns3.ps.kz`
Делегирование `.kz` — обычно 1–2 часа. Проверка:
```bash
dig +short avtomoyki.kz            # → 185.146.1.112
```

### 5. SSL (после того как dig показал нужный IP)
```bash
sudo certbot --nginx -d avtomoyki.kz -d www.avtomoyki.kz
```
certbot сам добавит в конфиг `listen 443 ssl`, сертификат и редирект 80→443.
Затем `sudo nginx -t && sudo systemctl reload nginx`.

### 6. Проверка
```bash
curl -sI  https://avtomoyki.kz/                                        | grep -i location
curl -sI  https://avtomoyki.kz/g9403393-podmetalnye-mashiny            | grep -i location
curl -sI  https://avtomoyki.kz/p2464312-professionalnyj-pylevodosos-topper.html | grep -i location
```
Все — `HTTP/.. 301` + `location: https://b2btech.kz/catalog/...` или `/product/...`.

### 7. Поисковики
- **Google Search Console**: старый ресурс `avtomoyki.kz` → Настройки → «Изменение адреса» → `b2btech.kz`
- **Яндекс.Вебмастер**: `avtomoyki.kz` → «Переезд сайта» → указать `b2btech.kz` (HTTPS)
- Обновить `sitemap.xml` в обоих кабинетах на `https://b2btech.kz/sitemap.xml`

### 8. Только теперь — отключить подписку Satu.

## Держать редиректы

Минимум 1 год, лучше — постоянно. Пока `avtomoyki.kz` продлевается и NS на ps.kz,
этот конфиг трогать не нужно.
