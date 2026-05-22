#!/usr/bin/env node
/**
 * Economist Weekly Delivery
 * Downloads latest EPUB, splits into 6 daily EPUBs (Sun–Fri).
 * Each daily EPUB keeps original formatting, images, and cover.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const WORKSPACE = process.env.GITHUB_WORKSPACE || path.join(__dirname, '..');
const DATA_DIR = path.join(WORKSPACE, 'data');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');
const BATCHES = 6;

// ─── Utility ───────────────────────────────────────────

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']'));
  return m ? m[1] : null;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getLastSaturday() {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 6 ? 0 : day + 1));
  return d.toISOString().slice(0, 10).replace(/-/g, '.');
}

function getBatchDate(batchIdx) {
  const sat = new Date();
  const day = sat.getUTCDay();
  sat.setUTCDate(sat.getUTCDate() - (day === 6 ? 0 : day + 1));
  sat.setUTCDate(sat.getUTCDate() + 1 + batchIdx);
  return sat.toISOString().slice(0, 10);
}

// ─── Download ──────────────────────────────────────────

function download(url) {
  return new Promise((resolve, reject) => {
    const go = (u, n = 0) => {
      if (n > 10) return reject(new Error('Too many redirects'));
      (u.startsWith('https') ? https : http).get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return go(res.headers.location, n + 1);
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        const buf = [];
        res.on('data', c => buf.push(c));
        res.on('end', () => resolve(Buffer.concat(buf)));
      }).on('error', reject);
    };
    go(url);
  });
}

// ─── EPUB Parsing ──────────────────────────────────────

function parseManifest(xml) {
  const map = {};
  for (const m of xml.matchAll(/<item\s+([^>]+?)\s*\/?>/g)) {
    const id = attr(m[1], 'id');
    const href = attr(m[1], 'href');
    const mt = attr(m[1], 'media-type');
    if (id && href) map[id] = { href, mediaType: mt || '' };
  }
  return map;
}

function parseSpine(xml) {
  const arr = [];
  for (const m of xml.matchAll(/<itemref\s+([^>]+?)\s*\/?>/g)) {
    const idref = attr(m[1], 'idref');
    if (idref) arr.push(idref);
  }
  return arr;
}

function parseCoverId(xml) {
  let m = xml.match(/name\s*=\s*"cover"[^>]*content\s*=\s*"([^"]+)"/);
  if (m) return m[1];
  m = xml.match(/content\s*=\s*"([^"]+)"[^>]*name\s*=\s*"cover"/);
  if (m) return m[1];
  return null;
}

function parseTocNcx(xml) {
  const re = /<navPoint\b[^>]*>((?:(?!<navPoint\b)[\s\S])*?)<\/navPoint>/g;
  const points = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const label = m[1].match(/<text[^>]*>([\s\S]*?)<\/text>/);
    const src = m[1].match(/<content[^>]*src\s*=\s*"([^"]+)"/);
    if (label && src) points.push({ label: label[1].trim(), src: src[1].trim() });
  }
  return points;
}

function extractImageSrcs(html) {
  const srcs = [];
  // Match src="..." and src='...' for images (broader extension support)
  for (const m of html.matchAll(/src\s*=\s*["']([^"']+\.(jpe?g|png|gif|svg|webp|bmp|tiff?))["']/gi))
    srcs.push(m[1]);
  // Also match srcset attributes (responsive images)
  for (const m of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const entry of m[1].split(',')) {
      const url = entry.trim().split(/\s+/)[0];
      if (url.match(/\.(jpe?g|png|gif|svg|webp|bmp|tiff?)($|\?)/i)) srcs.push(url);
    }
  }
  return srcs;
}

async function parseEpubStructure(zip) {
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const opfRel = containerXml.match(/full-path\s*=\s*"([^"]+)"/)?.[1] || 'OEBPS/content.opf';
  const opfDir = path.posix.dirname(opfRel);

  const opfXml = await zip.file(opfRel).async('string');
  const manifest = parseManifest(opfXml);
  const spine = parseSpine(opfXml);
  const coverId = parseCoverId(opfXml);

  let tocRel = null;
  for (const [, item] of Object.entries(manifest)) {
    if (item.href.endsWith('.ncx')) { tocRel = path.posix.join(opfDir, item.href); break; }
  }

  let tocPoints = [];
  if (tocRel && zip.file(tocRel)) {
    const tocXml = await zip.file(tocRel).async('string');
    tocPoints = parseTocNcx(tocXml);
  }

  // Map tocPoints → spine indices
  for (const pt of tocPoints) {
    const srcFile = pt.src.split('#')[0];
    for (const [id, item] of Object.entries(manifest)) {
      if (item.href === srcFile) { pt.idref = id; pt.spineIndex = spine.indexOf(id); break; }
    }
  }
  tocPoints = tocPoints.filter(pt => pt.spineIndex >= 0);

  return { opfDir, opfRel, tocRel, manifest, spine, coverId, tocPoints };
}

// ─── Collect image refs from an HTML file ──────────────
// FIX: Use path.posix.join() instead of path.posix.resolve() to avoid absolute path issues

async function collectImageRefs(zip, manifest, opfDir, idref, keepSet) {
  const item = manifest[idref];
  if (!item) return;
  const htmlPath = path.posix.join(opfDir, item.href);
  const f = zip.file(htmlPath);
  if (!f) return;
  const html = await f.async('string');
  for (const src of extractImageSrcs(html)) {
    // Resolve relative to the HTML file's directory (relative to OPF dir)
    const resolved = path.posix.join(path.posix.dirname(item.href), src);
    keepSet.add(path.posix.join(opfDir, resolved));
  }
}

// ─── Create Daily EPUB ─────────────────────────────────

async function createDailyEpub(fullZip, struct, batchPoints, dayNum) {
  const { opfDir, opfRel, tocRel, manifest, spine, coverId } = struct;

  // Start from a fresh copy of the full ZIP
  const zip = await JSZip.loadAsync(await fullZip.generateAsync({ type: 'nodebuffer' }));

  // Determine pre-article boundary (first article's spine index)
  const firstArtIdx = batchPoints.length > 0 ? Math.min(...batchPoints.map(p => p.spineIndex)) : 0;

  // Build set of spine IDs to keep
  const keepIds = new Set();
  for (let i = 0; i < firstArtIdx; i++) keepIds.add(spine[i]);           // pre-article
  for (const pt of batchPoints) keepIds.add(pt.idref);                     // batch articles
  if (coverId && manifest[coverId]) keepIds.add(coverId);                  // cover image

  // Build set of file paths to keep
  const keep = new Set(['mimetype', 'META-INF/container.xml', opfRel]);
  if (tocRel) keep.add(tocRel);

  for (const id of keepIds) {
    const item = manifest[id];
    if (item) keep.add(path.posix.join(opfDir, item.href));
  }

  // CSS + fonts (small, safe to include all)
  for (const [, item] of Object.entries(manifest)) {
    const mt = (item.mediaType || '').toLowerCase();
    if (mt.includes('css') || mt.includes('font') || mt.includes('woff') || mt.includes('ttf') || mt.includes('otf'))
      keep.add(path.posix.join(opfDir, item.href));
  }

  // Images referenced by kept HTML files
  for (const id of keepIds) await collectImageRefs(zip, manifest, opfDir, id, keep);

  // Remove files not in keep set
  for (const f of Object.keys(zip.files)) {
    if (!keep.has(f)) zip.remove(f);
  }

  // ── Rewrite OPF spine ──
  let opfXml = await zip.file(opfRel).async('string');
  const newSpineIds = [...spine.slice(0, firstArtIdx), ...batchPoints.map(p => p.idref)];
  const newSpine = newSpineIds.map(id => `      <itemref idref="${id}"/>`).join('\n');
  opfXml = opfXml.replace(/<spine[^>]*>[\s\S]*?<\/spine>/, `<spine>\n${newSpine}\n    </spine>`);
  zip.file(opfRel, opfXml);

  // ── Rewrite toc.ncx navMap ──
  if (tocRel) {
    let tocXml = await zip.file(tocRel).async('string');
    let order = 1;
    const navPts = batchPoints.map(pt =>
      `    <navPoint id="np-${dayNum}-${order}" playOrder="${order++}">\n` +
      `      <navLabel><text>${escXml(pt.label)}</text></navLabel>\n` +
      `      <content src="${pt.src}"/>\n` +
      `    </navPoint>`
    ).join('\n');
    tocXml = tocXml.replace(/<navMap>[\s\S]*?<\/navMap>/, `<navMap>\n${navPts}\n  </navMap>`);
    tocXml = tocXml.replace(/<meta name="dtb:depth" content="[^"]*"/, '<meta name="dtb:depth" content="1"');
    zip.file(tocRel, tocXml);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

// ─── Main ──────────────────────────────────────────────

async function main() {
  console.log('=== Economist Weekly Delivery ===');

  const satDate = getLastSaturday();
  console.log('Issue date:', satDate);

  const url = `https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_${satDate}/TheEconomist.${satDate}.epub`;
  console.log('Downloading:', url);

  const epubBuf = await download(url);
  console.log(`Downloaded: ${(epubBuf.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = await JSZip.loadAsync(epubBuf);
  const struct = await parseEpubStructure(zip);
  console.log(`OPF: ${struct.opfRel}`);
  console.log(`TOC: ${struct.tocRel}`);
  console.log(`Articles: ${struct.tocPoints.length}`);
  console.log(`Spine: ${struct.spine.length} items`);
  console.log(`Cover: ${struct.coverId}`);

  if (struct.tocPoints.length === 0) {
    console.error('No articles found in toc.ncx');
    process.exit(1);
  }

  // Split into batches
  const n = Math.min(BATCHES, struct.tocPoints.length);
  const per = Math.ceil(struct.tocPoints.length / n);
  const batches = [];
  for (let i = 0; i < n; i++) batches.push(struct.tocPoints.slice(i * per, Math.min((i + 1) * per, struct.tocPoints.length)));
  console.log(`Batches: ${batches.map(b => b.length).join('/')}`);

  // Prepare dirs
  const issueDir = path.join(DATA_DIR, 'issues', satDate);
  fs.mkdirSync(issueDir, { recursive: true });

  // Save full EPUB
  fs.writeFileSync(path.join(issueDir, 'full.epub'), epubBuf);

  // Create daily EPUBs
  const schedBatches = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const dayDate = getBatchDate(i);
    const fileName = `day-${i + 1}.epub`;
    console.log(`\nDay ${i + 1} (${dayNames[i]} ${dayDate}): ${batch.length} articles`);

    try {
      const dayBuf = await createDailyEpub(zip, struct, batch, i + 1);
      fs.writeFileSync(path.join(issueDir, fileName), dayBuf);
      console.log(`  Saved: ${(dayBuf.length / 1024 / 1024).toFixed(2)} MB`);

      schedBatches[dayDate] = {
        issue: satDate,
        dayNum: i + 1,
        file: `data/issues/${satDate}/${fileName}`,
        sent: false,
        articles: batch.map(a => a.label)
      };
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
  }

  // Save schedule
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const scheduleData = {
    currentIssue: satDate,
    batches: schedBatches,
    lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleData, null, 2));

  // Save article metadata
  fs.writeFileSync(
    path.join(issueDir, 'articles.json'),
    JSON.stringify(struct.tocPoints.map(a => ({ title: a.label, src: a.src })), null, 2)
  );

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
