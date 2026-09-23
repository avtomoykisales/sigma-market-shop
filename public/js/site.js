/* ============================================================
   SIGMA MARKET — общий скрипт (header, footer, drawer, формы)
   Подключается на всех страницах. На index.html поверх него
   работает основной SPA-скрипт каталога/корзины.
   ============================================================ */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- ЛОГ ОШИБОК (видно в админке, раздел «Ошибки») ---------- */
  // Не должен сам ничего ломать: fetch фоном, ошибки отправки просто игнорируем.
  window.logClientError = function (message, context) {
    try {
      fetch('/api/log-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(message || '').slice(0, 2000), context: context || '', url: location.href })
      }).catch(function () {});
    } catch (e) {}
  };
  // Расширения браузера (переводчики, антивирусы и т.п.) тоже кидают ошибки на
  // странице — их не отличить от наших на 100%, но самые типичные признаки чужого
  // скрипта отсеиваем, чтобы не засорять журнал.
  window.addEventListener('error', function (e) {
    if (e.message === 'Script error.') return;               // ошибка стороннего скрипта без CORS — деталей всё равно нет
    if (/^(chrome|moz|safari-web|safari)-extension:\/\//.test(e.filename || '')) return;
    window.logClientError(e.message + ' (' + (e.filename || '') + ':' + (e.lineno || '') + ')', 'window.onerror');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    window.logClientError((r && (r.message || r.toString())) || 'unhandled promise rejection', 'unhandledrejection');
  });

  /* ---------- РАБОЧЕЕ ВРЕМЯ ---------- */
  // Пн–Пт 09:00–18:00 по Алматы (см. /contacts.html «График работы») — время берём
  // именно по таймзоне Алматы, а не по часам устройства посетителя (он может быть
  // в другом часовом поясе или с неверно настроенными часами).
  window.isWorkingHours = function () {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Almaty', weekday: 'short', hour: 'numeric', hourCycle: 'h23'
      }).formatToParts(new Date());
      var get = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p && p.value; };
      var weekday = get('weekday');
      var hour = parseInt(get('hour'), 10);
      var isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(weekday) !== -1;
      return isWeekday && hour >= 9 && hour < 18;
    } catch (e) { return true; }   // не смогли определить — лучше не пугать лишним текстом
  };
  // Текст для тоста после отправки заявки — с учётом графика работы.
  window.contactSoonText = function () {
    return window.isWorkingHours()
      ? 'Мы свяжемся с вами.'
      : 'Мы свяжемся с вами в ближайший рабочий день.';
  };

  /* ---------- ПРОВЕРКА ТЕЛЕФОНА ---------- */
  // Казахстанский номер: 11 цифр, начинается с 7 или 8 (+7 700 123 45 67, 8 700 123 45 67 …).
  window.isValidPhone = function (phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    return /^[78]\d{10}$/.test(digits);
  };
  // Маска +7 (xxx) xxx-xx-xx во всех полях type="tel" (cPhone, oPhone, rvPhone).
  // Буквы и прочие символы не печатаются, номер собирается заново из введённых цифр.
  function formatKzPhone(digits) {
    if (!digits) return '';
    var out = '+7 (' + digits.slice(0, 3);
    if (digits.length >= 3) out += ')';
    if (digits.length > 3) out += ' ' + digits.slice(3, 6);
    if (digits.length > 6) out += '-' + digits.slice(6, 8);
    if (digits.length > 8) out += '-' + digits.slice(8, 10);
    return out;
  }
  // Настоящие цифры номера храним отдельно (el.dataset.phoneDigits) — не пытаемся
  // каждый раз заново вычислять их из уже отформатированного текста, иначе backspace
  // над скобкой/дефисом (символом маски, а не цифрой) визуально ничего не удаляет.
  function renderPhone(el) {
    el.value = formatKzPhone(el.dataset.phoneDigits || '');
    var pos = el.value.length;
    el.setSelectionRange(pos, pos);
  }
  document.addEventListener('keydown', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'tel') return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();
    var hasSelection = el.selectionStart !== el.selectionEnd;
    var digits = hasSelection ? '' : (el.dataset.phoneDigits || '').slice(0, -1);
    el.dataset.phoneDigits = digits;
    renderPhone(el);
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'tel') return;
    // Backspace/Delete перехвачены выше на keydown — сюда доходит только то, что
    // реально напечатали/вставили (всегда добавляется в конец, курсор мы держим там же).
    var prevDigits = el.dataset.phoneDigits || '';
    var allDigits = el.value.replace(/\D/g, '');
    var added;
    if (prevDigits) {
      // уже показан наш "+7 (" — это ровно одна лишняя цифра '7' перед prevDigits.
      added = allDigits.slice(1 + prevDigits.length);
    } else {
      added = allDigits;
      // Каждая набранная цифра сразу появляется в поле — никакой скрытой логики при
      // обычном наборе с клавиатуры (раньше первая "8" молча "проглатывалась" как замена
      // +7, и это выглядело как будто цифра не печатается). Срезаем код страны только
      // когда это однозначно вставка/автозаполнение готового номера — сразу 11+ цифр.
      if (added.length > 10) added = added.slice(added.length - 10);
    }
    el.dataset.phoneDigits = (prevDigits + added).slice(0, 10);
    renderPhone(el);
  });

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
    // подтверждения вроде "заявка принята" стали длиннее одной строки — 3с мало, чтобы
    // прочитать и понять, что заявка ушла (иначе люди отправляют её повторно)
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(function () { t.className = 'toast'; }, 5000);
  };

  /* ---------- API ---------- */
  window.apiFetch = async function (url, method, body) {
    var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    var custToken = localStorage.getItem('customerToken');
    if (custToken) opts.headers['x-customer-token'] = custToken;
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch(url, opts);
    return r.json();
  };

  // /api/settings нужен и здесь (initAccount — кнопка «Войти»), и основному скрипту
  // страницы (state.settings) — оба зовутся почти одновременно при загрузке страницы.
  // Кэшируем один и тот же промис, чтобы запрос уходил на сервер только один раз.
  var _settingsPromise = null;
  window.getSettings = function () {
    if (!_settingsPromise) _settingsPromise = window.apiFetch('/api/settings');
    return _settingsPromise;
  };

  /* ---------- ЛИЧНЫЙ КАБИНЕТ: регистрация, вход, бонусы ---------- */
  // customer = {id,name,phone,email,bonusBalance} | null. Токен — в localStorage,
  // не привязан к устройству/сессии (простая долгоживущая «корзина»-подобная модель).
  window.custState = { token: localStorage.getItem('customerToken') || '', customer: null };

  window.refreshAccountUI = function () {
    var btn = $('hdrAccount');
    if (!btn) return;
    var c = window.custState.customer;
    btn.innerHTML = c
      ? '👤 <span class="acc-name">' + c.name.split(' ')[0] + (c.bonusBalance ? ' · ' + c.bonusBalance + '₸' : '') + '</span>'
      : '👤 <span class="acc-name">Войти</span>';
  };

  window.openAccountModal = function () {
    if (window.custState.customer) { window.openAccountPanel(); return; }
    var ov = $('accountOverlay');
    if (!ov) return;
    $('acc-step-phone').style.display = '';
    $('acc-step-code').style.display = 'none';
    $('accPhone').value = ''; $('accCode').value = ''; $('accName').value = '';
    $('accNameField').style.display = 'none';
    ov.classList.add('open');
  };
  window.closeAccountModal = function () { var ov = $('accountOverlay'); if (ov) ov.classList.remove('open'); };

  var accResendTimer = null;
  window.custRequestCode = async function (isResend) {
    var phone = $('accPhone').value.trim();
    if (!window.isValidPhone(phone)) { window.showToast('⚠️ Введите корректный номер телефона'); return; }
    var res = await window.apiFetch('/api/auth/request-code', 'POST', { phone: phone });
    if (res.error) { window.showToast('❌ ' + res.error); return; }
    $('acc-step-phone').style.display = 'none';
    $('acc-step-code').style.display = '';
    $('accCodeSentTo').textContent = res.channel === 'whatsapp'
      ? 'Код отправлен в WhatsApp на ' + phone
      : 'WhatsApp не найден — код отправлен по SMS на ' + phone;
    if (!isResend) { $('accCode').value = ''; $('accName').value = ''; $('accNameField').style.display = 'none'; }
    var btn = $('accResendBtn');
    btn.disabled = true; var left = 60;
    clearInterval(accResendTimer);
    var tick = function () { btn.textContent = left > 0 ? 'Отправить ещё раз (' + left + ')' : 'Отправить код ещё раз'; if (left <= 0) { btn.disabled = false; clearInterval(accResendTimer); } left--; };
    tick(); accResendTimer = setInterval(tick, 1000);
  };
  window.custVerifyCode = async function () {
    var phone = $('accPhone').value.trim();
    var code = $('accCode').value.trim();
    var name = $('accName').value.trim();
    if (!code) { window.showToast('⚠️ Введите код из сообщения'); return; }
    var res = await window.apiFetch('/api/auth/verify-code', 'POST', { phone: phone, code: code, name: name });
    if (res.needName) { $('accNameField').style.display = ''; window.showToast('⚠️ Укажите имя — регистрируем вас впервые'); return; }
    if (res.error) { window.showToast('❌ ' + res.error); return; }
    custAuthed(res, res.isNew);
  };
  function custAuthed(res, isNew) {
    localStorage.setItem('customerToken', res.token);
    window.custState.token = res.token;
    window.custState.customer = res.customer;
    window.refreshAccountUI();
    window.closeAccountModal();
    window.showToast(isNew ? '✅ Добро пожаловать! Начислен бонус за регистрацию' : '✅ Вы вошли в аккаунт', 'green');
    if (typeof window.refreshCartBonus === 'function') window.refreshCartBonus();
  }
  window.custLogout = async function () {
    try { await window.apiFetch('/api/logout', 'POST'); } catch (e) {}
    localStorage.removeItem('customerToken');
    window.custState = { token: '', customer: null };
    window.refreshAccountUI();
    window.closeAccountPanel();
    window.showToast('Вы вышли из аккаунта');
  };
  window.openAccountPanel = function () {
    var ov = $('accountPanelOverlay');
    if (!ov) return;
    var c = window.custState.customer;
    if (c) {
      $('accPanelName').textContent = c.name;
      $('accPanelBonus').textContent = c.bonusBalance || 0;
    }
    ov.classList.add('open');
  };
  window.closeAccountPanel = function () { var ov = $('accountPanelOverlay'); if (ov) ov.classList.remove('open'); };

  async function initAccount() {
    var btn = $('hdrAccount');
    try {
      var s = await window.getSettings();
      if (btn) btn.style.display = (s.bonus && s.bonus.visible) ? '' : 'none';
    } catch (e) {}
    if (!window.custState.token) { window.refreshAccountUI(); return; }
    try {
      var res = await window.apiFetch('/api/me');
      if (res.customer) { window.custState.customer = res.customer; }
      else { localStorage.removeItem('customerToken'); window.custState.token = ''; }
    } catch (e) {}
    window.refreshAccountUI();
  }
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
    var nameEl = $('cName'), phoneEl = $('cPhone');
    if (!nameEl || !phoneEl) return;
    if (!nameEl.reportValidity() || !phoneEl.reportValidity()) return;
    var name = nameEl.value.trim();
    var phone = phoneEl.value.trim();
    if (!window.isValidPhone(phone)) { window.showToast('⚠️ Введите корректный номер телефона'); return; }
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
        window.showToast('✅ Заявка принята! ' + window.contactSoonText(), 'green');
        ['cName', 'cPhone', 'cCity', 'cEmail'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      }
    } catch (e) { window.logClientError(e && (e.message || e), 'submitConsult'); window.showToast('❌ Ошибка. Попробуйте ещё раз.'); }
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
    initAccount();

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
