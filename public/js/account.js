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

  var ORDER_LABELS = { new: 'Новая', processing: 'В работе', done: 'Выполнена', cancelled: 'Отменена' };
  var REVIEW_LABELS = { pending: 'На модерации', approved: 'Опубликован', rejected: 'Отклонён' };

  function renderProfile(c) {
    document.getElementById('acctName').textContent = c.name;
    document.getElementById('acctPhone').textContent = '+' + c.phone;
    document.getElementById('acctBonus').textContent = c.bonusBalance || 0;
    document.getElementById('acctAvatar').src = c.avatar || DEFAULT_AVATAR;
    document.getElementById('acctFormName').value = c.name || '';
    document.getElementById('acctFormEmail').value = c.email || '';
    document.getElementById('acctFormCompany').value = c.company || '';
  }

  window.acctShowTab = function (tab) {
    document.querySelectorAll('.acct-nav button[data-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.querySelectorAll('.acct-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.tab === tab); });
    location.hash = tab;
  };

  window.acctSaveProfile = async function () {
    var name = document.getElementById('acctFormName').value.trim();
    var email = document.getElementById('acctFormEmail').value.trim();
    var company = document.getElementById('acctFormCompany').value.trim();
    if (!name) { window.showToast('⚠️ Укажите имя'); return; }
    var res = await window.apiFetch('/api/me', 'PUT', { name: name, email: email, company: company });
    if (res.error) { window.showToast('❌ ' + res.error); return; }
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
        '<div>' + esc((o.createdAt || '').slice(0, 16)) + '</div>' +
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

  function renderReviews(reviews) {
    var box = document.getElementById('acctReviews');
    if (!reviews || !reviews.length) { box.innerHTML = '<p class="acct-empty">Вы пока не оставляли отзывов</p>'; return; }
    box.innerHTML = reviews.map(function (r) {
      var stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      return '<div class="acct-review">' +
        '<div class="acct-review-top"><span class="stars">' + stars + '</span><span class="acct-tag ' + r.status + '">' + (REVIEW_LABELS[r.status] || r.status) + '</span></div>' +
        (r.product_name ? '<div style="font-weight:600;margin-bottom:2px">' + esc(r.product_name) + '</div>' : '') +
        (r.text ? '<div>' + esc(r.text) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderNotifications(list) {
    var box = document.getElementById('acctNotifications');
    if (!list || !list.length) { box.innerHTML = '<p class="acct-empty">Уведомлений пока нет</p>'; return; }
    box.innerHTML = list.map(function (n) {
      return '<div class="acct-review">' +
        '<div style="color:var(--text-muted);font-size:12px;margin-bottom:2px">' + esc((n.created_at || '').slice(0, 16)) + '</div>' +
        '<div>' + esc(n.message) + '</div>' +
        '</div>';
    }).join('');
  }
  async function loadOrders() {
    try { renderOrders((await window.apiFetch('/api/me/orders')).orders); }
    catch (e) { document.getElementById('acctOrders').innerHTML = '<p class="acct-empty">Не удалось загрузить заказы</p>'; }
  }
  async function loadFavorites() {
    try { renderFavorites((await window.apiFetch('/api/me/favorites')).products); }
    catch (e) { document.getElementById('acctFavorites').innerHTML = '<p class="acct-empty">Не удалось загрузить избранное</p>'; }
  }
  async function loadReviews() {
    try { renderReviews((await window.apiFetch('/api/me/reviews')).reviews); }
    catch (e) { document.getElementById('acctReviews').innerHTML = '<p class="acct-empty">Не удалось загрузить отзывы</p>'; }
  }
  async function loadNotifications() {
    try { renderNotifications((await window.apiFetch('/api/me/notifications')).notifications); }
    catch (e) { document.getElementById('acctNotifications').innerHTML = '<p class="acct-empty">Не удалось загрузить уведомления</p>'; }
  }

  async function init() {
    var res;
    try { res = await window.apiFetch('/api/me'); } catch (e) { res = {}; }
    if (!res.customer) { location.href = '/'; return; }
    window.custState.token = window.custState.token || res.token;
    window.custState.customer = res.customer;
    renderProfile(res.customer);
    document.getElementById('acctLoading').style.display = 'none';
    document.getElementById('acctRoot').style.display = '';
    var tab = (location.hash || '#data').slice(1);
    if (!document.querySelector('.acct-panel[data-tab="' + tab + '"]')) tab = 'data';
    window.acctShowTab(tab);
    loadOrders();
    loadFavorites();
    loadReviews();
    loadNotifications();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
