# Переезд avtomoyki.kz → b2btech.kz (301-редиректы)

Старый сайт `avtomoyki.kz` (витрина на Satu.kz) закрывается, весь трафик по
старым адресам 301-редиректится на новый сайт `b2btech.kz`.

## Файлы

| Файл | Куда на сервере | Что это |
|---|---|---|
| `avtomoyki-map.conf` | `/etc/nginx/conf.d/avtomoyki-map.conf` | `map` со всеми правилами (старый путь → новый) |
| `nginx-avtomoyki.conf` | `/etc/nginx/sites-available/avtomoyki` (+ symlink в `sites-enabled/`) | server-блок для домена |
| `redirect-map.csv` | — | человекочитаемая карта для проверки SEO-менеджером |
| `build-redirect-map.py` | — | генератор карты (перезапустить со свежим экспортом Satu) |

## Что покрыто (карта от 2026-09-07, 279 правил)

Новый сайт использует ЧПУ-адреса: `/catalog/{категория}/{подкатегория}` и
`/product/{id}-{слаг}`. Карта ведёт сразу на них.

- **Главная** → `b2btech.kz/`
- **8 статических страниц** (о нас, контакты, доставка, отзывы …) → соответствующие
- **35 разделов** `avtomoyki.kz/g…` → `b2btech.kz/catalog/{кат}/{подкат}`
- **235 товаров** `avtomoyki.kz/p…`:
  - 208 — в живом sitemap Satu; из них **154 → точная карточка**, 54 → их подраздел
    (этих товаров нет на b2btech.kz)
  - +27 — сняты с публикации на Satu, но старые адреса ещё в индексе → **точная карточка**
  - **Итого 181 → точная карточка, 54 → раздел.** Битых ссылок 0 (все id и слаги сверены с b2btech.kz).
- Всё неизвестное → главная b2btech.kz

**Иерархия разделов восстановлена.** На b2btech.kz у подкатегорий появился «родитель»
(поле `subcategories.parent_id`), дерево «групп» Satu воссоздано (миграция `subcat_tree_v1`
в database.js). Промежуточные разделы (Автоматические мойки для машин, Профессиональные
пылесосы, Автоподъёмники и т.д.) — теперь настоящие страницы, показывают товары всех
дочерних подгрупп, индексируются. Редиректы `g…` ведут прямо в эти разделы.

> Чтобы поднять 154 → ~200 точных карточек: сделать **свежий экспорт из Satu**
> (Товары + Группы), заменить `SATU_XLSX` в скрипте и перезапустить
> `python3 build-redirect-map.py` — он пересоберёт `avtomoyki-map.conf`.

## Порядок деплоя (без простоя)

Делать в этом порядке, старый сайт до шага 5 продолжает работать на Satu.

### 1. DNS-зона в ps.kz (заранее, NS пока НЕ менять)
- ps.kz → Управление DNS → создать зону `avtomoyki.kz`
- A-запись: `avtomoyki.kz` → `185.146.1.112`
- A-запись: `www` → `185.146.1.112` (или CNAME `www` → `avtomoyki.kz`)

### 2. Свежий экспорт Satu + пересборка карты (по желанию, для полноты)
```
python3 deploy/avtomoyki-migration/build-redirect-map.py
```

### 3. Залить конфиги на сервер
С Мака:
```bash
scp -o PubkeyAuthentication=no -o PreferredAuthentications=password \
  deploy/avtomoyki-migration/avtomoyki-map.conf \
  deploy/avtomoyki-migration/nginx-avtomoyki.conf \
  ubuntu@185.146.1.112:/tmp/
```
На сервере:
```bash
sudo mv /tmp/avtomoyki-map.conf   /etc/nginx/conf.d/avtomoyki-map.conf
sudo mv /tmp/nginx-avtomoyki.conf /etc/nginx/sites-available/avtomoyki
sudo ln -s /etc/nginx/sites-available/avtomoyki /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
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
