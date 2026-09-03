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
    function restart() { clearInterval(timer); timer = setInterval(function () { go(idx + 1); }, 2000); }

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
