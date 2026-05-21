#!/usr/bin/env node
/**
 * 经济学人周刊推送 — 周六采集脚本（GitHub Actions 版）
 *
 * 每周六运行：
 * 1. 下载最新一期 EPUB
 * 2. 解压并提取每篇文章的标题和正文
 * 3. 将文章均分到接下来 6 天（周日→周五）
 * 4. 保存 articles.json + schedule.json 到仓库
 * 5. 发飞书通知：新刊已就绪
 *
 * 环境变量：
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_RECEIVE_ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RECEIVE_ID = process.env.FEISHU_RECEIVE_ID;

const REPO_DIR = process.env.GITHUB_WORKSPACE || __dirname + '/..';
const DATA_DIR = path.join(REPO_DIR, 'data');
const ISSUE_DIR_TEMPLATE = path.join(DATA_DIR, 'issues', '{date}');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');
const DOWNLOAD_DIR = '/tmp/economist-download';
const EXTRACT_DIR = '/tmp/economist-extract';

// ============ HTTP 工具 ============

function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : require('http');
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(httpGet(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 飞书 API ============

async function getTenantAccessToken() {
  const postData = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  const options = {
    hostname: 'open.feishu.cn', port: 443,
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const r = JSON.parse(data);
        r.code === 0 ? resolve(r.tenant_access_token) : reject(new Error(`Token失败: ${r.msg} (${r.code})`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function sendFeishuMessage(token, msgType, content) {
  const postData = JSON.stringify({
    receive_id: RECEIVE_ID,
    msg_type: msgType,
    content: typeof content === 'string' ? content : JSON.stringify(content)
  });
  const options = {
    hostname: 'open.feishu.cn', port: 443,
    path: '/open-apis/im/v1/messages?receive_id_type=open_id',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const r = JSON.parse(data);
        r.code === 0 ? resolve(r) : reject(new Error(`发消息失败: ${r.msg} (${r.code})`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ============ EPUB 处理 ============

function getLatestEditionDate() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const daysSinceSat = (day + 1) % 7;
  const sat = new Date(now);
  sat.setUTCDate(now.getUTCDate() - daysSinceSat);
  const y = sat.getUTCFullYear();
  const m = String(sat.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sat.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

async function downloadEpub(editionDate) {
  const url = `https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_${editionDate}/TheEconomist.${editionDate}.epub`;
  const outputPath = path.join(DOWNLOAD_DIR, `TheEconomist.${editionDate}.epub`);
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (fs.existsSync(outputPath)) {
    console.log(`⚠️  文件已存在，跳过下载`);
    return outputPath;
  }
  console.log(`📥 下载 EPUB: ${url}`);
  for (let i = 1; i <= 3; i++) {
    try {
      const data = await httpGet(url);
      fs.writeFileSync(outputPath, data);
      console.log(`✅ 下载完成: ${(data.length / 1024 / 1024).toFixed(1)} MB`);
      return outputPath;
    } catch (e) {
      console.error(`❌ 尝试 ${i}/3 失败: ${e.message}`);
      if (i < 3) await sleep(2000 * i);
      else throw e;
    }
  }
}

function extractEpub(epubPath) {
  if (fs.existsSync(EXTRACT_DIR)) execSync(`rm -rf "${EXTRACT_DIR}"`);
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  execSync(`unzip -o "${epubPath}" -d "${EXTRACT_DIR}"`, { encoding: 'utf8' });
  console.log(`✅ 解压完成`);
  return EXTRACT_DIR;
}

/**
 * 从 EPUB 中提取文章（标题 + 正文）
 * 策略：
 * 1. 找到 toc.ncx，解析所有 navPoint 获取标题和 src
 * 2. 对每个 src，读取对应的 HTML/XHTML 文件
 * 3. 从 HTML 中提取纯文本正文
 */
function extractArticles(extractDir) {
  // 找 toc.ncx
  let tocPath = findFile(extractDir, 'toc.ncx');
  if (!tocPath) throw new Error('找不到 toc.ncx');

  console.log(`📄 解析 toc.ncx: ${tocPath}`);
  const ncxContent = fs.readFileSync(tocPath, 'utf8');

  // 解析 navPoint：提取 text 和 content src
  // NCX 格式：<navPoint><navLabel><text>Title</text></navLabel><content src="path/to/file.xhtml"/></navPoint>
  const navPoints = [];
  // 匹配 navPoint 块
  const navRegex = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/g;
  let navMatch;
  while ((navMatch = navRegex.exec(ncxContent)) !== null) {
    const block = navMatch[1];
    // 提取 text
    const textMatch = block.match(/<text[^>]*>([\s\S]*?)<\/text>/);
    const srcMatch = block.match(/<content[^>]*src="([^"]+)"/);
    if (textMatch && srcMatch) {
      const title = textMatch[1].replace(/<[^>]+>/g, '').trim();
      const src = srcMatch[1].trim();
      if (title && src) {
        navPoints.push({ title, src });
      }
    }
  }

  console.log(`📄 toc.ncx 中找到 ${navPoints.length} 个条目`);

  // 过滤：只保留实际有 HTML 文件的条目，跳过封面、版权页等
  const articles = [];
  const tocDir = path.dirname(tocPath);

  for (const point of navPoints) {
    // 跳过非文章（如 Contents, Cover, Copyright 等）
    const skipPatterns = /^(contents|cover|copyright|title.?page|toc|colophon|imprint|index|advert)/i;
    if (skipPatterns.test(point.title) || point.title.length < 3) continue;

    // 解析 src 路径
    let htmlPath = path.resolve(tocDir, decodeURIComponent(point.src));

    if (!fs.existsSync(htmlPath)) {
      // 尝试 ../ 相对路径
      htmlPath = path.resolve(extractDir, decodeURIComponent(point.src));
    }

    if (!fs.existsSync(htmlPath)) {
      console.log(`⚠️  文件不存在，跳过: ${point.title} → ${point.src}`);
      continue;
    }

    // 读取并提取正文
    const html = fs.readFileSync(htmlPath, 'utf8');
    const text = extractTextFromHtml(html);

    if (text && text.length > 50) { // 至少50字符才算有效文章
      articles.push({
        title: point.title,
        navLabel: point.title,
        src: point.src,
        text: text,
        charCount: text.length
      });
    }
  }

  console.log(`✅ 提取到 ${articles.length} 篇有效文章`);
  // 打印前10篇标题
  articles.slice(0, 10).forEach((a, i) => console.log(`   ${i + 1}. ${a.title} (${a.charCount} chars)`));
  if (articles.length > 10) console.log(`   ... 共 ${articles.length} 篇`);

  return articles;
}

/**
 * 从 HTML 中提取纯文本
 * 去除标签、脚本、样式，保留段落结构
 */
function extractTextFromHtml(html) {
  // 移除 script 和 style
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // 移除 HTML 标签
  text = text.replace(/<[^>]+>/g, '\n');
  // 解码 HTML 实体
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&mdash;/g, '—');
  text = text.replace(/&ndash;/g, '–');
  text = text.replace(/&hellip;/g, '…');
  text = text.replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))));
  // 压缩空行
  text = text.replace(/\n{3,}/g, '\n\n');
  // Trim
  text = text.trim();
  return text;
}

function findFile(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) {
      const result = findFile(fp, filename);
      if (result) return result;
    } else if (f === filename) {
      return fp;
    }
  }
  return null;
}

// ============ 批次分配 ============

/**
 * 将文章均分到 N 天
 * @param {Array} articles - 文章列表
 * @param {string} startDate - 起始日期 YYYY-MM-DD（周日）
 * @param {number} days - 分几天（默认6：周日→周五）
 */
function allocateBatches(articles, startDate, days = 6) {
  const total = articles.length;
  const perDay = Math.ceil(total / days);

  const schedule = {};
  for (let d = 0; d < days; d++) {
    const date = new Date(startDate + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + d);
    const dateStr = date.toISOString().slice(0, 10);
    const start = d * perDay;
    const end = Math.min(start + perDay, total);
    if (start >= total) break;
    schedule[dateStr] = {
      indices: [],
      sent: false
    };
    for (let i = start; i < end; i++) {
      schedule[dateStr].indices.push(i);
    }
  }

  return schedule;
}

function getNextSunday() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilSun = (7 - day) % 7;
  if (daysUntilSun === 0) daysUntilSun = 7; // 如果今天是周日，取下周日
  // 实际上我们想要本周日或下周日... 取最近的未来周日
  const sun = new Date(now);
  sun.setUTCDate(now.getUTCDate() + ((7 - day) % 7 || 7));
  return sun.toISOString().slice(0, 10);
}

// ============ 主函数 ============

async function main() {
  console.log('========================================');
  console.log('《经济学人》周刊 — 周六采集脚本');
  console.log('========================================');

  if (!APP_ID || !APP_SECRET) {
    console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
    process.exit(1);
  }

  // 1. 计算最新一期日期
  const editionDate = getLatestEditionDate();
  console.log(`📅 最新一期: ${editionDate}`);

  // 2. 检查是否已处理过这期
  const issueDir = ISSUE_DIR_TEMPLATE.replace('{date}', editionDate);
  const articlesJsonPath = path.join(issueDir, 'articles.json');
  if (fs.existsSync(articlesJsonPath)) {
    console.log(`⚠️  本期 ${editionDate} 已处理过，跳过`);
    process.exit(0);
  }

  // 3. 下载 EPUB
  const epubPath = await downloadEpub(editionDate);

  // 4. 解压
  const extractDir = extractEpub(epubPath);

  // 5. 提取文章
  const articles = extractArticles(extractDir);
  if (articles.length === 0) {
    console.error('❌ 没有提取到有效文章');
    process.exit(1);
  }

  // 6. 保存 articles.json
  fs.mkdirSync(issueDir, { recursive: true });
  fs.writeFileSync(articlesJsonPath, JSON.stringify(articles, null, 2));
  console.log(`💾 已保存: ${articlesJsonPath}`);

  // 7. 分配批次（周日→周五，6天）
  const startDate = getNextSunday();
  const schedule = allocateBatches(articles, startDate, 6);

  // 读取已有 schedule 或创建新的
  let scheduleData = {};
  if (fs.existsSync(SCHEDULE_PATH)) {
    try { scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8')); } catch (e) {}
  }

  // 更新 schedule
  scheduleData.currentIssue = editionDate;
  scheduleData.issueCount = (scheduleData.issueCount || 0) + 1;
  scheduleData.lastUpdated = new Date().toISOString();

  // 把新批次合并进去
  for (const [date, batch] of Object.entries(schedule)) {
    scheduleData.batches = scheduleData.batches || {};
    scheduleData.batches[date] = {
      issue: editionDate,
      indices: batch.indices,
      sent: false
    };
  }

  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleData, null, 2));
  console.log(`💾 已保存: ${SCHEDULE_PATH}`);

  // 打印批次分配
  console.log('\n📋 批次分配:');
  for (const [date, batch] of Object.entries(schedule)) {
    const titles = batch.indices.map(i => articles[i].title).join(', ');
    console.log(`   ${date}: ${batch.indices.length} 篇 — ${titles.slice(0, 80)}...`);
  }

  // 8. 发飞书通知
  console.log('\n📤 发送飞书通知...');
  try {
    const token = await getTenantAccessToken();
    const totalChars = articles.reduce((sum, a) => sum + a.charCount, 0);

    const cardContent = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `📰 The Economist ${editionDate}` },
        template: 'blue'
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `共 **${articles.length}** 篇文章，总字符数 ${totalChars.toLocaleString()}\n将从明天起分 **6 天** 推送（每天约 ${Math.ceil(articles.length / 6)} 篇）`
          }
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `📅 首次推送: ${startDate}`
          }
        }
      ]
    };

    await sendFeishuMessage(token, 'interactive', cardContent);
    console.log('✅ 飞书通知已发送');
  } catch (e) {
    console.error(`⚠️  飞书通知失败（不阻断）: ${e.message}`);
  }

  console.log('\n========================================');
  console.log('✅ 采集完成，等待每日推送');
  console.log('========================================');
}

main().catch(e => {
  console.error(`\n❌ 错误: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
