#!/usr/bin/env node
/**
 * Economist Daily Push
 * Reads today's EPUB from data/, uploads to Feishu, sends file message.
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

// ─── Main ──────────────────────────────────────────────

async function main() {
  console.log('=== Economist Daily Push ===');

  if (!APP_ID || !APP_SECRET || !RECEIVE_ID) {
    console.log('Missing env vars, skipping');
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log('Today (UTC):', today);

  if (!fs.existsSync(SCHEDULE_PATH)) {
    console.log('No schedule.json');
    process.exit(0);
  }

  const sched = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const batch = sched.batches[today];

  if (!batch) { console.log('No batch for today'); process.exit(0); }
  if (batch.sent) { console.log('Already sent'); process.exit(0); }

  console.log(`Day ${batch.dayNum} · Issue ${batch.issue} · ${batch.articles.length} articles`);

  const epubPath = path.join(WORKSPACE, batch.file);
  if (!fs.existsSync(epubPath)) {
    console.error(`EPUB not found: ${epubPath}`);
    process.exit(1);
  }

  const epubBuf = fs.readFileSync(epubPath);
  const fileName = `TheEconomist.${batch.issue}.Day${batch.dayNum}.epub`;
  console.log(`File: ${(epubBuf.length / 1024 / 1024).toFixed(2)} MB`);

  const token = await getToken();
  console.log('Token OK');

  // 1. Upload EPUB file
  const fileKey = await uploadFile(token, epubBuf, fileName);
  console.log('Uploaded:', fileKey);

  // 2. Send file message
  await sendMsg(token, 'file', { file_key: fileKey });
  console.log('File sent');

  // 3. Send article list
  const list = batch.articles.map((a, i) => `${i + 1}. ${a}`).join('\n');
  await sendMsg(token, 'text', { text: `\u{1F4F0} The Economist ${batch.issue} \u00B7 Day ${batch.dayNum}\n\n${list}` });
  console.log('List sent');

  // 4. Mark sent
  batch.sent = true;
  batch.sentAt = new Date().toISOString();
  sched.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(sched, null, 2));
  console.log('Schedule updated');

  console.log('=== Done ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
