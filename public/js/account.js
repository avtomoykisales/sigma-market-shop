/* ============================================================
   Личный кабинет (/account): профиль, заказы, избранное, отзывы.
   Опирается на apiFetch/showToast/formatPrice/custLogout из site.js.
   ============================================================ */
(function () {
  var DEFAULT_AVATAR = document.getElementById('acctAvatar') ? document.getElementById('acctAvatar').src : '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Сервер хранит время в UTC (datetime('now') в SQLite) — сырую строку "YYYY-MM-DD
  // HH:MM:SS" показывать нельзя, она не время Алматы, а UTC (разница 5 часов). Тот же
  // приём, что и acDate/articleDate/pvReviewDate в product.js: добавляем "Z" (чтобы
  // Date понял, что это UTC) и даём браузеру самому перевести в локальное время.
  function fmtDateTime(s) {
    if (!s) return '';
    var d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return esc(String(s).slice(0, 16));
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  var ORDER_LABELS = { new: 'Новая', processing: 'В работе', done: 'Выполнена', cancelled: 'Отменена' };
  var REVIEW_LABELS = { pending: 'На модерации', approved: 'Опубликован', rejected: 'Отклонён' };

  function renderProfile(c) {
    var idText = c.clientNo ? String(c.clientNo).padStart(6, '0') : c.id;
    document.getElementById('acctName').innerHTML = esc(c.name);
    document.getElementById('acctId').innerHTML = '<span class="acct-id-badge">ID клиента: ' + esc(idText) + '</span>';
    document.getElementById('acctPhone').textContent = '+' + c.phone;
    var clientNoEl = document.getElementById('acctFormClientNo');
    clientNoEl.value = c.clientNo ? String(c.clientNo).padStart(6, '0') : c.id;
    clientNoEl.style.background = 'var(--bg)';
    document.getElementById('acctBonus').textContent = c.bonusBalance || 0;
    document.getElementById('acctAvatar').src = c.avatar || DEFAULT_AVATAR;
    document.getElementById('acctFormName').value = c.name || '';
    document.getElementById('acctFormEmail').value = c.email || '';
    document.getElementById('acctFormCompany').value = c.company || '';
    window.fillPhoneField(document.getElementById('acctFormPhone'), c.phone);
    window.fillPhoneField(document.getElementById('acctFormCorpPhone'), c.corpPhone);
    window.fillPhoneField(document.getElementById('acctFormExtraPhone'), c.extraPhone);
  }

  window.acctShowTab = function (tab) {
    document.querySelectorAll('.acct-nav button[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.querySelectorAll('.acct-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.tab === tab); });
    location.hash = tab;
    // Открыли вкладку уведомлений — гасим красный счётчик непрочитанных (см. updateNotifBadge).
    if (tab === 'notifications' && hasUnreadNotifications) markNotificationsRead();
    if (tab === 'chat') { acctChatForceScroll = true; if (hasUnreadChat) markChatRead(); }
  };

  window.acctSaveProfile = async function () {
    var name = document.getElementById('acctFormName').value.trim();
    var email = document.getElementById('acctFormEmail').value.trim();
    var company = document.getElementById('acctFormCompany').value.trim();
    var phone = document.getElementById('acctFormPhone').value.trim();
    // Корпоративный/доп. номер — необязательные доп. контакты, не для входа, поэтому
    // без строгой проверки на полный номер (как у основного телефона выше).
    var corpPhone = document.getElementById('acctFormCorpPhone').value.replace(/\D/g, '');
    var extraPhone = document.getElementById('acctFormExtraPhone').value.replace(/\D/g, '');
    if (!name) { window.showToast('⚠️ Укажите имя'); return; }
    if (!window.isValidPhone(phone)) { window.showToast('⚠️ Введите корректный номер телефона'); return; }
    phone = phone.replace(/\D/g, '');
    // Бонусы начисляются по номеру телефона — меняем отдельным эндпоинтом с проверкой
    // на занятость номера другим аккаунтом (/api/me/phone, уже используется для Telegram-входа).
    if (phone !== window.custState.customer.phone) {
      var phoneRes = await window.apiFetch('/api/me/phone', 'POST', { phone: phone });
      if (phoneRes.error) { window.showToast('❌ ' + phoneRes.error); return; }
    }
    var res = await window.apiFetch('/api/me', 'PUT', { name: name, email: email, company: company, corpPhone: corpPhone, extraPhone: extraPhone });
    if (res.error) { window.showToast('❌ ' + res.error); return; }
    res.customer.phone = phone;
    window.custState.customer = res.customer;
    renderProfile(res.customer);
    window.refreshAccountUI();
    window.showToast('✅ Данные сохранены', 'green');
  };

  window.acctUploadAvatar = async function (file) {
    if (!file) return;
    var fd = new FormData();
    fd.append('avatar', file);
    try {
      var r = await fetch('/api/me/avatar', { method: 'POST', headers: { 'x-customer-token': window.custState.token }, body: fd });
      var data = await r.json();
      if (data.error) { window.showToast('❌ ' + data.error); return; }
      document.getElementById('acctAvatar').src = data.avatar;
      window.custState.customer.avatar = data.avatar;
      window.showToast('✅ Фото обновлено', 'green');
    } catch (e) { window.showToast('❌ Не удалось загрузить фото'); }
  };

  function renderOrders(orders) {
    var box = document.getElementById('acctOrders');
    if (!orders || !orders.length) { box.innerHTML = '<p class="acct-empty">Пока нет заказов</p>'; return; }
    box.innerHTML = orders.map(function (o) {
      var itemsText = (o.items || []).map(function (i) { return esc(i.name || i.title || 'товар') + ' × ' + (i.qty || 1); }).join(', ');
      return '<div class="acct-order">' +
        '<div class="acct-order-top"><span>Заказ №' + o.id + '</span><span class="acct-tag ' + o.status + '">' + (ORDER_LABELS[o.status] || o.status) + '</span></div>' +
        '<div>' + fmtDateTime(o.createdAt) + '</div>' +
        (itemsText ? '<div class="acct-order-items">' + itemsText + '</div>' : '') +
        (o.total ? '<div class="acct-order-total">' + window.formatPrice(o.total) + (o.bonusEarned ? ' <span class="acct-order-bonus">+' + window.formatPrice(o.bonusEarned) + ' бонусов</span>' : '') + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderFavorites(products) {
    var box = document.getElementById('acctFavorites');
    if (!products || !products.length) { box.innerHTML = '<p class="acct-empty">Пока нет избранных товаров</p>'; return; }
    box.innerHTML = '<div class="acct-fav-grid">' + products.map(function (p) {
      var priceHtml = p.price_on_request ? 'Цена по запросу' : (p.price ? window.formatPrice(p.price) : 'Уточните цену');
      var url = '/product/' + p.id;
      return '<div class="acct-fav-card">' +
        '<button class="acct-fav-remove" title="Убрать из избранного" onclick="acctRemoveFavorite(' + p.id + ')">✕</button>' +
        '<a href="' + url + '">' + (p.icon ? '<img src="/icons/' + p.icon + '" alt="" onerror="this.style.display=\'none\'">' : '') + '</a>' +
        '<div class="acct-fav-card-body"><a href="' + url + '">' + esc(p.name) + '</a><div>' + priceHtml + '</div></div>' +
        '</div>';
    }).join('') + '</div>';
  }
  window.acctRemoveFavorite = async function (id) {
    await window.apiFetch('/api/me/favorites/' + id, 'DELETE');
    try {
      var favs = JSON.parse(localStorage.getItem('favorites') || '[]');
      localStorage.setItem('favorites', JSON.stringify(favs.filter(function (x) { return x !== id; })));
    } catch (e) {}
    loadFavorites();
  };

  // Товары из выполненных заказов, на которые клиент ещё не оставил отзыв — карточками
  // (фото/название/цена, как в "Избранном") с кнопкой "Оставить отзыв" на вкладке "Мои
  // отзывы". Название/фото/цена — актуальные из products (см. /api/me/review-prompts),
  // а не снимок на момент заказа — на случай, если товар с тех пор переименовали и т.п.
  async function loadReviewPrompts() {
    var box = document.getElementById('acctReviewPrompts');
    if (!box) return;
    try {
      var products = (await window.apiFetch('/api/me/review-prompts')).products || [];
      if (!products.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML = '<h3 class="acct-review-prompts-title">Товары, которые вы купили</h3>' +
        '<div class="acct-fav-grid">' + products.map(function (p) {
          var priceHtml = p.price_on_request ? 'Цена по запросу' : (p.price ? window.formatPrice(p.price) : 'Уточните цену');
          var url = '/product/' + p.id;
          return '<div class="acct-fav-card">' +
            '<a href="' + url + '">' + (p.icon ? '<img src="/icons/' + p.icon + '" alt="" onerror="this.style.display=\'none\'">' : '') + '</a>' +
            '<div class="acct-fav-card-body">' +
              '<a href="' + url + '">' + esc(p.name) + '</a><div>' + priceHtml + '</div>' +
              '<a class="acct-review-prompt-link" href="' + url + '#reviews">Оставить отзыв →</a>' +
            '</div>' +
            '</div>';
        }).join('') + '</div>';
    } catch (e) {}
  }

  function renderReviews(reviews) {
    var box = document.getElementById('acctReviews');
    if (!reviews || !reviews.length) { box.innerHTML = '<p class="acct-empty">Вы пока не оставляли отзывов</p>'; return; }
    box.innerHTML = reviews.map(function (r) {
      var stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      return '<div class="acct-review">' +
        '<div class="acct-review-top"><span class="stars">' + stars + '</span><span class="acct-tag ' + r.status + '">' + (REVIEW_LABELS[r.status] || r.status) + '</span></div>' +
        (r.product_name ? '<div style="font-weight:600;margin-bottom:2px">' + esc(r.product_name) + '</div>' : '') +
        (r.text ? '<div>' + esc(r.text) + '</div>' : '') +
        (r.reply ? '<div class="review-reply"><b>Ответ SIGMA MARKET:</b> ' + esc(r.reply) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderNotifications(list) {
    var box = document.getElementById('acctNotifications');
    if (!list || !list.length) { box.innerHTML = '<p class="acct-empty">Уведомлений пока нет</p>'; return; }
    box.innerHTML = list.map(function (n) {
      return '<div class="acct-review' + (n.read_at ? '' : ' acct-unread') + '">' +
        '<div style="color:var(--text-muted);font-size:12px;margin-bottom:2px">' + fmtDateTime(n.created_at) + '</div>' +
        '<div>' + esc(n.message) + '</div>' +
        '</div>';
    }).join('');
  }
  // Красный счётчик рядом с "Мои уведомления" — сколько n.read_at ещё пустое.
  var hasUnreadNotifications = false;
  function updateNotifBadge(list) {
    var badge = document.getElementById('acctNotifBadge');
    if (!badge) return;
    var unread = (list || []).filter(function (n) { return !n.read_at; }).length;
    hasUnreadNotifications = unread > 0;
    badge.textContent = '(' + unread + ')';
    badge.style.display = unread > 0 ? '' : 'none';
  }
  async function markNotificationsRead() {
    hasUnreadNotifications = false;
    var badge = document.getElementById('acctNotifBadge');
    if (badge) badge.style.display = 'none';
    document.querySelectorAll('#acctNotifications .acct-unread').forEach(function (el) { el.classList.remove('acct-unread'); });
    try { await window.apiFetch('/api/me/notifications/read', 'PUT'); } catch (e) {}
  }
  // ---- Чат с нами ----
  // true сразу после открытия вкладки "Чат с нами" (см. acctShowTab) — следующий
  // renderChat() должен прыгнуть к последним сообщениям безусловно, а не по эвристике
  // "был ли и так внизу": при самом первом рендере после переключения вкладки box
  // ещё пуст (scrollHeight=0), эвристика случайно считает это "уже внизу" и ставит
  // scrollTop=0 — а после того как контент наполнится, это 0 так и остаётся, будто
  // человек специально пролистал наверх, и дальше новые сообщения уже не долистывают.
  var acctChatForceScroll = true;
  // Картинки показываем картинкой, остальное (PDF, Word) — иконкой документа со
  // скачиваемым именем файла; то же самое используется в превью перед отправкой.
  function acctIsImageName(name) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || ''); }
  function acctChatAttachmentHtml(path) {
    if (acctIsImageName(path)) return '<a href="' + esc(path) + '" target="_blank" rel="noopener"><img src="' + esc(path) + '" class="acct-chat-bubble-img"></a>';
    var name = path.split('/').pop();
    return '<a href="' + esc(path) + '" target="_blank" rel="noopener" class="acct-chat-bubble-file">📄 ' + esc(name) + '</a>';
  }
  function renderChat(list) {
    var box = document.getElementById('acctChatMessages');
    if (!box) return;
    var wasNearBottom = acctChatForceScroll || (box.scrollHeight - box.scrollTop - box.clientHeight < 60);
    acctChatForceScroll = false;
    if (!list || !list.length) {
      box.innerHTML = '<p class="acct-empty">Напишите нам, если есть вопросы — отвечаем в рабочее время.</p>';
      return;
    }
    box.innerHTML = list.map(function (m) {
      var mine = m.sender === 'customer';
      // У сообщений от компании пишем просто "Менеджер" — конкретный логин админа
      // (chat_messages.admin) клиенту не показываем, это видно только в самой админке.
      var adminLabel = !mine ? '<div class="acct-chat-admin">Менеджер</div>' : '';
      var imgHtml = m.attachment ? acctChatAttachmentHtml(m.attachment) : '';
      var textHtml = m.text ? '<div' + (m.attachment ? ' style="margin-top:6px"' : '') + '>' + esc(m.text) + '</div>' : '';
      return '<div class="acct-chat-msg ' + (mine ? 'mine' : 'theirs') + '">' +
        adminLabel +
        '<div class="acct-chat-bubble">' + imgHtml + textHtml + '</div>' +
        '<div class="acct-chat-time">' + fmtDateTime(m.created_at) + '</div>' +
        '</div>';
    }).join('');
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  }
  // ---- Уведомления о новых сообщениях (пока открыта вкладка /account, даже в фоне) ----
  window.acctRequestNotifyPermission = function () {
    if (!('Notification' in window)) { window.showToast('Браузер не поддерживает уведомления'); return; }
    Notification.requestPermission().then(acctUpdateNotifBtn);
  };
  function acctUpdateNotifBtn() {
    var btn = document.getElementById('acctChatNotifBtn');
    if (!btn) return;
    if (!('Notification' in window)) { btn.style.display = 'none'; return; }
    var p = Notification.permission;
    btn.classList.toggle('on', p === 'granted');
    btn.textContent = p === 'granted' ? '🔔 Уведомления включены' : (p === 'denied' ? '🔔 Заблокированы в браузере' : '🔔 Включить уведомления');
  }
  function acctPlayBeep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880; osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
  }
  var acctChatBaseTitle = document.title;
  var acctPrevUnread = 0;
  function acctChatNotify(lastMsg) {
    acctPlayBeep();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var n = new Notification('💬 Новое сообщение — SIGMA MARKET', { body: (lastMsg && lastMsg.text) || '', tag: 'acct-chat' });
      n.onclick = function () { window.focus(); window.acctShowTab('chat'); n.close(); };
    } catch (e) {}
  }
  var hasUnreadChat = false;
  function updateChatBadge(list) {
    var badge = document.getElementById('acctChatBadge');
    var unreadMsgs = (list || []).filter(function (m) { return m.sender === 'admin' && !m.read_at; });
    var unread = unreadMsgs.length;
    hasUnreadChat = unread > 0;
    if (badge) { badge.textContent = '(' + unread + ')'; badge.style.display = unread > 0 ? '' : 'none'; }
    document.title = unread > 0 ? '(' + unread + ') ' + acctChatBaseTitle : acctChatBaseTitle;
    // Уведомляем всегда при новых непрочитанных (выросло с прошлого опроса), даже
    // если вкладка "Чат с нами" и так открыта — надёжнее, чем гадать, видит ли
    // человек сообщение на экране прямо сейчас.
    if (unread > acctPrevUnread) acctChatNotify(unreadMsgs[unreadMsgs.length - 1]);
    acctPrevUnread = unread;
  }
  async function markChatRead() {
    hasUnreadChat = false;
    acctPrevUnread = 0;
    var badge = document.getElementById('acctChatBadge');
    if (badge) badge.style.display = 'none';
    document.title = acctChatBaseTitle;
    try { await window.apiFetch('/api/me/chat/read', 'PUT'); } catch (e) {}
  }
  async function loadChat() {
    try {
      var list = (await window.apiFetch('/api/me/chat')).messages;
      renderChat(list);
      updateChatBadge(list);
      var activeTab = document.querySelector('.acct-nav button[data-tab].active');
      if (activeTab && activeTab.dataset.tab === 'chat' && hasUnreadChat) markChatRead();
    } catch (e) { document.getElementById('acctChatMessages').innerHTML = '<p class="acct-empty">Не удалось загрузить чат</p>'; }
  }
  var acctChatPendingFile = null;
  window.acctShowChatAttachPreview = function () {
    var file = document.getElementById('acctChatFile').files[0];
    var box = document.getElementById('acctChatAttachPreview');
    if (!file) { acctChatPendingFile = null; box.style.display = 'none'; box.innerHTML = ''; return; }
    acctChatPendingFile = file;
    var thumb = acctIsImageName(file.name) ? '<img src="' + URL.createObjectURL(file) + '">' : '<span class="acct-chat-attach-preview-icon">📄</span>';
    box.style.display = 'flex';
    box.innerHTML = thumb + '<span>' + esc(file.name) + '</span><button type="button" onclick="acctClearChatAttachPreview()" title="Убрать">✕</button>';
  };
  window.acctClearChatAttachPreview = function () {
    acctChatPendingFile = null;
    document.getElementById('acctChatFile').value = '';
    var box = document.getElementById('acctChatAttachPreview');
    box.style.display = 'none';
    box.innerHTML = '';
  };
  window.acctSendChat = async function () {
    var input = document.getElementById('acctChatInput');
    var text = input.value.trim();
    if (!text && !acctChatPendingFile) return;
    var attachment = null;
    if (acctChatPendingFile) {
      var fd = new FormData(); fd.append('photo', acctChatPendingFile);
      try {
        var r = await fetch('/api/me/chat-upload', { method: 'POST', headers: { 'x-customer-token': window.custState.token }, body: fd });
        var d = await r.json();
        if (d.path) attachment = d.path;
        else { window.showToast('❌ ' + (d.error || 'Не удалось загрузить фото')); return; }
      } catch (e) { window.showToast('❌ Ошибка загрузки фото'); return; }
    }
    input.value = '';
    window.acctClearChatAttachPreview();
    var res = await window.apiFetch('/api/me/chat', 'POST', { text: text, attachment: attachment });
    if (res.error) { window.showToast('❌ ' + res.error); return; }
    loadChat();
  };
  // Лёгкий опрос, чтобы ответ админа появлялся в чате без перезагрузки страницы —
  // работает, пока открыта страница /account (не весь сайт), раз в 8 секунд.
  setInterval(loadChat, 8000);

  async function loadOrders() {
    try {
      renderOrders((await window.apiFetch('/api/me/orders')).orders);
    }
    catch (e) { document.getElementById('acctOrders').innerHTML = '<p class="acct-empty">Не удалось загрузить заказы</p>'; }
  }
  async function loadFavorites() {
    try { renderFavorites((await window.apiFetch('/api/me/favorites')).products); }
    catch (e) { document.getElementById('acctFavorites').innerHTML = '<p class="acct-empty">Не удалось загрузить избранное</p>'; }
  }
  async function loadReviews() {
    try {
      renderReviews((await window.apiFetch('/api/me/reviews')).reviews);
    }
    catch (e) { document.getElementById('acctReviews').innerHTML = '<p class="acct-empty">Не удалось загрузить отзывы</p>'; }
  }
  // Сумма берётся из настроек сайта (не захардкожена) — админ может поменять её в окне
  // публикации отзыва (см. admin.html), и тут она тут же актуальная.
  async function loadReviewBonusInfo() {
    var box = document.getElementById('acctReviewBonusInfo');
    if (!box) return;
    try {
      var s = await window.getSettings();
      var amount = Number(s.review_bonus_amount) || 500;
      box.textContent = '🎁 За опубликованный отзыв о товаре начисляется ' + window.formatPrice(amount) + ' бонусами — не более 3 отзывов в месяц.';
      box.style.display = '';
    } catch (e) {}
  }
  async function loadNotifications() {
    try {
      var list = (await window.apiFetch('/api/me/notifications')).notifications;
      renderNotifications(list);
      updateNotifBadge(list);
      // Страница могла открыться сразу на #notifications (до того, как список успел
      // загрузиться) — acctShowTab() в этот момент ещё не знал, что есть непрочитанные.
      var activeTab = document.querySelector('.acct-nav button[data-tab].active');
      if (activeTab && activeTab.dataset.tab === 'notifications' && hasUnreadNotifications) markNotificationsRead();
    }
    catch (e) { document.getElementById('acctNotifications').innerHTML = '<p class="acct-empty">Не удалось загрузить уведомления</p>'; }
  }

  async function init() {
    var res;
    try { res = await window.apiFetch('/api/me'); } catch (e) { res = {}; }
    // "/#chat" на главной открывает окно входа (см. handleRoute в index.html) — так
    // гость, перешедший по ссылке "Чат с нами" из футера без действующего входа,
    // не просто молча попадает на главную, а видит, что нужно войти/зарегистрироваться.
    if (!res.customer) { location.href = '/#chat'; return; }
    window.custState.token = window.custState.token || res.token;
    window.custState.customer = res.customer;
    renderProfile(res.customer);
    var loadingEl = document.getElementById('acctLoading'); if (loadingEl) loadingEl.style.display = 'none';
    var rootEl = document.getElementById('acctRoot'); if (rootEl) rootEl.style.display = '';
    var tab = (location.hash || '#data').slice(1);
    if (!document.querySelector('.acct-panel[data-tab="' + tab + '"]')) tab = 'data';
    window.acctShowTab(tab);
    loadOrders();
    loadFavorites();
    loadReviews();
    loadReviewBonusInfo();
    loadReviewPrompts();
    loadNotifications();
    acctUpdateNotifBtn();
    loadChat();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
