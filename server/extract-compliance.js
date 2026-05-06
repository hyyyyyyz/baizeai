// 把 ../产品合规数据来源/*.docx 抽成纯文本 + 统计
// 用法：cd server && node extract-compliance.js
import mammoth from 'mammoth';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR  = path.resolve(__dirname, '..', '产品合规数据来源');
const OUT_DIR  = path.resolve(__dirname, 'compliance');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('~$')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function safeBasename(s) {
  // Keep CJK + alnum + dash, replace others with '_'
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function countImages(buffer) {
  // Crude: count occurrences of "word/media/" inside the docx zip
  const s = buffer.toString('binary');
  const m = s.match(/word\/media\/image\d+/g);
  if (!m) return 0;
  return new Set(m).size;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const files = [];
  for await (const fp of walk(SRC_DIR)) {
    if (!fp.toLowerCase().endsWith('.docx')) continue;
    files.push(fp);
  }
  files.sort();
  console.log(`Found ${files.length} .docx files in ${SRC_DIR}`);

  const manifest = { generatedAt: new Date().toISOString(), files: [] };
  let totalChars = 0, totalImg = 0;
  let i = 0;

  for (const fp of files) {
    i++;
    const rel = path.relative(SRC_DIR, fp);
    const base = safeBasename(rel.replace(/\.docx$/i, '').replace(/[/\\]/g, '__'));
    const outTxt = path.join(OUT_DIR, base + '.txt');

    try {
      const buf = await readFile(fp);
      const imgCount = countImages(buf);

      // Extract plain text — drop image elements entirely
      const result = await mammoth.extractRawText({ buffer: buf });
      let text = (result.value || '').trim();
      // Collapse 3+ newlines to 2
      text = text.replace(/\n{3,}/g, '\n\n');

      const headLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
      const fileHeader = `【文档】${rel.replace(/\.docx$/i, '')}\n\n${text}\n`;

      await writeFile(outTxt, fileHeader, 'utf8');

      manifest.files.push({
        sourceRel: rel,
        sourceFile: path.basename(fp),
        textFile: path.basename(outTxt),
        chars: text.length,
        images: imgCount,
        firstLine: headLine.slice(0, 80),
        warnings: result.messages.filter((m) => m.type === 'warning').slice(0, 3).map((m) => m.message),
      });
      totalChars += text.length;
      totalImg += imgCount;

      const flag = imgCount > 5 ? ' ⚠️ 图多' : (imgCount === 0 ? ' ✓' : '');
      console.log(`[${i}/${files.length}] ${rel}  文字 ${text.length} 字 · 图片 ${imgCount} 张${flag}`);
    } catch (e) {
      console.error(`[${i}/${files.length}] FAIL ${rel}: ${e.message}`);
      manifest.files.push({ sourceRel: rel, error: e.message });
    }
  }

  manifest.summary = {
    totalFiles: files.length,
    totalChars,
    totalImages: totalImg,
    avgChars: Math.round(totalChars / files.length),
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n=== 汇总 ===');
  console.log(`文件数：${files.length}`);
  console.log(`总字数：${totalChars.toLocaleString()}`);
  console.log(`总图片：${totalImg}`);
  console.log(`平均字数：${Math.round(totalChars / files.length).toLocaleString()}`);
  console.log(`输出：${OUT_DIR}`);

  // 图多的报告
  const heavyImg = manifest.files.filter((f) => f.images >= 5).sort((a, b) => b.images - a.images);
  if (heavyImg.length) {
    console.log('\n=== 图片较多（5 张以上），可能丢关键信息 ===');
    for (const f of heavyImg) console.log(`  ${f.images} 张 — ${f.sourceRel}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
