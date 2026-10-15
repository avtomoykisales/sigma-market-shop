// Переносит 4 варианта пылесосов со 2-го шага квиза ("Какое оборудование интересует?")
// на новый 3-й шаг под одним пунктом "Пылесосы" — так же, как уже устроено для
// "Аппараты высокого давления" и "Автоматические мойки". Берёт ТЕКУЩУЮ живую настройку
// квиза с сайта (а не перезаписывает её целиком местной копией) — чтобы не потерять
// то, что могло быть донастроено через админку отдельно от кода.
//
// По умолчанию ничего не меняет — только показывает, что сделал бы (сухой прогон).
//
// Запуск (в терминале, токен нигде не сохраняется в файлах):
//   ADMIN_TOKEN='логин:пароль' node scripts/restructure-quiz-pylesosy.js            — показать
//   ADMIN_TOKEN='логин:пароль' APPLY=1 node scripts/restructure-quiz-pylesosy.js    — применить
// По умолчанию бьёт в https://b2btech.kz — можно переопределить SITE_URL.

const SITE = process.env.SITE_URL || 'https://b2btech.kz';
const TOKEN = process.env.ADMIN_TOKEN;
const APPLY = process.env.APPLY === '1';
if (!TOKEN) {
  console.error('Укажите токен: ADMIN_TOKEN=\'логин:пароль\' node scripts/restructure-quiz-pylesosy.js');
  process.exit(1);
}

const PYLESOS_IDS = ['pylesos_vac', 'pylesos_extr', 'pylesos_steam', 'pylesos_prom'];

function transform(quiz) {
  const typeStep = (quiz.steps || []).find(s => s.key === 'type');
  const subtypeStep = (quiz.steps || []).find(s => s.key === 'subtype');
  if (!typeStep || !subtypeStep) {
    throw new Error('не нашёл шаги "type"/"subtype" в текущей настройке квиза — структура отличается от ожидаемой, нужна ручная правка в админке');
  }
  const washOptions = typeStep.optionsByBranch && typeStep.optionsByBranch.wash;
  if (!washOptions) throw new Error('не нашёл ветку "wash" на 2-м шаге');

  const pylesosOptions = washOptions.filter(o => PYLESOS_IDS.includes(o.id));
  if (!pylesosOptions.length) {
    console.log('На 2-м шаге уже нет отдельных пунктов пылесосов — похоже, изменения уже применены (или структура другая). Ничего не делаю.');
    return null;
  }

  const insertAt = washOptions.findIndex(o => PYLESOS_IDS.includes(o.id));
  const newWash = washOptions.filter(o => !PYLESOS_IDS.includes(o.id));
  newWash.splice(insertAt, 0, { id: 'pylesos', label: 'Пылесосы' });
  typeStep.optionsByBranch.wash = newWash;

  subtypeStep.optionsByBranch = subtypeStep.optionsByBranch || {};
  subtypeStep.optionsByBranch.pylesos = pylesosOptions;

  return quiz;
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
  if (!updated) { console.log('Итого: изменений не найдено.'); return; }

  console.log('До:   2-й шаг (wash) содержал отдельные пункты: ' + PYLESOS_IDS.join(', '));
  console.log('После: 2-й шаг (wash) — один пункт "Пылесосы", эти 4 варианта — на 3-м шаге.');
  console.log('');
  console.log(JSON.stringify(updated.steps.find(s => s.key === 'subtype').optionsByBranch.pylesos, null, 2));
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
