// Чистит "мусор" от вставки из Word (невидимую служебную MSO/XML-разметку) в полях
// "Описание" категорий, подкатегорий и товаров — через тот же admin API, что и
// scripts/apply-descriptions.js. Реальный видимый текст и структура (заголовки,
// абзацы, списки) не трогаются — убирается только то, что не видно на экране.
//
// По умолчанию ничего не меняет — только показывает, что бы изменилось (сухой прогон).
// Чтобы применить по-настоящему, добавьте APPLY=1.
//
// Запуск (в терминале, токен нигде не сохраняется в файлах):
//   ADMIN_TOKEN='логин:пароль' node scripts/clean-word-descriptions.js            — показать, что найдено
//   ADMIN_TOKEN='логин:пароль' APPLY=1 node scripts/clean-word-descriptions.js    — применить
// По умолчанию бьёт в https://b2btech.kz — можно переопределить SITE_URL.

const SITE = process.env.SITE_URL || 'https://b2btech.kz';
const TOKEN = process.env.ADMIN_TOKEN;
const APPLY = process.env.APPLY === '1';
if (!TOKEN) {
  console.error('Укажите токен: ADMIN_TOKEN=\'логин:пароль\' node scripts/clean-word-descriptions.js');
  process.exit(1);
}

// Признаки того, что текст тащит за собой мусор от вставки из Word/Office.
const DIRTY_RE = /mso-|xmlns:o=|<o:p|w:WordDocument|class="?Mso|<!--\[if[^\]]*mso/i;

function cleanWordHtml(html) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');                      // комментарии, вкл. <!--[if gte mso 9]>...<![endif]-->
  h = h.replace(/<xml>[\s\S]*?<\/xml>/gi, '');                 // <xml><o:DocumentProperties>...
  h = h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');        // служебные CSS-классы Word
  h = h.replace(/<\/?[ovwm]:[a-zA-Z]+(?:\s[^>]*)?\/?>/gi, ''); // <o:p>, <w:WordDocument>, <v:shape> и т.п.
  h = h.replace(/<\/?html[^>]*>/gi, '').replace(/<\/?body[^>]*>/gi, '').replace(/<head>[\s\S]*?<\/head>/gi, '');
  h = h.replace(/\s(class|style|lang|align)="[^"]*"/gi, '');   // мусорные атрибуты (mso-*, MsoNormal и т.п.)
  h = h.replace(/<\/?span[^>]*>/gi, '');                       // span — почти всегда обёртка от Word
  h = h.replace(/ /g, ' ');                                // неразрывные пробелы из Word → обычные
  h = h.replace(/<p>\s*<\/p>/gi, '').replace(/\s{2,}/g, ' ');
  h = h.replace(/>\s+</g, '><').trim();
  return h;
}

async function fetchJson(path) {
  const r = await fetch(`${SITE}${path}`, { headers: { 'x-admin-token': TOKEN } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function put(path, body) {
  const r = await fetch(`${SITE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const kinds = [
    { label: 'категории', list: '/api/admin/categories', put: id => `/api/admin/categories/${id}` },
    { label: 'подкатегории', list: '/api/admin/subcategories', put: id => `/api/admin/subcategories/${id}` },
    { label: 'товары', list: '/api/admin/products?limit=100000', put: id => `/api/admin/products/${id}`,
      unwrap: data => data.products || data },
  ];

  console.log(APPLY ? 'Режим: ПРИМЕНИТЬ изменения' : 'Режим: сухой прогон (ничего не меняю, только показываю)');
  console.log('');

  let totalFound = 0, totalApplied = 0, totalFailed = 0;

  for (const kind of kinds) {
    let rows;
    try {
      const data = await fetchJson(kind.list);
      rows = kind.unwrap ? kind.unwrap(data) : data;
    } catch (e) {
      console.error(`Не удалось получить список "${kind.label}": ${e.message}`);
      continue;
    }
    const dirty = (rows || []).filter(r => r.description && DIRTY_RE.test(r.description));
    if (!dirty.length) { console.log(`${kind.label}: мусора не найдено`); continue; }

    console.log(`${kind.label}: найдено ${dirty.length} с мусором от Word`);
    for (const row of dirty) {
      const before = row.description.length;
      const cleaned = cleanWordHtml(row.description);
      const after = cleaned.length;
      console.log(`  #${row.id} "${(row.name || '').slice(0, 50)}" — ${before} → ${after} байт`);
      totalFound++;
      if (APPLY) {
        try {
          await put(kind.put(row.id), { description: cleaned });
          totalApplied++;
        } catch (e) {
          totalFailed++;
          console.error(`    ошибка сохранения #${row.id}: ${e.message}`);
        }
        await sleep(150); // не долбим сервер слишком часто
      }
    }
    console.log('');
  }

  console.log(`Итого: найдено ${totalFound}` + (APPLY ? `, сохранено ${totalApplied}, ошибок ${totalFailed}` : ' (чтобы применить — добавьте APPLY=1)'));
})();
