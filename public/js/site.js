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

  /* ---------- ИНИЦИАЛИЗАЦИЯ ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    markActiveNav();
    window.updateCartBadge();

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
})();
