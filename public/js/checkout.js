// Страница оформления заказа (/checkout) — полноценная страница со своим URL взамен
// формы внутри попапа корзины: нужна, в частности, чтобы процесс покупки был проверяемым
// по прямой ссылке (см. требования Google Merchant Center к чекауту). Сама корзина
// (попап #cartPanel в index.html) не трогается — она просто ведёт сюда кнопкой.
(function () {
  function $(id) { return document.getElementById(id); }

  function getCart() {
    try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch (e) { return []; }
  }
  function setCart(cart) {
    try { localStorage.setItem('cart', JSON.stringify(cart)); } catch (e) {}
    if (window.updateCartBadge) window.updateCartBadge();
  }

  function cartBonusToUse(total) {
    var cb = $('coUseBonus');
    var c = window.custState && window.custState.customer;
    if (!cb || !cb.checked || !c) return 0;
    return Math.max(0, Math.min(c.bonusBalance || 0, total));
  }

  // Настройки бонусной программы (earn_percent и т.п.) — те же, что state.settings в
  // index.html, только здесь берём их через window.getSettings() (см. site.js).
  var cachedSettings = null;
  function ensureSettings() {
    if (cachedSettings) return Promise.resolve(cachedSettings);
    return window.getSettings().then(function (s) {
      cachedSettings = s || {};
      return cachedSettings;
    }).catch(function () { cachedSettings = {}; return cachedSettings; });
  }

  // "Зарегистрируйтесь — получите N ₸ бонусами" — тот же стимул для гостя, что и в
  // попапе корзины (см. cartRegisterNudge), пересчитываем его и здесь.
  function updateRegisterNudge(total) {
    var box = $('checkoutRegisterNudge');
    if (!box) return;
    var loggedIn = window.custState && window.custState.customer;
    var b = cachedSettings && cachedSettings.bonus;
    var amount = (!loggedIn && b && b.visible && b.enabled && b.earn_percent && total)
      ? Math.round(total * b.earn_percent / 100) : 0;
    box.style.display = amount > 0 ? '' : 'none';
    if (amount > 0) $('checkoutRegisterAmount').textContent = window.formatPrice(amount);
  }
  // Сколько бонусов начислится с этого заказа уже вошедшему клиенту — та же формула,
  // что и сам расчёт начисления в /api/orders (процент от суммы К ОПЛАТЕ, то есть уже
  // после списания бонусов, если клиент их применил, см. order там же).
  function updateEarnPreview(payTotal) {
    var box = $('checkoutEarnPreview');
    if (!box) return;
    var loggedIn = window.custState && window.custState.customer;
    var b = cachedSettings && cachedSettings.bonus;
    var amount = (loggedIn && b && b.visible && b.enabled && b.earn_percent && payTotal)
      ? Math.round(payTotal * b.earn_percent / 100) : 0;
    box.style.display = amount > 0 ? '' : 'none';
    if (amount > 0) $('checkoutEarnAmount').textContent = window.formatPrice(amount);
  }

  function renderSummary() {
    var confirm = $('checkoutConfirm');
    if (confirm && confirm.style.display && confirm.style.display !== 'none') return; // заказ уже оформлен — не перерисовываем

    var cart = getCart();
    var empty = $('checkoutEmpty'), grid = $('checkoutGrid');
    if (!cart.length) {
      if (empty) empty.style.display = '';
      if (grid) grid.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (grid) grid.style.display = '';

    var el = $('checkoutItems');
    if (el) {
      el.innerHTML = cart.map(function (item) {
        var img = item.icon ? '<img src="/icons/' + item.icon + '" alt="">' : '📦';
        var price = item.price_on_request ? 'По запросу' : window.formatPrice(item.price * item.qty);
        return '<div class="cart-item">' +
          '<div class="cart-item-img">' + img + '</div>' +
          '<div class="cart-item-info">' +
            '<div class="cart-item-name">' + item.name + '</div>' +
            '<div class="cart-item-price' + (item.price_on_request ? ' request' : '') + '">' + price + ' × ' + item.qty + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    var total = cart.filter(function (i) { return !i.price_on_request; }).reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var hasReq = cart.some(function (i) { return i.price_on_request; });
    var bonusUsed = cartBonusToUse(total);
    var totalEl = $('checkoutTotal');
    if (totalEl) {
      totalEl.innerHTML = 'Итого: <span>' + window.formatPrice(total - bonusUsed) + '</span>' +
        (hasReq ? ' + по запросу' : '') +
        (bonusUsed ? ' (списано ' + window.formatPrice(bonusUsed) + ' бонусов)' : '');
    }
    updateRegisterNudge(total);
    updateEarnPreview(total - bonusUsed);
  }

  // Имя/телефон/email вошедшего клиента уже известны — подставляем их и блокируем
  // редактирование полей, где в базе уже есть значение (пустые, напр. email у тех, кто
  // регистрировался через Telegram без почты, остаются обычными полями для заполнения).
  // window.custState.customer заполняется асинхронно (initAccount() в site.js) — если
  // к этому вызову он ещё не пришёл, site.js сам дозовёт window.prefillCheckoutContact,
  // как только придёт (та же гонка и тот же приём, что и у refreshBonusRow/renderSummary).
  function lockField(el, value) {
    if (!el || !value) return;
    el.readOnly = true;
    el.style.background = 'var(--bg)';
  }
  window.prefillCheckoutContact = function () {
    var c = window.custState && window.custState.customer;
    if (!c) return;
    var nameEl = $('coName'), phoneEl = $('coPhone'), emailEl = $('coEmail');
    if (c.name && nameEl) { nameEl.value = c.name; lockField(nameEl, c.name); }
    if (c.phone && phoneEl) { window.fillPhoneField(phoneEl, c.phone); lockField(phoneEl, c.phone); }
    if (c.email && emailEl) { emailEl.value = c.email; lockField(emailEl, c.email); }
  };

  function refreshBonusRow() {
    var row = $('checkoutBonusRow');
    if (!row) return;
    var c = window.custState && window.custState.customer;
    if (c && c.bonusBalance > 0) {
      row.style.display = '';
      $('checkoutBonusAvail').textContent = c.bonusBalance;
      // Та же галочка, что в попапе корзины (см. cartUseBonus в index.html) — общий
      // выбор через localStorage, иначе на /checkout приходилось отмечать её заново.
      $('coUseBonus').checked = window.getUseBonusPref();
    } else {
      row.style.display = 'none';
    }
    renderSummary();
  }

  window.submitCheckout = async function () {
    var cart = getCart();
    if (!cart.length) { window.showToast('⚠️ Добавьте товар в корзину'); return; }
    var nameEl = $('coName'), phoneEl = $('coPhone');
    if (!nameEl.reportValidity() || !phoneEl.reportValidity()) return;
    var name = nameEl.value.trim();
    var phone = phoneEl.value.trim();
    if (!window.isValidPhone(phone)) { window.showToast('⚠️ Введите корректный номер телефона'); return; }

    var btn = document.querySelector('.checkout-aside .btn-primary');
    btn.disabled = true; btn.textContent = 'Отправляем…';

    var paymentMethod = (document.querySelector('input[name="coPayment"]:checked') || {}).value || '';
    var deliveryMethod = $('coDelivery').value;
    var total = cart.filter(function (i) { return !i.price_on_request; }).reduce(function (s, i) { return s + i.price * i.qty; }, 0);

    try {
      var res = await window.apiFetch('/api/orders', 'POST', {
        name: name, phone: phone,
        email: $('coEmail').value.trim(),
        message: $('coMessage').value.trim(),
        items: JSON.stringify(cart.map(function (i) { return { id: i.id, name: i.name, qty: i.qty, price: i.price || 0 }; })),
        useBonus: cartBonusToUse(total),
        website: $('coWebsite').value,
        paymentMethod: paymentMethod, deliveryMethod: deliveryMethod
      });
      if (res.success) {
        // Та же конверсия Google Ads, что отправлялась раньше при оформлении прямо из попапа корзины.
        if (window.GADS_ID) {
          if (window.gtag) gtag('event', 'conversion', { send_to: window.GADS_ID + '/qC2TCOi2vIsdENaK1rdE' });
          else if (window.logClientError) window.logClientError('Конверсия Google Ads не отправлена: gtag не загружен', 'conversion-missing');
        }
        // Отдельное событие GA4 "получена заявка" — именно на момент отправки заказа,
        // а не служебный page_view (который GA4 шлёт на каждый заход, в т.ч. на каталог).
        // Нужно, чтобы в Google Ads конверсию "Заявка с сайта" можно было привязать к
        // этому событию вместо ошибочно привязанного page_view каталога.
        if (window.gtag) gtag('event', 'generate_lead', { value: total, currency: 'KZT' });
        setCart([]);
        $('checkoutOrderId').textContent = res.orderId || '';
        $('checkoutConfirmText').textContent = 'Способ оплаты: ' + (paymentMethod || 'уточняется') + '. ' + window.contactSoonText();
        $('checkoutGrid').style.display = 'none';
        $('checkoutConfirm').style.display = '';
        if (window.custState && window.custState.token) {
          window.apiFetch('/api/me').then(function (r) {
            if (r.customer) { window.custState.customer = r.customer; if (window.refreshAccountUI) window.refreshAccountUI(); }
          });
        }
      } else {
        window.showToast('❌ ' + (res.error || 'Не удалось оформить заказ'));
        btn.disabled = false; btn.textContent = '✅ Оформить заказ';
      }
    } catch (e) {
      window.showToast('❌ Ошибка сети. Попробуйте ещё раз.');
      btn.disabled = false; btn.textContent = '✅ Оформить заказ';
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    renderSummary();
    window.prefillCheckoutContact();
    var cb = $('coUseBonus');
    if (cb) cb.addEventListener('change', function () { window.setUseBonusPref(cb.checked); renderSummary(); });
    // window.custState.customer заполняется асинхронно (initAccount() в site.js, запрос
    // /api/me) — перепроверяем видимость блока бонусов ещё раз, когда он успеет прийти.
    refreshBonusRow();
    setTimeout(refreshBonusRow, 600);
    // Настройки бонусной программы тоже приходят асинхронно — как только пришли,
    // пересчитываем "Зарегистрируйтесь и получите…" для гостя.
    ensureSettings().then(renderSummary);

    // Заявка "Запросить КП" (см. requestModal в product.js) кладёт сюда готовый текст
    // перед переходом на эту страницу — одноразовое использование.
    try {
      var prefill = localStorage.getItem('checkoutPrefillMessage');
      if (prefill) {
        var msg = $('coMessage');
        if (msg) msg.value = prefill;
        localStorage.removeItem('checkoutPrefillMessage');
      }
    } catch (e) {}
  });
})();
