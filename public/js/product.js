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
  setView('product');
  setActiveNav('catalog');
  document.getElementById('productViewBody').innerHTML = '<div class="spinner"><div class="spin"></div>&nbsp; Загрузка…</div>';
  scrollToView('productView');

  const p = await apiFetch(`/api/products/${id}`);
  if (!p || p.error) { document.getElementById('productViewBody').innerHTML = '<div class="spinner">Товар не найден</div>'; return; }

  // SEO: обновить title/description/canonical под товар
  if (typeof setMeta === 'function') {
    const brand = p.brand ? p.brand + ' ' : '';
    setMeta(
      p.seo_title ? seoClip(p.seo_title, 70) : seoClip(p.name + ' — ' + brand + '| SIGMA MARKET', 65),
      seoClip(p.seo_description || p.description || p.subtitle || (p.name + '. Профессиональное оборудование от SIGMA MARKET. Поставка по Казахстану.'), 175),
      productUrl(p)
    );
  }
  replaceUrl(productUrl(p));   // уточняем адрес слагом (без новой записи в истории)
  let specs = p.specs;
  if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch { specs = {}; } }

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

  const priceHtml = p.price_on_request
    ? `<div class="pv-price-req">Цена по запросу — итоговая стоимость зависит от комплектации</div>`
    : p.price ? `<div class="pv-price">${formatPrice(p.price)}</div>` : '';

  const offerBtn = `<button class="btn-consult-outline" onclick="requestModal(${p.id})">Запросить коммерческое предложение</button>`;
  const buyBtn = p.price_on_request ? '' : `<button class="btn-catalog" onclick="addToCart(${p.id})">🛒 Купить</button>`;
  const ytId = ytEmbed(p.youtube);
  const ytBtn = p.youtube
    ? `<a class="pv-youtube" href="${p.youtube}" target="_blank" rel="noopener">Смотреть на YouTube <span class="yt-badge">▶</span></a>` : '';

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
        ${ytBtn}
        ${favBtn}
      </div>
    </div>

    ${ytId ? `<div class="pv-video"><iframe src="https://www.youtube.com/embed/${ytId}" title="Видео-обзор" allowfullscreen loading="lazy"></iframe></div>` : ''}
    ${specsHtml}
    ${block('Аксессуары и запчасти для этой модели', p.related)}
    ${block('С этим оборудованием берут', p.bundle)}
    ${block('Похожие модели', p.similar)}

    <a class="pv-back" href="/catalog/${p.category_slug}" onclick="showCatalog('${p.category_slug}');return false;">← Вернуться в каталог</a>`;

  // Показать кнопку «Далее» только если описание реально не помещается
  requestAnimationFrame(() => {
    const d = document.getElementById('pvDesc');
    const b = document.getElementById('pvDescMore');
    if (d && b && d.scrollHeight - d.clientHeight > 4) b.hidden = false;
  });

  pushRecent(p.id);
  renderRecent();
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

function requestModal(id) {
  if (!document.getElementById('cartPanel').classList.contains('open')) toggleCart();
  document.getElementById('oMessage').value = `Прошу предоставить коммерческое предложение на товар #${id}`;
}
