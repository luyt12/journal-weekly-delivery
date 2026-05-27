#!/usr/bin/env node
/**
 * Journal Push
 * Sends all chunk EPUBs for a magazine issue on the same day.
 * Usage:
 *   node daily-push.js <magazine> <date>
 *   node daily-push.js economist 2026.05.23
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.GITHUB_WORKSPACE || path.join(__dirname, '..');
const DATA_DIR = path.join(WORKSPACE, 'data');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RECEIVE_ID = process.env.FEISHU_RECEIVE_ID;

// ─── Feishu API (Node.js 18+ fetch) ────────────────────

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Token: ${d.msg} (${d.code})`);
  return d.tenant_access_token;
}

async function uploadFile(token, buf, name) {
  const fd = new FormData();
  fd.append('file_type', 'stream');
  fd.append('file_name', name);
  fd.append('file', new Blob([buf], { type: 'application/epub+zip' }), name);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: fd
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Upload: ${d.msg} (${d.code})`);
  return d.data.file_key;
}

async function sendMsg(token, msgType, content) {
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: RECEIVE_ID,
      msg_type: msgType,
      content: JSON.stringify(content)
    })
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Send: ${d.msg} (${d.code})`);
  return d;
}

// ─── Magazine display names ────────────────────────────

const DISPLAY_NAMES = {
  economist: 'The Economist',
  new_yorker: 'New Yorker',
  atlantic: 'The Atlantic',
  wired: 'Wired'
};

// ─── Main ──────────────────────────────────────────────

async function main() {
  const magKey = process.argv[2];
  const issueDate = process.argv[3];

  if (!magKey || !issueDate) {
    console.error('Usage: node daily-push.js <magazine> <date>');
    console.error('  magazine: economist | new_yorker | atlantic | wired');
    console.error('  date: e.g. 2026.05.23');
    process.exit(1);
  }

  console.log(`=== ${DISPLAY_NAMES[magKey] || magKey} Push: ${issueDate} ===`);

  if (!APP_ID || !APP_SECRET || !RECEIVE_ID) {
    console.log('Missing env vars, skipping');
    process.exit(0);
  }

  if (!fs.existsSync(SCHEDULE_PATH)) {
    console.log('No schedule.json');
    process.exit(0);
  }

  const sched = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const magSched = sched.magazines?.[magKey]?.[issueDate];

  if (!magSched) {
    console.log(`No schedule entry for ${magKey} ${issueDate}`);
    process.exit(0);
  }

  if (magSched.sent) {
    console.log('Already sent');
    process.exit(0);
  }

  const chunks = magSched.chunks;
  const displayName = DISPLAY_NAMES[magKey] || magKey;
  console.log(`Issue: ${issueDate} · ${magSched.totalArticles} articles · ${chunks.length} chunks`);

  const token = await getToken();
  console.log('Token OK');

  // 1. Send header message
  const header = `📰 ${displayName} ${issueDate} · ${magSched.totalArticles}篇 · 拆分${chunks.length}个EPUB`;
  await sendMsg(token, 'text', { text: header });
  console.log('Header sent');

  // 2. Send each chunk EPUB
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const epubPath = path.join(WORKSPACE, chunk.file);

    if (!fs.existsSync(epubPath)) {
      console.error(`EPUB not found: ${epubPath}`);
      continue;
    }

    const epubBuf = fs.readFileSync(epubPath);
    const fileName = `${displayName.replace(/ /g, '_')}.${issueDate}.Part${chunk.chunkNum}.epub`;
    console.log(`Chunk ${chunk.chunkNum}: ${(epubBuf.length / 1024 / 1024).toFixed(2)} MB`);

    const fileKey = await uploadFile(token, epubBuf, fileName);
    console.log(`  Uploaded: ${fileKey}`);

    await sendMsg(token, 'file', { file_key: fileKey });
    console.log(`  File sent`);

    // Send article list for this chunk
    const list = chunk.articles.map((a, idx) => `${idx + 1}. ${a}`).join('\n');
    await sendMsg(token, 'text', { text: `Part ${chunk.chunkNum} (${chunk.articles.length}篇)\n${list}` });
    console.log(`  List sent`);

    // Small delay to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 3. Mark as sent
  magSched.sent = true;
  magSched.sentAt = new Date().toISOString();
  sched.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(sched, null, 2));
  console.log('Schedule updated');

  console.log('=== Done ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
