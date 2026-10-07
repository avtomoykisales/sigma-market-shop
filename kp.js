/* ============================================================
   Коммерческое предложение (КП) — PDF, собирается на лету из
   данных товара, в том же виде, что и шаблон Word, которым
   компания пользовалась раньше (реквизиты в шапке + таблица).
   Шрифт — PT Sans (SIL OFL, кириллица), fonts/PTSans-*.ttf —
   стандартные шрифты PDFKit кириллицу не умеют.
   ============================================================ */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const Jimp = require('jimp');

const FONT_REGULAR = path.join(__dirname, 'fonts/PTSans-Regular.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts/PTSans-Bold.ttf');
const LOGO = path.join(__dirname, 'public/assets/icons/logo.png');
const SIGNATURE = path.join(__dirname, 'public/assets/icons/kp-signature.png');
const STAMP = path.join(__dirname, 'public/assets/icons/kp-stamp.png');

const ORG = {
  legalName: 'ТОО «SIGMA MARKET»',
  address: 'Республика Казахстан, г. Алматы, пр. Рыскулова 103/18Б оф. 202',
  bin: 'БИН 230640010759',
  vatCert: 'Свидетельство о постановке на учет по НДС Серия 60001 №1242626 от 08.06.2023г.',
  phone: 'т/ф. +7 (707) 420-20-03',
  site: 'https://b2btech.kz/',
};

function fmtPrice(n) {
  return Number(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' тенге';
}

// kpCfg = { freeDeliveryThreshold } из настроек (админка → Вовлечённость → КП)
function freeDeliveryThreshold(kpCfg) {
  return Number(kpCfg && kpCfg.freeDeliveryThreshold) || 1000000;
}
function deliveryText(price, kpCfg) {
  if (price && price >= freeDeliveryThreshold(kpCfg)) return 'Бесплатная доставка в пределах РК';
  return 'Стоимость доставки зависит от транспортной компании';
}

const PAGE_LEFT = 50, PAGE_RIGHT = 545;
const COL1_W = 190; // ширина колонки-подписи в таблице
const ICONS_DIR = path.join(__dirname, 'public/icons');
const IMG_ROW_H = 160;

// Загруженные фото встречаются в разных форматах, иногда даже с неверным расширением
// (напр. webp под видом .jpg) или в форматах без поддержки в PDFKit (.bmp и т.п.) — он
// умеет вставлять только настоящие JPEG/PNG. Поэтому всегда пере-кодируем в PNG на лету,
// не полагаясь на расширение файла. sharp — быстрый основной путь (jpeg/png/webp/gif/
// tiff/avif), но не умеет читать .bmp вовсе — для него и прочих редких случаев резервный
// вариант через jimp (медленнее, зато понимает и bmp).
async function toPngBuffer(filePath) {
  try { return await sharp(filePath).png().toBuffer(); } catch {}
  const img = await Jimp.read(filePath);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// Строка таблицы с фото товара вместо текста в правой колонке — как «Образ» в старом
// шаблоне Word. Если файла иконки нет на диске, строку просто не рисуем (без ошибки).
async function tableImageRow(doc, y, iconFilename) {
  if (!iconFilename) return y;
  const filePath = path.join(ICONS_DIR, iconFilename);
  if (!fs.existsSync(filePath)) return y;
  const rowH = IMG_ROW_H;
  doc.rect(PAGE_LEFT, y, PAGE_RIGHT - PAGE_LEFT, rowH).stroke('#cccccc');
  doc.moveTo(PAGE_LEFT + COL1_W, y).lineTo(PAGE_LEFT + COL1_W, y + rowH).stroke('#cccccc');
  doc.font('regular').fontSize(10).fillColor('#000').text('Образец', PAGE_LEFT + 8, y + 5, { width: COL1_W - 12 });
  try {
    const buffer = await toPngBuffer(filePath);
    doc.image(buffer, PAGE_LEFT + COL1_W + 8, y + 8, {
      fit: [PAGE_RIGHT - PAGE_LEFT - COL1_W - 16, rowH - 16], align: 'center', valign: 'center',
    });
  } catch {}
  return y + rowH;
}

// Одна строка таблицы: подпись слева, значение справа, с рамкой. spanLabel — строка
// на всю ширину без второй колонки (для "Технические характеристики" как разделителя).
function tableRow(doc, y, label, value, opts) {
  opts = opts || {};
  doc.font(opts.boldLabel ? 'bold' : 'regular').fontSize(10);
  const valueW = PAGE_RIGHT - PAGE_LEFT - COL1_W - 16;
  const labelH = doc.heightOfString(label, { width: COL1_W - 12 });
  const valueH = opts.spanLabel ? 0 : doc.font(opts.boldValue === false ? 'regular' : 'bold').heightOfString(String(value), { width: valueW });
  const rowH = Math.max(labelH, valueH, 16) + 10;

  doc.rect(PAGE_LEFT, y, PAGE_RIGHT - PAGE_LEFT, rowH).stroke('#cccccc');
  if (!opts.spanLabel) doc.moveTo(PAGE_LEFT + COL1_W, y).lineTo(PAGE_LEFT + COL1_W, y + rowH).stroke('#cccccc');

  doc.font(opts.boldLabel ? 'bold' : 'regular').fontSize(10).fillColor('#000')
    .text(label, PAGE_LEFT + 8, y + 5, { width: COL1_W - 12 });
  if (!opts.spanLabel) {
    doc.font(opts.boldValue === false ? 'regular' : 'bold').fontSize(10).fillColor('#000')
      .text(String(value), PAGE_LEFT + COL1_W + 8, y + 5, { width: valueW });
  }
  return y + rowH;
}

async function buildProductKpPdf(res, product, kpCfg) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.registerFont('regular', FONT_REGULAR);
  doc.registerFont('bold', FONT_BOLD);
  doc.font('regular');

  res.setHeader('Content-Type', 'application/pdf');
  const filename = 'KP_' + String(product.name || 'tovar').replace(/[^a-zA-Zа-яА-Я0-9 ]+/g, '').slice(0, 60).trim().replace(/\s+/g, '_') + '.pdf';
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
  doc.pipe(res);

  // Всё содержимое — в try: если что-то из данных товара приведёт к сбою уже
  // после того как doc.pipe(res) начал отдавать байты клиенту, нужно сразу
  // остановить сам PDF-поток. Иначе pdfkit продолжит асинхронно писать в уже
  // закрытый (после res.end() в server.js) ответ — а это второе, уже ничем не
  // перехватываемое исключение, которое валит весь процесс сервера целиком.
  try {
    // ---- шапка: лого слева, реквизиты компании справа ----
    try { doc.image(LOGO, PAGE_LEFT, 40, { width: 60 }); } catch {}
    doc.font('regular').fontSize(8).fillColor('#888');
    const headerLines = [ORG.legalName, ORG.address, ORG.bin, ORG.vatCert, ORG.phone, ORG.site];
    let hy = 42;
    headerLines.forEach(line => {
      doc.text(line, PAGE_LEFT, hy, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });
      hy += doc.heightOfString(line, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' }) + 2;
    });
    const headerBottom = Math.max(40 + 70, hy + 6);
    doc.moveTo(PAGE_LEFT, headerBottom).lineTo(PAGE_RIGHT, headerBottom).stroke('#000');

    doc.y = headerBottom + 20;
    doc.fillColor('#000').font('regular').fontSize(11);
    doc.text('Уважаемые господа!', PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT, align: 'center' });
    doc.moveDown(0.4);
    doc.text('Компания «SIGMA MARKET» выражает Вам искреннюю признательность за интерес к нашей продукции и сообщает о возможности поставки в Ваш адрес:', { width: PAGE_RIGHT - PAGE_LEFT, align: 'center' });
    doc.moveDown(0.6);

    doc.font('bold').fontSize(12).text(product.name || '', PAGE_LEFT, doc.y, { width: PAGE_RIGHT - PAGE_LEFT, align: 'center' });
    doc.moveDown(0.6);

    // ---- таблица ----
    let y = doc.y;
    if (product.article) y = tableRow(doc, y, 'Модель', product.article);
    if (product.brand) y = tableRow(doc, y, 'Бренд', product.brand);

    let specs = product.specs;
    if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch { specs = {}; } }
    if (specs && Object.keys(specs).length) {
      y = tableRow(doc, y, 'Технические характеристики', '', { spanLabel: true, boldLabel: true });
      Object.entries(specs).forEach(([k, v]) => {
        if (y > 740) { doc.addPage(); y = 50; }
        y = tableRow(doc, y, k, v);
      });
    }
    y = tableRow(doc, y, 'Условия поставки', deliveryText(product.price, kpCfg));
    // Гарантию пишем только если она реально указана в характеристиках товара (тогда
    // она уже попала в таблицу выше вместе со всеми specs) — не выдумываем "12 месяцев"
    // для товаров, где срок гарантии в карточке не заполнен.
    if (y + IMG_ROW_H > 760) { doc.addPage(); y = 50; }
    y = await tableImageRow(doc, y, product.icon);
    doc.y = y + 20;

    // "Стоимость" + подпись с печатью не должны разрываться между страницами — проверяем
    // место под весь блок целиком заранее (а не перед каждым кусочком по отдельности),
    // иначе получается как было: цена остаётся внизу одной страницы, а подпись
    // с печатью одиноко висят на следующей.
    if (doc.y + 220 > 790) doc.addPage();

    doc.font('bold').fontSize(12).text('Стоимость', PAGE_LEFT, doc.y);
    doc.font('regular').fontSize(11).moveDown(0.2);
    doc.text(product.price_on_request || !product.price
      ? 'Цена по запросу — уточняйте у менеджера'
      : fmtPrice(product.price) + ' (с учётом НДС), цена указана до склада транспортной компании');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555').text('Данное предложение действительно в течение 10 календарных дней.');
    doc.moveDown(1.3);

    // ---- подпись и печать ---- (печать внахлёст поверх подписи, как на бумаге)
    const signY = doc.y;
    try { doc.image(SIGNATURE, PAGE_LEFT + 20, signY, { width: 120 }); } catch {}
    try { doc.image(STAMP, PAGE_LEFT + 110, signY - 5, { width: 100 }); } catch {}
    doc.y = signY + 108;

    doc.font('regular').fontSize(9).fillColor('#555');
    doc.text('Документ сформирован автоматически на сайте b2btech.kz, наличие и актуальность предложения уточняйте у менеджера.');

    doc.end();
  } catch (e) {
    doc.unpipe(res);
    try { doc.destroy(); } catch {}
    throw e;
  }
}

module.exports = { buildProductKpPdf };
