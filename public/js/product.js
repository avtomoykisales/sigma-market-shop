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

async function showProduct(id) {
  state.view = 'product';
  state.productId = id;
  setUrl('/product/' + id);
  await setView('product');
  setActiveNav('catalog');
  const body = document.getElementById('productViewBody');
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
  const galleryHtml = pvGallery.length
    ? `<div class="pv-img">
         <img id="pvMainImg" src="/icons/${pvGallery[0]}" alt="${p.name}" onerror="this.style.visibility='hidden'">
         ${pvGallery.length > 1 ? `
           <button class="pv-nav prev" type="button" onclick="pvNav(-1)">‹</button>
           <button class="pv-nav next" type="button" onclick="pvNav(1)">›</button>` : ''}
       </div>
       ${pvGallery.length > 1 ? `<div class="pv-thumbs" id="pvThumbs">
         ${pvGallery.map((fn, i) => `<button class="pv-thumb${i === 0 ? ' active' : ''}" type="button" onclick="pvSetImg(${i})"><img src="/icons/${fn}" alt="" onerror="this.style.opacity=.2"></button>`).join('')}
       </div>` : ''}`
    : `<div class="pv-img"><span style="font-size:90px">${getCatEmoji(p.category_slug)}</span></div>`;

  const pvBonus = window.bonusForPrice(p.price);
  const priceHtml = p.price_on_request
    ? `<div class="pv-price-req">Цена по запросу — итоговая стоимость зависит от комплектации</div>`
    : p.price ? `<div class="pv-price">${formatPrice(p.price)}</div>${pvBonus ? `<div class="pv-bonus">+${pvBonus.toLocaleString('ru-KZ')} ₸ бонусов на счёт</div>` : ''}` : '';

  const kpInstant = typeof state !== 'undefined' && state.settings && state.settings.kp && state.settings.kp.instantDownload;
  const offerBtn = kpInstant
    ? `<button class="btn-consult-outline" onclick="openKpModal(${p.id})">Скачать КП</button>`
    : `<button class="btn-consult-outline" onclick="requestModal(${p.id})">Запросить коммерческое предложение</button>`;
  const buyBtn = p.price_on_request ? '' : `<button class="btn-catalog" onclick="addToCart(${p.id})">🛒 Купить</button>`;
  // contactActions живёт в /js/site.js — на медленном мобильном интернете этот файл
  // иногда ещё не успевает выполниться к этому моменту (та же природа, что и у
  // openModal/trackView), и кнопки связи молча не появляются до перезагрузки страницы.
  // buildContactHtml() ниже при необходимости пробует ещё раз, когда site.js подгрузится.
  const buildContactHtml = () => typeof contactActions === 'function'
    ? contactActions(state.settings.contacts, p.contact_primary, {
        text: `Здравствуйте! Интересует «${p.name}». ${location.origin}${productUrl(p)}`,
        productId: p.id
      })
    : null;
  const contactHtml = buildContactHtml() || '';
  const ytId = ytEmbed(p.youtube);
  // const ytBtn = p.youtube
  //   ? `<a class="pv-youtube" href="${p.youtube}" target="_blank" rel="noopener">Смотреть на YouTube <span class="yt-badge">▶</span></a>` : '';

  const favOn = favIds.includes(p.id);
  const favBtn = state.settings.favorites !== false
    ? `<button class="pv-fav${favOn ? ' on' : ''}" onclick="toggleFav(${p.id});renderPvFav(${p.id})" id="pvFavBtn">${favOn ? '♥ В избранном' : '♡ В избранное'}</button>` : '';

  const specsHtml = (specs && Object.keys(specs).length)
    ? `<div class="pv-specs"><h3>Технические параметры</h3>
        <table class="specs-table">${Object.entries(specs).map(([k, v]) => `<tr><td>${k}</td><td><strong>${v}</strong></td></tr>`).join('')}</table></div>` : '';

  const block = (title, list) => (list && list.length)
    ? `<div class="pv-block"><h3>${title}</h3><div class="mini-row">${list.map(miniCard).join('')}</div></div>` : '';

  document.getElementById('productViewBody').innerHTML = `
    <div class="pv-top">
      <div class="pv-gallery">${galleryHtml}</div>
      <div class="pv-info">
        <h1 class="pv-name">${p.name}</h1>
        ${p.subtitle ? `<div class="pv-subtitle">${p.subtitle}</div>` : (p.subtype ? `<div class="pv-subtitle">${p.subtype}</div>` : '')}
        ${p.description ? `<div class="pv-desc-wrap">
          <p class="pv-desc pv-clamp" id="pvDesc">${p.description}</p>
          <button type="button" class="pv-desc-more" id="pvDescMore" onclick="togglePvDesc()" hidden>Далее ▾</button>
        </div>` : ''}
        <div class="pv-meta">
          ${p.brand ? `<span>${p.brand}</span>` : ''}
          ${p.article ? `<span>Артикул: ${p.article}</span>` : ''}
        </div>
        <div class="pv-badges">
          ${p.perf ? `<span class="badge-feat"><img src="/assets/icons/icon-speed.png" alt=""> ${p.perf} ${p.perf_unit || 'ед./час'}</span>` : ''}
          <span class="badge-feat"><img src="/assets/icons/icon-guarantee2.png" alt=""> Гарантия качества</span>
        </div>
        ${priceHtml}
        <div class="pv-actions">${offerBtn}${buyBtn}</div>
        <div id="pvContactInline">${contactHtml}</div>
        ${favBtn}
      </div>
    </div>

    ${ytId ? `<div class="pv-video"><iframe src="https://www.youtube.com/embed/${ytId}" title="Видео-обзор" allowfullscreen loading="lazy"></iframe></div>` : ''}
    ${specsHtml}
    ${block('Аксессуары и запчасти для этой модели', p.related)}
    ${block('С этим оборудованием берут', p.bundle)}
    ${block('Похожие модели', p.similar)}

    <div class="pv-reviews" id="pvReviews"></div>

    <a class="pv-back" href="/catalog/${p.category_slug}" onclick="showCatalog('${p.category_slug}');return false;">← Вернуться в каталог</a>`;

  // Те же кнопки связи, но продублированные в плавающую панель снизу (только мобильные,
  // см. CSS) — чтобы "Позвонить"/WhatsApp было видно сразу, не долистывая до текста.
  const stickyContact = document.getElementById('pvStickyContact');
  if (stickyContact) stickyContact.innerHTML = contactHtml;

  // Если contactActions ещё не был готов, ИЛИ сами настройки (телефоны) ещё не успели
  // прийти с сервера (тоже бывает на медленном мобильном) — дозаполняем кнопки связи
  // без перезагрузки страницы. getSettings() при неудаче сам не запоминает провал
  // навсегда (см. site.js) — тут просто пробуем его снова, пока не получится.
  if (!contactHtml) {
    let tries = 0;
    const retry = () => {
      if (state.productId !== p.id) return;   // ушли на другой товар — не подставляем чужое
      const html = buildContactHtml();
      if (html) {
        const inlineEl = document.getElementById('pvContactInline');
        if (inlineEl) inlineEl.innerHTML = html;
        if (stickyContact) stickyContact.innerHTML = html;
      } else if (++tries < 20) {
        if (typeof window.getSettings === 'function' && !(state.settings.contacts)) {
          window.getSettings().then(s => { state.settings = { ...state.settings, ...s }; }).catch(() => {});
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

  // Показать кнопку «Далее» только если описание реально не помещается
  requestAnimationFrame(() => {
    const d = document.getElementById('pvDesc');
    const b = document.getElementById('pvDescMore');
    if (d && b && d.scrollHeight - d.clientHeight > 4) b.hidden = false;
  });

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
  try { data = await apiFetch(`/api/products/${id}/reviews`); } catch (e) {}
  const rows = data.rows || [];

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
  const actual = Number(wrap.dataset.rating || 0);
  const v = hoverV || actual;
  wrap.querySelectorAll('.si-star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= v));
}

function pvSetStars(el) {
  const wrap = el.closest('.stars-input');
  const v = Number(el.dataset.v);
  wrap.dataset.rating = v;
  wrap.querySelectorAll('.si-star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= v));
}

async function submitProductReview(productId) {
  const nameEl = document.getElementById('rvpName');
  const starsEl = document.getElementById('rvpStars');
  const textEl = document.getElementById('rvpText');
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

function togglePvDesc() {
  const d = document.getElementById('pvDesc');
  const b = document.getElementById('pvDescMore');
  if (!d || !b) return;
  const collapsed = d.classList.toggle('pv-clamp');
  b.textContent = collapsed ? 'Далее ▾' : 'Свернуть ▴';
}

// алиас для существующих вызовов openModal(...)
function openModal(id) { showProduct(id); }
function closeModal() { if (state.view === 'product') showCatalog(state.category || 'all'); }

function renderPvFav(id) {
  const b = document.getElementById('pvFavBtn');
  if (!b) return;
  const on = favIds.includes(id);
  b.classList.toggle('on', on);
  b.textContent = on ? '♥ В избранном' : '♡ В избранное';
}

// мини-карточка товара (блоки «похожие», «недавние», результаты квиза)
function miniCard(p) {
  const img = p.icon
    ? `<img src="/icons/${p.icon}" alt="${p.name}" loading="lazy" onerror="this.style.display='none'">`
    : `<span>${getCatEmoji(p.category_slug)}</span>`;
  const price = p.price_on_request ? 'По запросу' : (p.price ? formatPrice(p.price) : '—');
  return `<a class="mini-card" href="${productUrl(p)}" onclick="showProduct(${p.id});return false;">
    <div class="mini-img">${img}</div>
    <div class="mini-name">${p.name}</div>
    <div class="mini-price">${price}</div>
  </a>`;
}

// ===== СКАЧАТЬ КП (мгновенно, по номеру телефона — включается в админке) =====
let kpProductId = null;
function openKpModal(id) {
  window.trackClick('offer', id);
  kpProductId = id;
  document.getElementById('kpPhone').value = '';
  document.getElementById('kpPhone').dataset.phoneDigits = '';
  document.getElementById('kpOverlay').classList.add('open');
}
function closeKpModal() { document.getElementById('kpOverlay').classList.remove('open'); }
async function kpDownload() {
  const phone = document.getElementById('kpPhone').value.trim();
  if (!window.isValidPhone(phone)) { showToast('⚠️ Введите корректный номер телефона'); return; }
  const r = await fetch('/api/kp/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, productId: kpProductId }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => null);
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
