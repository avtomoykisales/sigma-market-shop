/* ============================================================
   SIGMA MARKET — страница товара (полная карточка)
   Подключается в index.html ПОСЛЕ /js/site.js и ДО основного
   inline-скрипта. Использует общие функции/переменные:
   state, favIds, apiFetch, formatPrice, getCatEmoji, setView,
   setActiveNav, scrollToView, showCatalog, addToCart, toggleFav,
   toggleCart, pushRecent, renderRecent — они объявлены в inline-
   скрипте / site.js (общая область classic-скриптов).
   ============================================================ */

// ---- галерея изображений ----
let pvGallery = [], pvIdx = 0;

function pvSetImg(i) {
  if (!pvGallery.length) return;
  pvIdx = (i + pvGallery.length) % pvGallery.length;
  const main = document.getElementById('pvMainImg');
  if (main) { main.style.visibility = ''; main.src = '/icons/' + pvGallery[pvIdx]; }
  document.querySelectorAll('#pvThumbs .pv-thumb').forEach((t, n) => t.classList.toggle('active', n === pvIdx));
}
function pvNav(dir) { pvSetImg(pvIdx + dir); }

function ytEmbed(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// ---- иконки кнопок-карточек в блоке покупки (pv-cta-grid) ----
const PV_ICON_KP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/></svg>';
const PV_ICON_CART = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
const PV_ICON_HEART = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-6.7-4.3-9.3-8.1C.8 10 1.4 6.4 4.4 4.9c2.3-1.1 4.8-.3 6.1 1.6l1.5 2 1.5-2c1.3-1.9 3.8-2.7 6.1-1.6 3 1.5 3.6 5.1 1.7 8C18.7 16.7 12 21 12 21z"/></svg>';
const PV_ICON_COMPARE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="20" x2="6" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="14"/></svg>';

async function showProduct(id) {
  state.view = 'product';
  state.productId = id;
  setUrl('/product/' + id);
  await setView('product');
  setActiveNav('catalog');
  const body = document.getElementById('productViewBody');
  // На медленном/нестабильном интернете партиал productView иногда не успевает
  // вставиться в DOM к этому моменту, хотя setView() уже отработал (см. ensureView) —
  // без этой проверки следующая строка падает с "Cannot read properties of null".
  // Обычный переход вместо падения — там всё точно догрузится заново с нуля.
  if (!body) { location.href = '/product/' + id; return; }
  // Сервер уже мог отрисовать этот же товар сразу в HTML (см. seo.productViewHtml) —
  // если это тот самый товар, не стираем готовый контент спиннером до ответа fetch:
  // иначе робот Google, у которого сам /api/ закрыт в robots.txt, увидит на странице
  // только "Загрузка…" навсегда, вместо уже готового текста.
  if (body.dataset.productId !== String(id)) {
    body.innerHTML = '<div class="spinner"><div class="spin"></div>&nbsp; Загрузка…</div>';
  }
  scrollToView('productView');

  // На мобильном интернете сам запрос данных товара иногда обрывается (сбой сети —
  // "Failed to fetch"), а не просто медленно идёт. Раньше это тихо обрывало всю
  // функцию на середине — страница застревала на "Загрузка…" без кнопок связи и
  // без ошибки. Теперь пробуем ещё пару раз сами, и только потом сдаёмся с кнопкой
  // "Повторить" вместо вечного спиннера.
  let p;
  for (let attempt = 0; ; attempt++) {
    try { p = await apiFetch(`/api/products/${id}`); break; }
    catch (e) {
      if (attempt >= 2) {
        // Если на странице уже есть готовый серверный контент этого товара (см. выше) —
        // ни в коем случае не затираем его сообщением об ошибке: для робота Google/
        // Яндекса, у которого сам /api/ закрыт в robots.txt, это и так единственный
        // источник текста страницы — сбой повторного клиентского запроса тут не беда.
        if (window.logClientError) window.logClientError('Не удалось загрузить товар #' + id + ' после 3 попыток: ' + (e && (e.message || e)), 'showProduct');
        if (state.productId === id && body.dataset.productId !== String(id)) {
          body.innerHTML = `<div class="spinner">Не удалось загрузить товар — проверьте интернет.
            <button type="button" class="btn-catalog" onclick="showProduct(${id})" style="margin-top:12px">Повторить</button></div>`;
        }
        return;
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }
  if (!p || p.error) { if (typeof showNotFound === 'function') showNotFound(); return; }
  body.dataset.productId = String(id);

  replaceUrl(productUrl(p));   // уточняем адрес слагом ДО setMeta (чтобы Метрика видела полный URL)
  // SEO: title/description считает сервер (seo.productMeta) и отдаёт в p.seo — не дублируем формулу
  if (typeof setMeta === 'function') {
    const m = p.seo || {};
    setMeta(
      m.title || (p.name + ' — SIGMA MARKET'),
      m.description || '',
      productUrl(p)
    );
  }
  let specs = p.specs;
  if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch (e) { specs = {}; } }

  const S = ' <span class="crumb-sep">›</span> ';
  let crumb = `<a href="/catalog" onclick="showCatalog('all');return false;">Товары и услуги</a>` +
    S + `<a href="/catalog/${p.category_slug}" onclick="showCatalog('${p.category_slug}');return false;">${p.category_name}</a>`;
  if (p.subcategory_slug) {
    crumb += S + `<a href="/catalog/${p.category_slug}/${p.subcategory_slug}" onclick="showCatalog('${p.category_slug}','${p.subcategory_slug}');return false;">${p.subcategory_name}</a>`;
  }
  crumb += S + `<span class="crumb-current">${p.name}</span>`;
  document.getElementById('pvCrumb').innerHTML = crumb;

  pvGallery = (p.gallery && p.gallery.length) ? p.gallery.slice() : [];
  pvIdx = 0;
  const pvBadgesHtml = window.featuredBadgesHtml ? window.featuredBadgesHtml(p) : '';
  const galleryHtml = pvGallery.length
    ? `<div class="pv-img">
         ${pvBadgesHtml}
         <img id="pvMainImg" src="/icons/${pvGallery[0]}" alt="${p.name}" fetchpriority="high" onerror="this.style.visibility='hidden'">
         ${pvGallery.length > 1 ? `
           <button class="pv-nav prev" type="button" onclick="pvNav(-1)">‹</button>
           <button class="pv-nav next" type="button" onclick="pvNav(1)">›</button>` : ''}
       </div>
       ${pvGallery.length > 1 ? `<div class="pv-thumbs" id="pvThumbs">
         ${pvGallery.map((fn, i) => `<button class="pv-thumb${i === 0 ? ' active' : ''}" type="button" onclick="pvSetImg(${i})"><img src="${thumbIconUrl(fn)}" alt="" onerror="this.onerror=function(){this.style.opacity=.2};this.src='/icons/${fn}'"></button>`).join('')}
       </div>` : ''}`
    : `<div class="pv-img">${pvBadgesHtml}<span style="font-size:90px">${getCatEmoji(p.category_slug)}</span></div>`;

  const pvBonus = window.bonusForPrice(p.price);
  const priceHtml = p.price_on_request
    ? `<div class="pv-price-req">Цена по запросу — итоговая стоимость зависит от комплектации</div>`
    : p.price ? `<div class="pv-price">${formatPrice(p.price)}</div>${pvBonus ? `<div class="pv-bonus">+${pvBonus.toLocaleString('ru-KZ')} ₸ бонусов на счёт</div>` : ''}` : '';

  // Блок покупки — две крупные кнопки (В корзину / КП), две второстепенные (WhatsApp/
  // Позвонить, нейтральные) и компактные текстовые действия (избранное/сравнить) без
  // отдельных рамок. Раньше тут же была карточка «Нужна консультация» — убрали: связаться
  // можно и так через «Позвонить»/WhatsApp, а дублирующий блок только отвлекал внимание.
  const kpInstant = typeof state !== 'undefined' && state.settings && state.settings.kp && state.settings.kp.instantDownload;
  const offerBtn = kpInstant
    ? `<button type="button" class="pv-cta pv-cta-kp" onclick="openKpModal(${p.id})"><span class="pv-cta-icon">${PV_ICON_KP}</span><span class="pv-cta-text"><b>Скачать КП</b><small>Коммерческое предложение</small></span></button>`
    : `<button type="button" class="pv-cta pv-cta-kp" onclick="requestModal(${p.id})"><span class="pv-cta-icon">${PV_ICON_KP}</span><span class="pv-cta-text"><b>Запросить КП</b><small>Коммерческое предложение</small></span></button>`;
  const buyBtn = p.price_on_request ? '' : `<button type="button" class="pv-cta pv-cta-cart" onclick="buyNow(${p.id})"><span class="pv-cta-icon">${PV_ICON_CART}</span><span class="pv-cta-text"><b>Добавить в корзину</b></span></button>`;
  // contactActions живёт в /js/site.js — на медленном мобильном интернете этот файл
  // иногда ещё не успевает выполниться к этому моменту (та же природа, что и у
  // openModal/trackView), и кнопки связи молча не появляются до перезагрузки страницы.
  // buildContactHtml() ниже при необходимости пробует ещё раз, когда site.js подгрузится.
  // card:true — второстепенный, но тот же по размеру вариант кнопки (иконка + подпись
  // в одну строку), как у «В корзину»/«Скачать КП»; плавающая панель снизу (pvStickyContact)
  // наоборот нарочно компактная (только иконка) — ей всегда нужен card:false.
  const buildContactHtml = (card) => typeof contactActions === 'function'
    ? contactActions(state.settings.contacts, p.contact_primary, {
        text: `Здравствуйте! Интересует «${p.name}». ${location.origin}${productUrl(p)}`,
        productId: p.id,
        card: !!card
      })
    : null;
  const contactHtml = buildContactHtml(true) || '';
  const ytId = ytEmbed(p.youtube);
  // const ytBtn = p.youtube
  //   ? `<a class="pv-youtube" href="${p.youtube}" target="_blank" rel="noopener">Смотреть на YouTube <span class="yt-badge">▶</span></a>` : '';

  const favOn = favIds.includes(p.id);
  const favBtn = state.settings.favorites !== false
    ? `<button type="button" class="pv-mini-action pv-mini-fav${favOn ? ' on' : ''}" onclick="toggleFav(${p.id});renderPvFav(${p.id})" id="pvFavBtn">${PV_ICON_HEART}<span>${favOn ? 'В избранном' : 'В избранное'}</span></button>` : '';
  const cmpOn = compareIds.includes(p.id);
  const cmpBtn = state.settings.compare !== false
    ? `<label class="pv-mini-action pv-mini-compare${cmpOn ? ' on' : ''}"><input type="checkbox" hidden ${cmpOn ? 'checked' : ''} onchange="toggleCompare(${p.id});this.closest('.pv-mini-compare').classList.toggle('on',this.checked)">${PV_ICON_COMPARE}<span>Сравнить</span></label>` : '';

  const specsHtml = (specs && Object.keys(specs).length)
    ? `<div class="pv-specs"><table class="specs-table">${Object.entries(specs).map(([k, v]) => `<tr><td>${k}</td><td><strong>${v}</strong></td></tr>`).join('')}</table></div>` : '';

  // Короткая строка-"шапка" характеристик над табами — производительность (если есть)
  // плюс первые несколько пунктов из техпараметров, для беглого взгляда без клика в таб.
  const quickSpecs = [];
  if (p.perf) quickSpecs.push(['Производительность', `${p.perf} ${p.perf_unit || 'ед./час'}`]);
  if (specs) for (const [k, v] of Object.entries(specs)) { if (quickSpecs.length >= 6) break; quickSpecs.push([k, v]); }
  const quickSpecsHtml = quickSpecs.length
    ? `<div class="pv-quickspecs">${quickSpecs.map(([k, v]) => `<div class="qs-item"><div class="qs-val">${v}</div><div class="qs-label">${k}</div></div>`).join('')}</div>` : '';

  const block = (title, list) => (list && list.length)
    ? `<div class="pv-block"><h3>${title}</h3><div class="mini-row">${list.map(p2 => miniCard(p2, false, true)).join('')}</div></div>` : '';

  // Короткое описание в блоке покупки — первые ~180 символов обычного текста (без разметки,
  // seoClip сама снимает html-теги). Полное форматированное описание — отдельным табом ниже,
  // чтобы не растягивать блок с ценой/кнопками длинным текстом.
  const shortDesc = p.description ? seoClip(p.description, 180) : '';

  // Табы «Видео / Описание / Характеристики» — порядок и то, какие вкладки вообще
  // показывать, зависит от того, что реально заполнено у этого товара. Весь текст всех
  // вкладок остаётся в HTML всегда (просто скрыт display:none, не создаётся по клику) —
  // иначе Google не увидит текст непоказанных вкладок при индексации.
  const tabs = [];
  if (ytId) tabs.push({ key: 'video', label: 'Видео', html: `<div class="pv-video"><iframe src="https://www.youtube.com/embed/${ytId}" title="Видео-обзор" allowfullscreen loading="lazy"></iframe></div>` });
  if (p.description) tabs.push({ key: 'desc', label: 'Описание', html: `<div class="pv-desc">${p.description}</div>` });
  if (specsHtml) tabs.push({ key: 'specs', label: 'Характеристики', html: specsHtml });
  // Отзывы — всегда отдельным табом (даже без единого отзыва: там же форма «оставить
  // отзыв»). Число отзывов в подписи таба подставляется позже, когда придёт ответ
  // /api/products/:id/reviews (см. loadProductReviews) — синхронно его ещё не знаем.
  tabs.push({ key: 'reviews', label: 'Отзывы', html: `<div class="pv-reviews" id="pvReviews"></div>` });
  const tabsHtml = tabs.length ? `
    <div class="pv-tabs">
      <div class="pv-tabs-nav" role="tablist">
        ${tabs.map((t, i) => `<button type="button" class="pv-tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.key}" onclick="pvSwitchTab('${t.key}')" role="tab" aria-selected="${i === 0}">${t.label}</button>`).join('')}
      </div>
      ${tabs.map((t, i) => `<div class="pv-tab-panel" data-tab-panel="${t.key}"${i === 0 ? '' : ' style="display:none"'}>${t.html}</div>`).join('')}
    </div>` : '';

  document.getElementById('productViewBody').innerHTML = `
    <div class="pv-top">
      <div class="pv-gallery">${galleryHtml}</div>
      <div class="pv-info">
        <h1 class="pv-name">${p.name}</h1>
        <div class="pv-rating-inline" id="pvRatingInline" style="display:none"></div>
        ${p.subtitle ? `<div class="pv-subtitle">${p.subtitle}</div>` : (p.subtype ? `<div class="pv-subtitle">${p.subtype}</div>` : '')}
        ${shortDesc ? `<div class="pv-desc-short">${shortDesc}</div>` : ''}
        <div class="pv-meta">
          ${p.brand ? `<span>${p.brand}</span>` : ''}
          ${p.article ? `<span>Артикул: ${p.article}</span>` : ''}
        </div>
        <div class="pv-badges">
          ${p.perf ? `<span class="badge-feat"><img src="/assets/icons/icon-speed.png" alt=""> ${p.perf} ${p.perf_unit || 'ед./час'}</span>` : ''}
          <span class="badge-feat"><img src="/assets/icons/icon-guarantee2.png" alt=""> Гарантия качества</span>
        </div>
        ${priceHtml}
        <div class="pv-cta-grid">${buyBtn}${offerBtn}<span id="pvContactInline" style="display:contents">${contactHtml}</span></div>
        <div class="pv-mini-actions">${favBtn}${cmpBtn}</div>
      </div>
    </div>

    ${quickSpecsHtml}
    ${tabsHtml}
    ${block('Аксессуары и запчасти для этой модели', p.related)}
    ${block('С этим оборудованием берут', p.bundle)}
    ${block('Похожие модели', p.similar)}

    <a class="pv-back" href="/catalog/${p.category_slug}" onclick="showCatalog('${p.category_slug}');return false;">← Вернуться в каталог</a>`;

  // Те же кнопки связи, но продублированные в плавающую панель снизу (только мобильные,
  // см. CSS) — чтобы "Позвонить"/WhatsApp было видно сразу, не долистывая до текста.
  const stickyContact = document.getElementById('pvStickyContact');
  if (stickyContact) stickyContact.innerHTML = buildContactHtml(false) || '';

  // Если contactActions ещё не был готов, ИЛИ сами настройки (телефоны) ещё не успели
  // прийти с сервера (тоже бывает на медленном мобильном) — дозаполняем кнопки связи
  // без перезагрузки страницы. getSettings() при неудаче сам не запоминает провал
  // навсегда (см. site.js) — тут просто пробуем его снова, пока не получится.
  if (!contactHtml) {
    let tries = 0;
    const retry = () => {
      if (state.productId !== p.id) return;   // ушли на другой товар — не подставляем чужое
      const html = buildContactHtml(true);
      if (html) {
        const inlineEl = document.getElementById('pvContactInline');
        if (inlineEl) inlineEl.innerHTML = html;
        if (stickyContact) stickyContact.innerHTML = buildContactHtml(false) || '';
      } else if (++tries < 20) {
        if (typeof window.getSettings === 'function' && !(state.settings.contacts)) {
          window.getSettings().then(s => { state.settings = Object.assign({}, state.settings, s); }).catch(() => {});
        }
        setTimeout(retry, 250);
      }
    };
    setTimeout(retry, 250);
  }

  // scrollToView в начале функции целится по высоте ещё пустого спиннера — на
  // медленном интернете реальный (гораздо более высокий) контент товара вставляется
  // уже после того, как страница проскроллилась, и позиция уезжает. Прокручиваем
  // ещё раз, теперь уже по финальной вёрстке.
  if (typeof scrollToView === 'function') scrollToView('productView');
  // На телефоне переход часто случается прямо во время инерционной прокрутки (открыли
  // товар, пролистав до блока "Похожие модели", и тут же тапнули по карточке) — эта
  // инерция сама докручивает страницу уже ПОСЛЕ нашего сброса и перекрывает его.
  // Повторяем сброс чуть позже, когда инерция точно успеет погаситься.
  setTimeout(() => { if (state.productId === id && typeof scrollToView === 'function') scrollToView('productView'); }, 350);

  pushRecent(p.id);   // сама уже вызывает renderRecent() — второй раз звать не нужно
  loadProductReviews(p.id);
  window.trackView(productUrl(p), p.id);
}

// ---- отзывы на товар ----
function pvEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pvStars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
function pvReviewWord(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n100 >= 11 && n100 <= 14) return 'отзывов';
  if (n10 === 1) return 'отзыв';
  if (n10 >= 2 && n10 <= 4) return 'отзыва';
  return 'отзывов';
}
function pvReviewDate(s) {
  const d = new Date(String(s || '').replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function loadProductReviews(id) {
  const wrap = document.getElementById('pvReviews');
  if (!wrap) return;
  let data = { rows: [], count: 0, avg: 0 };
  try { data = await apiFetch(`/api/products/${id}/reviews`); }
  catch (e) { if (window.logClientError) window.logClientError('Не удалось загрузить отзывы товара #' + id + ': ' + (e && (e.message || e)), 'loadProductReviews'); }
  const rows = data.rows || [];

  // Рейтинг рядом с названием товара (как на карточке) — заполняется сюда же, отдельного
  // запроса не делаем, данные те же, что и для таба «Отзывы» внизу.
  const ratingInline = document.getElementById('pvRatingInline');
  if (ratingInline && rows.length) {
    ratingInline.innerHTML = `<span class="stars">${pvStars(Math.round(data.avg))}</span> <b>${data.avg}</b> <a href="#" onclick="pvSwitchTab('reviews');document.querySelector('.pv-tabs').scrollIntoView({block:'start'});return false;">(${rows.length} ${pvReviewWord(rows.length)})</a>`;
    ratingInline.style.display = '';
  }
  // Число отзывов в подпись таба — синхронно при первой отрисовке его ещё не знали.
  const reviewsTabBtn = document.querySelector('.pv-tab-btn[data-tab="reviews"]');
  if (reviewsTabBtn && rows.length) reviewsTabBtn.textContent = `Отзывы (${rows.length})`;

  const summaryHtml = rows.length
    ? `<div class="pv-rating-summary">
         <span class="stars" aria-label="${data.avg} из 5">${pvStars(Math.round(data.avg))}</span>
         <span class="pv-rating-count">${data.avg} · ${rows.length} ${pvReviewWord(rows.length)}</span>
       </div>`
    : '';
  const listHtml = rows.length
    ? `<div class="pv-review-list">${rows.map(r => `
        <article class="review-card">
          <div class="stars" aria-label="${r.rating} из 5">${pvStars(r.rating)}</div>
          ${r.text ? `<p>${pvEsc(r.text)}</p>` : ''}
          <div class="review-author">${pvEsc(r.name)} <span class="pv-review-date">· ${pvReviewDate(r.created_at)}</span></div>
          ${r.reply ? `<div class="review-reply"><b>Ответ SIGMA MARKET:</b> ${pvEsc(r.reply)}</div>` : ''}
        </article>`).join('')}</div>`
    : `<p class="pv-review-empty">Отзывов пока нет — будьте первым!</p>`;

  wrap.innerHTML = `
    <h3>Отзывы</h3>
    ${summaryHtml}
    ${listHtml}
    <div class="review-form pv-review-form">
      <h4>Оставить отзыв</h4>
      <input type="text" id="rvpName" placeholder="Ваше имя *">
      <label class="stars-input-label">Ваша оценка *</label>
      <div class="stars-input" id="rvpStars" data-rating="0" onmouseleave="pvHoverStars(this,0)">
        ${[1, 2, 3, 4, 5].map(v => `<span class="si-star" data-v="${v}" onclick="pvSetStars(this)" onmouseenter="pvHoverStars(this.closest('.stars-input'),${v})">★</span>`).join('')}
      </div>
      <textarea id="rvpText" placeholder="Ваш отзыв (необязательно)"></textarea>
      <button type="button" class="btn-primary" onclick="submitProductReview(${id})">Оставить отзыв</button>
    </div>`;
}

// Подсветка звёзд при наведении (до клика) — иначе непонятно, что по ним можно кликать.
function pvHoverStars(wrap, hoverV) {
  if (!wrap) return;
  const actual = Number(wrap.dataset.rating || 0);
  const v = hoverV || actual;
  wrap.querySelectorAll('.si-star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= v));
}

function pvSetStars(el) {
  const wrap = el.closest('.stars-input');
  if (!wrap) return;
  const v = Number(el.dataset.v);
  wrap.dataset.rating = v;
  wrap.querySelectorAll('.si-star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= v));
}

async function submitProductReview(productId) {
  const nameEl = document.getElementById('rvpName');
  const starsEl = document.getElementById('rvpStars');
  const textEl = document.getElementById('rvpText');
  if (!nameEl || !starsEl || !textEl) { window.showToast('⚠️ Обновите страницу и попробуйте ещё раз'); return; }
  const name = nameEl.value.trim();
  const rating = Number(starsEl.dataset.rating || 0);
  if (!name || !rating) { window.showToast('⚠️ Укажите имя и оценку'); return; }
  try {
    const res = await apiFetch(`/api/products/${productId}/reviews`, 'POST', {
      name, rating, text: textEl.value.trim()
    });
    if (res && res.success) {
      window.showToast('✅ Спасибо! Отзыв отправлен на модерацию.', 'green');
      nameEl.value = ''; textEl.value = '';
      starsEl.dataset.rating = 0;
      starsEl.querySelectorAll('.si-star').forEach(s => s.classList.remove('on'));
    } else {
      window.showToast('❌ ' + (res && res.error || 'Ошибка. Попробуйте ещё раз.'));
    }
  } catch (e) { window.logClientError(e && (e.message || e), 'submitProductReview'); window.showToast('❌ Ошибка. Попробуйте ещё раз.'); }
}

function pvSwitchTab(key) {
  const wrap = document.getElementById('productViewBody');
  if (!wrap) return;
  wrap.querySelectorAll('.pv-tab-btn').forEach(b => {
    const on = b.dataset.tab === key;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  wrap.querySelectorAll('.pv-tab-panel').forEach(p => { p.style.display = (p.dataset.tabPanel === key) ? '' : 'none'; });
}

// алиас для существующих вызовов openModal(...)
function openModal(id) { showProduct(id); }
function closeModal() { if (state.view === 'product') showCatalog(state.category || 'all'); }

function renderPvFav(id) {
  const b = document.getElementById('pvFavBtn');
  if (!b) return;
  const on = favIds.includes(id);
  b.classList.toggle('on', on);
  const label = b.querySelector('.pv-cta-label');
  if (label) label.textContent = on ? 'В избранном' : 'В избранное';
}

// мини-карточка товара (блоки «похожие», «недавние», результаты квиза) — isFirst
// снимает "ленивую" загрузку с первой карточки списка (в результатах квиза это
// обычно и есть LCP-элемент экрана, см. quizResultCardHtml).
function miniCard(p, isFirst, withBuyBtn) {
  const img = p.icon
    ? (isFirst
        ? `<img src="${thumbIconUrl(p.icon)}" alt="${p.name}" fetchpriority="high" onerror="this.onerror=function(){this.style.display='none'};this.src='/icons/${p.icon}'">`
        : `<img src="${thumbIconUrl(p.icon)}" alt="${p.name}" loading="lazy" onerror="this.onerror=function(){this.style.display='none'};this.src='/icons/${p.icon}'">`)
    : `<span>${getCatEmoji(p.category_slug)}</span>`;
  const price = p.price_on_request ? 'По запросу' : (p.price ? formatPrice(p.price) : '—');
  const badgesHtml = window.featuredBadgesHtml ? window.featuredBadgesHtml(p) : '';
  const buyHtml = withBuyBtn
    ? (p.price_on_request
        ? `<button type="button" class="mini-buy-btn" onclick="event.preventDefault();event.stopPropagation();requestModal(${p.id})">Запросить цену</button>`
        : `<button type="button" class="mini-buy-btn" onclick="event.preventDefault();event.stopPropagation();buyNow(${p.id})">В корзину</button>`)
    : '';
  return `<a class="mini-card" href="${productUrl(p)}" onclick="showProduct(${p.id});return false;">
    <div class="mini-img">${badgesHtml}${img}</div>
    <div class="mini-name">${p.name}</div>
    <div class="mini-price">${price}</div>
    ${buyHtml}
  </a>`;
}

// ===== СКАЧАТЬ КП (мгновенно, по номеру телефона — включается в админке) =====
let kpProductId = null;
function openKpModal(id) {
  window.trackClick('offer', id);
  kpProductId = id;
  document.getElementById('kpPhone').value = '';
  document.getElementById('kpPhone').dataset.phoneDigits = '';
  const websiteEl = document.getElementById('kpWebsite');
  if (websiteEl) websiteEl.value = '';
  document.getElementById('kpOverlay').classList.add('open');
}
function closeKpModal() { document.getElementById('kpOverlay').classList.remove('open'); }
async function kpDownload() {
  const phone = document.getElementById('kpPhone').value.trim();
  if (!window.isValidPhone(phone)) { showToast('⚠️ Введите корректный номер телефона'); return; }
  try {
    const websiteEl = document.getElementById('kpWebsite');
    const r = await fetch('/api/kp/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, productId: kpProductId, website: websiteEl ? websiteEl.value : '' }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => null);
      if (r.status >= 500) window.logClientError('kp/download ' + r.status + ': ' + ((data && data.error) || ''), 'kpDownload');
      showToast('❌ ' + ((data && data.error) || 'Ошибка. Попробуйте ещё раз.'));
      return;
    }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = m ? decodeURIComponent(m[1]) : 'KP.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
    closeKpModal();
    showToast('✅ КП скачивается', 'green');
  } catch (e) {
    window.logClientError(e && (e.message || e), 'kpDownload');
    showToast('❌ Ошибка сети. Попробуйте ещё раз.');
  }
}

function buyNow(id) {
  if (typeof addToCart === 'function') addToCart(id);
  document.getElementById('addedCartOverlay').classList.add('open');
}
function closeAddedCart() { document.getElementById('addedCartOverlay').classList.remove('open'); }
function goToCheckout() {
  closeAddedCart();
  if (!document.getElementById('cartPanel').classList.contains('open')) toggleCart();
}

function requestModal(id) {
  window.trackClick('offer', id);
  // Кладём товар в корзину по-настоящему (не только текстом в сообщении) — так видно,
  // на что именно запрашивают КП. После успешной отправки заявки корзина и так
  // очищается целиком (см. submitOrder), отдельно убирать не нужно.
  if (typeof addToCart === 'function') addToCart(id);
  if (!document.getElementById('cartPanel').classList.contains('open')) toggleCart();
  const url = location.origin + '/product/' + id;
  document.getElementById('oMessage').value = `Прошу предоставить коммерческое предложение на товар #${id}\n${url}`;
}

// ===== СТАТЬИ (список + страница статьи) =====
function articleUrl(a) { return '/articles/' + a.slug; }
function articleDate(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function articleCardHtml(a) {
  const img = a.cover
    ? `<img src="${thumbIconUrl(a.cover)}" alt="${a.title}" loading="lazy" onerror="this.onerror=function(){this.style.display='none'};this.src='/icons/${a.cover}'">`
    : `<span class="article-card-emoji">📄</span>`;
  return `<a class="article-card" href="${articleUrl(a)}" onclick="showArticle('${a.slug}');return false;">
    <div class="article-card-cover">${img}</div>
    <div class="article-card-body">
      <div class="article-card-date">${articleDate(a.created_at)}</div>
      <h3 class="article-card-title">${a.title}</h3>
      ${a.excerpt ? `<p class="article-card-excerpt">${a.excerpt}</p>` : ''}
    </div>
  </a>`;
}

async function showArticles() {
  state.view = 'articles';
  await setView('articles');
  setActiveNav('articles');
  setUrl('/articles');
  setMeta('Статьи и обзоры оборудования — SIGMA MARKET',
    'Статьи и обзоры о выборе профессионального оборудования для автомоек, СТО и клининга.', '/articles');
  scrollToView('articlesView');
  window.trackView('/articles');

  const grid = document.getElementById('articlesGrid');
  // Сервер уже мог отрисовать этот же список в HTML — не стираем его спиннером до
  // ответа fetch (та же логика, что в showProduct), но подгружаем свежие данные всё
  // равно каждый раз (мало ли Мира только что опубликовала новую статью).
  if (grid && !grid.dataset.filled) {
    grid.innerHTML = '<div class="spinner"><div class="spin"></div>&nbsp; Загрузка…</div>';
  }
  let data;
  try { data = await apiFetch('/api/articles?limit=60'); }
  catch (e) {
    if (window.logClientError) window.logClientError('Не удалось загрузить статьи: ' + (e && (e.message || e)), 'showArticles');
    if (grid && !grid.dataset.filled) grid.innerHTML = '<div class="spinner">Не удалось загрузить статьи — проверьте интернет.</div>';
    return;
  }
  const rows = (data && data.rows) || [];
  if (grid) {
    grid.innerHTML = rows.length ? rows.map(articleCardHtml).join('') : '<p class="articles-empty">Пока нет статей.</p>';
    grid.dataset.filled = '1';
  }
}

async function showArticle(slug) {
  state.view = 'article';
  setUrl('/articles/' + slug);
  await setView('article');
  setActiveNav('articles');
  const body = document.getElementById('articleViewBody');
  if (!body) { location.href = '/articles/' + slug; return; }
  // Сервер уже мог отрисовать эту же статью сразу в HTML (см. seo.articleViewHtml) —
  // не стираем готовый контент спиннером до ответа fetch (та же логика, что в showProduct).
  if (body.dataset.articleSlug !== String(slug)) {
    body.innerHTML = '<div class="spinner"><div class="spin"></div>&nbsp; Загрузка…</div>';
  }
  scrollToView('articleView');

  let a;
  try { a = await apiFetch(`/api/articles/${slug}`); }
  catch (e) {
    if (window.logClientError) window.logClientError('Не удалось загрузить статью «' + slug + '»: ' + (e && (e.message || e)), 'showArticle');
    if (state.view === 'article' && body.dataset.articleSlug !== String(slug)) {
      body.innerHTML = `<div class="spinner">Не удалось загрузить статью — проверьте интернет.
        <button type="button" class="btn-catalog" onclick="showArticle('${slug}')" style="margin-top:12px">Повторить</button></div>`;
    }
    return;
  }
  if (!a || a.error) { if (typeof showNotFound === 'function') showNotFound(); return; }
  body.dataset.articleSlug = String(a.slug);

  if (typeof setMeta === 'function') {
    const m = a.seo || {};
    setMeta(m.title || (a.title + ' — SIGMA MARKET'), m.description || '', articleUrl(a));
  }
  const crumbEl = document.getElementById('articleCrumb');
  if (crumbEl) crumbEl.innerHTML =
    `<a href="/articles" onclick="showArticles();return false;">Статьи</a> <span class="crumb-sep">›</span> <span class="crumb-current">${a.title}</span>`;

  const coverHtml = a.cover ? `<div class="article-cover"><img src="/icons/${a.cover}" alt="${a.title}" fetchpriority="high"></div>` : '';
  body.innerHTML = `
    <h1 class="article-title">${a.title}</h1>
    <div class="article-meta">${articleDate(a.created_at)}</div>
    ${coverHtml}
    <div class="article-body catalog-about-text">${a.content || ''}</div>
    <a class="pv-back" href="/articles" onclick="showArticles();return false;">← Все статьи</a>`;

  window.trackView(articleUrl(a));
}
