// Чинит пункт "Пылесосы" у бизнес-типа "Клининговая компания" в квизе подбора.
// У Клининга в каталоге — СВОИ подкатегории пылесосов (с другими адресами в URL), не те
// же самые, что у "Автомойки", хотя называются одинаково. Если на 2-м шаге клининга
// "Пылесосы" случайно указывают на автомоечные подкатегории (напр. через id "pylesos",
// общий с веткой "Автомойка") — квиз не находит совпадений (товары числятся за другой
// категорией) и откатывается к показу вообще всех товаров клининга — отсюда поломоечные
// машины вместо пылесосов. Этот скрипт переносит пункт на отдельный id "pylesos_klining"
// со своей веткой 3-го шага на правильные, клининговые подкатегории.
//
// По умолчанию ничего не меняет — только показывает, что сделал бы (сухой прогон).
//
// Запуск (в терминале, токен нигде не сохраняется в файлах):
//   ADMIN_TOKEN='логин:пароль' node scripts/fix-quiz-klining-pylesosy.js            — показать
//   ADMIN_TOKEN='логин:пароль' APPLY=1 node scripts/fix-quiz-klining-pylesosy.js    — применить
// По умолчанию бьёт в https://b2btech.kz — можно переопределить SITE_URL.

const SITE = process.env.SITE_URL || 'https://b2btech.kz';
const TOKEN = process.env.ADMIN_TOKEN;
const APPLY = process.env.APPLY === '1';
if (!TOKEN) {
  console.error('Укажите токен: ADMIN_TOKEN=\'логин:пароль\' node scripts/fix-quiz-klining-pylesosy.js');
  process.exit(1);
}

// Правильные, клининговые подкатегории (проверено на живом сайте).
const KLINING_PYLESOS_OPTIONS = [
  { id: 'pylesos_vac',  label: 'Пылеводосос',                          subcategory: 'professional-nye-pylevodososy' },
  { id: 'pylesos_extr', label: 'Пылесос для влажной уборки (экстрактор)', subcategory: 'professional-nye-moyuschie-pylesosy-ekstraktory' },
  { id: 'pylesos_steam',label: 'Парогенератор',                        subcategory: 'professional-nye-parogeneratory' },
  { id: 'pylesos_prom', label: 'Промышленный пылесос',                 subcategory: 'promyshlennye-pylesosy' },
];

function transform(quiz) {
  const typeStep = (quiz.steps || []).find(s => s.key === 'type');
  const subtypeStep = (quiz.steps || []).find(s => s.key === 'subtype');
  if (!typeStep || !subtypeStep) throw new Error('не нашёл шаги "type"/"subtype" — структура квиза отличается от ожидаемой');
  const cleanOptions = typeStep.optionsByBranch && typeStep.optionsByBranch.clean;
  if (!cleanOptions) throw new Error('не нашёл ветку "clean" на 2-м шаге');

  let changed = false;

  // Если под клинингом пункт пылесосов сейчас на общем id "pylesos" (делит подкатегории
  // с автомойкой) — переводим именно его на "pylesos_klining". Если такого пункта нет
  // вовсе — просто добавляем.
  let idx = cleanOptions.findIndex(o => o.id === 'pylesos');
  if (idx === -1) idx = cleanOptions.findIndex(o => o.id === 'pylesos_klining');

  if (idx === -1) {
    cleanOptions.unshift({ id: 'pylesos_klining', label: 'Пылесосы' });
    changed = true;
  } else if (cleanOptions[idx].id !== 'pylesos_klining') {
    cleanOptions[idx] = { id: 'pylesos_klining', label: cleanOptions[idx].label || 'Пылесосы' };
    changed = true;
  }

  subtypeStep.optionsByBranch = subtypeStep.optionsByBranch || {};
  const current = JSON.stringify(subtypeStep.optionsByBranch.pylesos_klining || null);
  const wanted = JSON.stringify(KLINING_PYLESOS_OPTIONS);
  if (current !== wanted) {
    subtypeStep.optionsByBranch.pylesos_klining = KLINING_PYLESOS_OPTIONS;
    changed = true;
  }

  return changed ? quiz : null;
}

(async () => {
  console.log(APPLY ? 'Режим: ПРИМЕНИТЬ изменения' : 'Режим: сухой прогон (ничего не меняю, только показываю)');
  console.log('');

  let settings;
  try {
    const r = await fetch(`${SITE}/api/admin/settings`, { headers: { 'x-admin-token': TOKEN } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    settings = await r.json();
  } catch (e) {
    console.error('Не удалось получить текущие настройки:', e.message);
    process.exit(1);
  }
  if (!settings.quiz) { console.error('В настройках нет quiz — нечего менять.'); process.exit(1); }

  let updated;
  try {
    updated = transform(settings.quiz);
  } catch (e) {
    console.error('Ошибка: ' + e.message);
    process.exit(1);
  }
  if (!updated) { console.log('Итого: изменений не найдено — уже всё верно.'); return; }

  console.log('Ветка "clean" на 2-м шаге станет:');
  console.log(JSON.stringify(updated.steps.find(s => s.key === 'type').optionsByBranch.clean, null, 2));
  console.log('');
  console.log('Новая ветка 3-го шага "pylesos_klining":');
  console.log(JSON.stringify(updated.steps.find(s => s.key === 'subtype').optionsByBranch.pylesos_klining, null, 2));
  console.log('');

  if (!APPLY) { console.log('Чтобы применить — добавьте APPLY=1'); return; }

  try {
    const r = await fetch(`${SITE}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ quiz: updated }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    console.log('Готово: сохранено.');
  } catch (e) {
    console.error('Не удалось сохранить:', e.message);
    process.exit(1);
  }
})();
