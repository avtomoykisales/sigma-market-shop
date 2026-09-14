/* ============================================================
   SIGMA MARKET — общий скрипт (header, footer, drawer, формы)
   Подключается на всех страницах. На index.html поверх него
   работает основной SPA-скрипт каталога/корзины.
   ============================================================ */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- МОБИЛЬНОЕ МЕНЮ ---------- */
  window.openDrawer = function () {
    if ($('drawer')) $('drawer').classList.add('open');
    if ($('drawerOverlay')) $('drawerOverlay').classList.add('open');
    if ($('hdrBurger')) $('hdrBurger').classList.add('active');
    document.body.style.overflow = 'hidden';
  };
  window.closeDrawer = function () {
    if ($('drawer')) $('drawer').classList.remove('open');
    if ($('drawerOverlay')) $('drawerOverlay').classList.remove('open');
    if ($('hdrBurger')) $('hdrBurger').classList.remove('active');
    document.body.style.overflow = '';
  };
  window.toggleDrawer = function () {
    if ($('drawer') && $('drawer').classList.contains('open')) window.closeDrawer();
    else window.openDrawer();
  };

  /* ---------- ПОИСК ---------- */
  window.toggleSearch = function () {
    var d = $('searchDropdown');
    if (!d) return;
    var show = !d.style.display || d.style.display === 'none';
    d.style.display = show ? 'block' : 'none';
    if (show && $('searchInput')) $('searchInput').focus();
  };

  /* ---------- КОРЗИНА (счётчик на всех страницах) ---------- */
  function cartCount() {
    try {
      return JSON.parse(localStorage.getItem('cart') || '[]')
        .reduce(function (s, i) { return s + (i.qty || 1); }, 0);
    } catch (e) { return 0; }
  }
  window.updateCartBadge = function () {
    var el = $('cartCount');
    if (el) el.textContent = cartCount();
  };
  window.handleCart = function () {
    if (typeof window.toggleCart === 'function' && $('cartPanel')) window.toggleCart();
    else window.location.href = '/#cart';
  };

  /* ---------- АКТИВНЫЙ ПУНКТ МЕНЮ ---------- */
  function markActiveNav() {
    var path = window.location.pathname.replace(/index\.html$/, '') || '/';
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var t = a.getAttribute('data-nav');
      var on = (t === 'home' && path === '/') ||
               (t !== 'home' && (path === '/' + t || path.indexOf('/' + t) === 0));
      a.classList.toggle('active', on);
    });
  }

  /* ---------- ТОСТ ---------- */
  window.showToast = function (msg, type) {
    var t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(function () { t.className = 'toast'; }, 3000);
  };

  /* ---------- API ---------- */
  window.apiFetch = async function (url, method, body) {
    var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch(url, opts);
    return r.json();
  };
  window.formatPrice = function (n) {
    if (!n) return '0 ₸';
    return Number(n).toLocaleString('ru-KZ', { maximumFractionDigits: 0 }) + ' ₸';
  };

  /* ---------- КОНТАКТЫ: WhatsApp + звонок ---------- */
  // Цифры номера в международном формате для wa.me / tel: ("8 (707)…" -> "7707…")
  window.waDigits = function (raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
    return d;
  };
  var WA_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-1.7-.9-2.9-1.6-4-3.6-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.3 5.2 4.6 2 .8 2.7.9 3.7.8.6-.1 1.7-.7 2-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2z"/></svg>';
  var CALL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M6.6 10.8a15.9 15.9 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .5 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.5-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.3 1l-2.2 2.3z"/></svg>';
  var attr = function (s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); };

  // contacts = { phone1, phone2 } из настроек; primary = '1' | '2' | '' (какой номер первым).
  // opts.text — предзаполненное сообщение для WhatsApp; opts.compact — версия для карточки.
  // Один номер → кнопки ведут сразу. Два → клик открывает маленькое окно выбора номера.
  window.contactActions = function (contacts, primary, opts) {
    contacts = contacts || {};
    opts = opts || {};
    var nums = [contacts.phone1, contacts.phone2]
      .map(function (raw) { return { raw: (raw || '').trim(), wa: window.waDigits(raw) }; })
      .filter(function (c) { return c.wa.length >= 10; });
    if (!nums.length) return '';
    if (String(primary) === '2' && nums.length > 1) nums.reverse();

    var q = opts.text ? '?text=' + encodeURIComponent(opts.text) : '';
    var wa, call;

    if (nums.length > 1) {
      var data = attr(JSON.stringify(nums));
      wa = '<button type="button" class="btn-wa" data-ck="wa" data-q="' + attr(q) + '" data-nums="' + data + '" ' +
        'onclick="event.stopPropagation();contactPick(this)" aria-label="Написать в WhatsApp">' + WA_SVG + '<span>WhatsApp</span></button>';
      call = '<button type="button" class="btn-call" data-ck="call" data-nums="' + data + '" ' +
        'onclick="event.stopPropagation();contactPick(this)" aria-label="Позвонить">' + CALL_SVG + '<span>Позвонить</span></button>';
    } else {
      var c = nums[0], tel = '+' + c.wa;
      wa = '<a class="btn-wa" href="https://wa.me/' + c.wa + q + '" target="_blank" rel="noopener" ' +
        'onclick="event.stopPropagation()" aria-label="Написать в WhatsApp ' + tel + '">' + WA_SVG + '<span>WhatsApp</span></a>';
      call = '<a class="btn-call" href="tel:' + tel + '" onclick="event.stopPropagation()" aria-label="Позвонить ' + tel + '">' +
        CALL_SVG + '<span>Позвонить</span></a>';
    }
    return '<div class="contact-actions' + (opts.compact ? ' contact-actions--compact' : '') + '">' +
      '<div class="contact-row">' + wa + call + '</div></div>';
  };

  // Маленькое окно выбора номера (когда номеров два)
  window.contactPick = function (el) {
    var kind = el.getAttribute('data-ck');
    var q = el.getAttribute('data-q') || '';
    var nums;
    try { nums = JSON.parse(el.getAttribute('data-nums') || '[]'); } catch (e) { nums = []; }
    if (!nums.length) return;

    var ov = document.getElementById('cpickOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'cpickOverlay';
      ov.className = 'cpick-overlay';
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('open'); });
      document.body.appendChild(ov);
    }
    var close = "document.getElementById('cpickOverlay').classList.remove('open')";
    var rows = nums.map(function (c) {
      var href = kind === 'wa' ? 'https://wa.me/' + c.wa + q : 'tel:+' + c.wa;
      var tgt = kind === 'wa' ? ' target="_blank" rel="noopener"' : '';
      return '<a class="cpick-num" href="' + href + '"' + tgt + ' onclick="' + close + '">' +
        (kind === 'wa' ? WA_SVG : CALL_SVG) + '<span>' + (c.raw || ('+' + c.wa)) + '</span></a>';
    }).join('');
    ov.innerHTML = '<div class="cpick">' +
      '<div class="cpick-head">' + (kind === 'wa' ? 'Написать в WhatsApp' : 'Позвонить') + '</div>' +
      rows +
      '<button type="button" class="cpick-cancel" onclick="' + close + '">Отмена</button>' +
      '</div>';
    ov.classList.add('open');
  };

  /* ---------- ФОРМА КОНСУЛЬТАЦИИ ---------- */
  window.scrollToConsult = function () {
    var s = $('consultSection');
    if (s) s.scrollIntoView({ behavior: 'smooth' });
    else window.location.href = '/#consult';
  };
  window.submitConsult = async function () {
    var name = $('cName') && $('cName').value.trim();
    var phone = $('cPhone') && $('cPhone').value.trim();
    if (!name || !phone) { window.showToast('⚠️ Укажите имя и телефон'); return; }
    try {
      var res = await window.apiFetch('/api/orders', 'POST', {
        name: name,
        phone: phone,
        email: ($('cEmail') && $('cEmail').value.trim()) || '',
        city: ($('cCity') && $('cCity').value.trim()) || '',
        message: 'Запрос консультации — ' + document.title,
        items: '[]'
      });
      if (res && res.success) {
        window.showToast('✅ Заявка принята! Мы свяжемся с вами.', 'green');
        ['cName', 'cPhone', 'cCity', 'cEmail'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      }
    } catch (e) { window.showToast('❌ Ошибка. Попробуйте ещё раз.'); }
  };

  /* ---------- ГЕРОЙ-СЛАЙДЕР ---------- */
  // Кнопка слайда: если открыт SPA каталога (index) — переключаем вид без перезагрузки,
  // иначе даём ссылке отработать обычным переходом на "/?category=...".
  window.heroGo = function (cat, sub) {
    if (typeof window.showCatalog === 'function') {
      var subs = sub ? String(sub).split(',').filter(Boolean) : [];
      window.showCatalog(cat, subs);
      return false;
    }
    return true;
  };

  function initHeroSlider() {
    var section = document.getElementById('heroSlider');
    if (!section) return;
    var slides = [].slice.call(section.querySelectorAll('.hero-slide-img'));
    var dotsWrap = document.getElementById('heroDots');
    if (slides.length < 2) { if (dotsWrap) dotsWrap.style.display = 'none'; return; }

    var idx = 0, timer = null;
    function render() {
      slides.forEach(function (s, i) { s.classList.toggle('is-active', i === idx); });
      if (dotsWrap) [].forEach.call(dotsWrap.children, function (d, i) {
        d.classList.toggle('is-active', i === idx);
      });
    }
    function go(n) { idx = (n % slides.length + slides.length) % slides.length; render(); restart(); }
    function restart() { clearInterval(timer); timer = setInterval(function () { go(idx + 1); }, 5000); }

    window.heroStep = function (d) { go(idx + d); };

    if (dotsWrap) {
      slides.forEach(function (_, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'hero-dot';
        b.setAttribute('aria-label', 'Слайд ' + (i + 1));
        b.addEventListener('click', function () { go(i); });
        dotsWrap.appendChild(b);
      });
    }
    // пауза только когда вкладка не активна — иначе слайдер крутится всегда
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearInterval(timer); else restart();
    });
    render();
    restart();
  }

  /* ---------- ИНИЦИАЛИЗАЦИЯ ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    markActiveNav();
    window.updateCartBadge();
    initHeroSlider();

    // аккордеоны в мобильном меню
    document.querySelectorAll('.drawer-group-head').forEach(function (b) {
      b.addEventListener('click', function () { b.parentNode.classList.toggle('open'); });
    });
    // клик по ссылке в меню закрывает панель
    document.querySelectorAll('.drawer a').forEach(function (a) {
      a.addEventListener('click', function () { setTimeout(window.closeDrawer, 60); });
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.closeDrawer();
  });

  /* ---------- Внутренние страницы: сразу к контенту (герой остаётся выше) ---------- */
  if (document.body.classList.contains('subpage') && !location.hash) {
    var jumpToContent = function () {
      var main = document.querySelector('main');
      if (!main) return;
      var header = document.querySelector('.site-header');
      var offset = (header ? header.offsetHeight : 64) + 8;
      var y = main.getBoundingClientRect().top + window.pageYOffset - offset;
      if (y > 4) window.scrollTo(0, y);
    };
    window.addEventListener('load', jumpToContent);
    // подстраховка, если картинка героя долистала лейаут
    setTimeout(jumpToContent, 400);
  }
})();
