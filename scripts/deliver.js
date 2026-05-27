#!/usr/bin/env node
/**
 * Journal Weekly Delivery
 * Downloads latest EPUB for a specified magazine, splits into chunks of ≤10 articles each.
 * Supports: economist, new_yorker, atlantic, wired
 *
 * Usage:
 *   node deliver.js <magazine> [date]
 *   magazine: economist | new_yorker | atlantic | wired
 *   date: optional specific date (e.g. 2026.05.25). If omitted, finds latest unfetched issue.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const WORKSPACE = process.env.GITHUB_WORKSPACE || path.join(__dirname, '..');
const DATA_DIR = path.join(WORKSPACE, 'data');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');
const FETCHED_PATH = path.join(DATA_DIR, 'fetched.json');
const ARTICLES_PER_EPUB = 10;

// ─── Magazine Configuration ────────────────────────────

const MAGAZINES = {
  economist: {
    dir: '01_economist',
    folderPrefix: 'te_',
    filePattern: 'TheEconomist.{date}.epub',
    displayName: 'The Economist'
  },
  new_yorker: {
    dir: '02_new_yorker',
    folderPrefix: '',
    filePattern: 'new_yorker.{date}.epub',
    displayName: 'New Yorker'
  },
  atlantic: {
    dir: '04_atlantic',
    folderPrefix: '',
    filePattern: 'Atlantic_{date}.epub',
    displayName: 'The Atlantic'
  },
  wired: {
    dir: '05_wired',
    folderPrefix: '',
    filePattern: 'wired_{date}.epub',
    displayName: 'Wired'
  }
};

// ─── Utility ───────────────────────────────────────────

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']'));
  return m ? m[1] : null;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── GitHub API helpers ────────────────────────────────

function githubGet(apiPath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'User-Agent': 'node',
        'Authorization': `token ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * List date folders for a magazine from awesome-english-ebooks
 * Returns array of date strings like ['2026.05.23', '2026.05.16', ...]
 */
async function listIssueDates(magKey) {
  const mag = MAGAZINES[magKey];
  const data = await githubGet(`/repos/hehonghui/awesome-english-ebooks/contents/${mag.dir}?ref=master`);
  if (!Array.isArray(data)) throw new Error(`Failed to list ${mag.dir}: ${JSON.stringify(data).slice(0, 200)}`);
  const dirs = data
    .filter(x => x.type === 'dir')
    .map(x => x.name)
    // Filter out non-date dirs (like 'fonts', '2025')
    .filter(name => /^\d{4}\.\d{2}\.\d{2}$/.test(name) || /^te_\d{4}\.\d{2}\.\d{2}$/.test(name))
    .sort()
    .reverse(); // newest first
  return dirs;
}

/**
 * Find the latest issue date that hasn't been fetched yet
 */
async function findLatestUnfetched(magKey) {
  const dates = await listIssueDates(magKey);
  const fetched = loadFetched();
  const fetchedDates = (fetched[magKey] || []).map(f => f.date);

  for (const dateDir of dates) {
    // Extract date from folder name (remove prefix like 'te_')
    const date = dateDir.replace(/^te_/, '');
    if (!fetchedDates.includes(date)) {
      return date;
    }
  }
  return null; // all fetched
}

// ─── Fetched tracking ──────────────────────────────────

function loadFetched() {
  if (fs.existsSync(FETCHED_PATH)) {
    return JSON.parse(fs.readFileSync(FETCHED_PATH, 'utf8'));
  }
  return {};
}

function saveFetched(fetched) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FETCHED_PATH, JSON.stringify(fetched, null, 2));
}

// ─── Schedule ──────────────────────────────────────────

function loadSchedule() {
  if (fs.existsSync(SCHEDULE_PATH)) {
    return JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  }
  return { magazines: {}, lastUpdated: null };
}

function saveSchedule(schedule) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  schedule.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2));
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
  for (const m of html.matchAll(/src\s*=\s*["']([^"']+\.(jpe?g|png|gif|svg|webp|bmp|tiff?))["']/gi))
    srcs.push(m[1]);
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

  for (const pt of tocPoints) {
    const srcFile = pt.src.split('#')[0];
    for (const [id, item] of Object.entries(manifest)) {
      if (item.href === srcFile) { pt.idref = id; pt.spineIndex = spine.indexOf(id); break; }
    }
  }
  tocPoints = tocPoints.filter(pt => pt.spineIndex >= 0);

  return { opfDir, opfRel, tocRel, manifest, spine, coverId, tocPoints };
}

async function collectImageRefs(zip, manifest, opfDir, idref, keepSet) {
  const item = manifest[idref];
  if (!item) return;
  const htmlPath = path.posix.join(opfDir, item.href);
  const f = zip.file(htmlPath);
  if (!f) return;
  const html = await f.async('string');
  for (const src of extractImageSrcs(html)) {
    const resolved = path.posix.join(path.posix.dirname(item.href), src);
    keepSet.add(path.posix.join(opfDir, resolved));
  }
}

// ─── Create Chunk EPUB ─────────────────────────────────

async function createChunkEpub(fullZip, struct, batchPoints, chunkNum) {
  const { opfDir, opfRel, tocRel, manifest, spine, coverId } = struct;

  const zip = await JSZip.loadAsync(await fullZip.generateAsync({ type: 'nodebuffer' }));

  const firstArtIdx = batchPoints.length > 0 ? Math.min(...batchPoints.map(p => p.spineIndex)) : 0;

  const keepIds = new Set();
  for (let i = 0; i < firstArtIdx; i++) keepIds.add(spine[i]);
  for (const pt of batchPoints) keepIds.add(pt.idref);
  if (coverId && manifest[coverId]) keepIds.add(coverId);

  const keep = new Set(['mimetype', 'META-INF/container.xml', opfRel]);
  if (tocRel) keep.add(tocRel);

  for (const id of keepIds) {
    const item = manifest[id];
    if (item) keep.add(path.posix.join(opfDir, item.href));
  }

  for (const [, item] of Object.entries(manifest)) {
    const mt = (item.mediaType || '').toLowerCase();
    if (mt.includes('css') || mt.includes('font') || mt.includes('woff') || mt.includes('ttf') || mt.includes('otf'))
      keep.add(path.posix.join(opfDir, item.href));
  }

  for (const id of keepIds) await collectImageRefs(zip, manifest, opfDir, id, keep);

  for (const f of Object.keys(zip.files)) {
    if (!keep.has(f)) zip.remove(f);
  }

  let opfXml = await zip.file(opfRel).async('string');
  const newSpineIds = [...spine.slice(0, firstArtIdx), ...batchPoints.map(p => p.idref)];
  const newSpine = newSpineIds.map(id => `      <itemref idref="${id}"/>`).join('\n');
  opfXml = opfXml.replace(/<spine[^>]*>[\s\S]*?<\/spine>/, `<spine>\n${newSpine}\n    </spine>`);
  zip.file(opfRel, opfXml);

  if (tocRel) {
    let tocXml = await zip.file(tocRel).async('string');
    let order = 1;
    const navPts = batchPoints.map(pt =>
      `    <navPoint id="np-${chunkNum}-${order}" playOrder="${order++}">\n` +
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
  const magKey = process.argv[2];
  const specificDate = process.argv[3] || null;

  if (!magKey || !MAGAZINES[magKey]) {
    console.error(`Usage: node deliver.js <magazine> [date]`);
    console.error(`  magazine: ${Object.keys(MAGAZINES).join(' | ')}`);
    console.error(`  date: optional (e.g. 2026.05.25). If omitted, finds latest unfetched issue.`);
    process.exit(1);
  }

  const mag = MAGAZINES[magKey];
  console.log(`=== ${mag.displayName} Weekly Delivery ===`);

  // Determine issue date
  let issueDate;
  if (specificDate) {
    issueDate = specificDate;
    console.log(`Using specified date: ${issueDate}`);
  } else {
    console.log('Finding latest unfetched issue...');
    issueDate = await findLatestUnfetched(magKey);
    if (!issueDate) {
      console.log('All issues have been fetched already!');
      process.exit(0);
    }
    console.log(`Latest unfetched issue: ${issueDate}`);
  }

  // Build download URL
  const folderName = mag.folderPrefix ? `${mag.folderPrefix}${issueDate}` : issueDate;
  const fileName = mag.filePattern.replace('{date}', issueDate);
  const url = `https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/${mag.dir}/${folderName}/${fileName}`;
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

  // Split into chunks of ≤10 articles
  const n = Math.ceil(struct.tocPoints.length / ARTICLES_PER_EPUB);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(struct.tocPoints.slice(i * ARTICLES_PER_EPUB, Math.min((i + 1) * ARTICLES_PER_EPUB, struct.tocPoints.length)));
  }
  console.log(`Chunks: ${chunks.map(c => c.length).join('/')}`);

  // Prepare dirs
  const issueDir = path.join(DATA_DIR, 'issues', magKey, issueDate);
  fs.mkdirSync(issueDir, { recursive: true });

  // Save full EPUB
  fs.writeFileSync(path.join(issueDir, 'full.epub'), epubBuf);

  // Create chunk EPUBs
  const schedule = loadSchedule();
  if (!schedule.magazines) schedule.magazines = {};
  if (!schedule.magazines[magKey]) schedule.magazines[magKey] = {};

  const chunkEntries = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const fileName_chunk = `chunk-${i + 1}.epub`;
    console.log(`\nChunk ${i + 1}/${chunks.length}: ${chunk.length} articles`);

    try {
      const chunkBuf = await createChunkEpub(zip, struct, chunk, i + 1);
      fs.writeFileSync(path.join(issueDir, fileName_chunk), chunkBuf);
      console.log(`  Saved: ${(chunkBuf.length / 1024 / 1024).toFixed(2)} MB`);

      chunkEntries.push({
        chunkNum: i + 1,
        file: `data/issues/${magKey}/${issueDate}/${fileName_chunk}`,
        articles: chunk.map(a => a.label)
      });
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
  }

  // Save schedule entry for this issue
  schedule.magazines[magKey][issueDate] = {
    chunks: chunkEntries,
    totalArticles: struct.tocPoints.length,
    fetchedAt: new Date().toISOString(),
    sent: false
  };
  saveSchedule(schedule);

  // Mark as fetched
  const fetched = loadFetched();
  if (!fetched[magKey]) fetched[magKey] = [];
  fetched[magKey].push({
    date: issueDate,
    fileName: fileName,
    fetchedAt: new Date().toISOString()
  });
  saveFetched(fetched);

  // Save article metadata
  fs.writeFileSync(
    path.join(issueDir, 'articles.json'),
    JSON.stringify(struct.tocPoints.map(a => ({ title: a.label, src: a.src })), null, 2)
  );

  console.log(`\n=== Done: ${mag.displayName} ${issueDate} — ${chunkEntries.length} chunks ===`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
