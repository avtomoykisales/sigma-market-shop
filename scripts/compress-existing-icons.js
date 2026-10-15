// Разовое сжатие уже загруженных фото в public/icons — та же логика, что теперь
// применяется к новым загрузкам (см. compressUploadedImage в server.js), просто
// прогнанная по всем существующим файлам сразу. Заодно генерирует миниатюры
// ("имя-thumb.ext", до 500px) для карточек каталога — полноразмерная версия (до 1200px)
// остаётся только для страницы товара, где фото открыто крупно.
//
// Без аргументов — сухой прогон (считает, сколько бы сэкономили, ничего не трогает).
// APPLY=1 node scripts/compress-existing-icons.js — реально сжимает/создаёт миниатюры.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ICONS_DIR = path.join(__dirname, '..', 'public/icons');
const APPLY = process.env.APPLY === '1';

function thumbPath(filePath) {
  const ext = path.extname(filePath);
  return filePath.slice(0, -ext.length) + '-thumb' + ext;
}

async function makeThumb(buffer, ext, filePath) {
  try {
    let t = sharp(buffer).resize({ width: 500, height: 500, fit: 'inside', withoutEnlargement: true });
    const tbuf = ext === '.png' ? await t.png({ compressionLevel: 9 }).toBuffer()
      : ext === '.webp' ? await t.webp({ quality: 80 }).toBuffer()
      : await t.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    if (APPLY) fs.writeFileSync(thumbPath(filePath), tbuf);
    return tbuf.length;
  } catch (e) { return 0; }
}

async function compressOne(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'].includes(ext)) return null;
  const before = fs.statSync(filePath).size;
  try {
    let img;
    if (ext === '.bmp') {
      // sharp/libvips BMP не читает вовсе — распаковываем через bmp-js (порядок байт
      // на пиксель у него нестандартный: [A(=0), B, G, R]) и отдаём sharp как raw-буфер.
      try {
        const decoded = require('bmp-js').decode(fs.readFileSync(filePath));
        const raw = decoded.data;
        const rgba = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i += 4) {
          rgba[i] = raw[i + 3]; rgba[i + 1] = raw[i + 2]; rgba[i + 2] = raw[i + 1]; rgba[i + 3] = 255;
        }
        img = sharp(rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
      } catch (bmpErr) {
        // bmp-js понимает только простейший несжатый BMP ("Invalid BMP File" на RLE и
        // прочих вариантах) — как и с PNG под видом .jpg, расширение не гарантия формата:
        // пробуем прочитать как обычную картинку, sharp сам определит реальный формат.
        img = sharp(filePath).rotate();
      }
    } else {
      img = sharp(filePath).rotate();
    }
    const meta = await img.metadata();
    if ((meta.width || 0) > 1200 || (meta.height || 0) > 1200) {
      img = img.resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true });
    }
    const willBeJpeg = ext !== '.png' && ext !== '.webp';
    if (meta.hasAlpha && willBeJpeg) img = img.flatten({ background: '#ffffff' });
    const buffer = ext === '.png' ? await img.png({ compressionLevel: 9 }).toBuffer()
      : ext === '.webp' ? await img.webp({ quality: 82 }).toBuffer()
      : await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const willWriteFull = buffer.length < before;
    if (APPLY && willWriteFull) fs.writeFileSync(filePath, buffer);
    const thumbSize = await makeThumb(buffer, ext, filePath);
    return { before, after: willWriteFull ? buffer.length : before, thumbSize };
  } catch (e) {
    console.error('  ошибка:', path.basename(filePath), e.message);
    return null;
  }
}

async function main() {
  const files = fs.readdirSync(ICONS_DIR).filter(f => !f.startsWith('.') && !/-thumb\.[a-z]+$/i.test(f));
  let totalBefore = 0, totalAfter = 0, totalThumbs = 0, changed = 0, skipped = 0;
  for (const f of files) {
    const full = path.join(ICONS_DIR, f);
    if (!fs.statSync(full).isFile()) continue;
    const r = await compressOne(full);
    if (!r) { skipped++; continue; }
    totalBefore += r.before;
    totalAfter += r.after;
    totalThumbs += r.thumbSize || 0;
    if (r.after < r.before) changed++;
  }
  const savedMb = ((totalBefore - totalAfter) / 1024 / 1024).toFixed(1);
  const beforeMb = (totalBefore / 1024 / 1024).toFixed(1);
  const afterMb = (totalAfter / 1024 / 1024).toFixed(1);
  const thumbsMb = (totalThumbs / 1024 / 1024).toFixed(1);
  console.log(`\n${APPLY ? 'Применено' : 'Сухой прогон (ничего не изменено)'}:`);
  console.log(`  Файлов обработано: ${files.length - skipped}, сжато: ${changed}, пропущено (не фото): ${skipped}`);
  console.log(`  Было: ${beforeMb} МБ → Стало: ${afterMb} МБ (экономия ${savedMb} МБ)`);
  console.log(`  Миниатюры (для карточек каталога): ${thumbsMb} МБ`);
  if (!APPLY) console.log('\n  Для реального применения: APPLY=1 node scripts/compress-existing-icons.js');
}

main();
