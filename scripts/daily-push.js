#!/usr/bin/env node
/**
 * 经济学人周刊推送 — 每日推送脚本（GitHub Actions 版）
 *
 * 每天运行（周日→周五）：
 * 1. 读取 schedule.json，找到今天的批次
 * 2. 读取对应文章内容
 * 3. 逐篇发送飞书消息
 * 4. 标记已发送，更新 schedule.json
 *
 * 环境变量：
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_RECEIVE_ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RECEIVE_ID = process.env.FEISHU_RECEIVE_ID;

const REPO_DIR = process.env.GITHUB_WORKSPACE || __dirname + '/..';
const DATA_DIR = path.join(REPO_DIR, 'data');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule.json');

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 主函数 ============

async function main() {
  console.log('========================================');
  console.log('《经济学人》周刊 — 每日推送');
  console.log('========================================');

  if (!APP_ID || !APP_SECRET) {
    console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
    process.exit(0); // 不是致命错误，静默退出
  }

  // 获取今天的日期 (UTC)
  const today = new Date().toISOString().slice(0, 10);
  console.log(`📅 今天: ${today}`);

  // 读取 schedule.json
  if (!fs.existsSync(SCHEDULE_PATH)) {
    console.log('⚠️  schedule.json 不存在，没有待推送的文章');
    process.exit(0);
  }

  const scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  const batches = scheduleData.batches || {};

  // 找今天的批次
  const todayBatch = batches[today];
  if (!todayBatch) {
    console.log('⚠️  今天没有待推送的批次');
    process.exit(0);
  }

  if (todayBatch.sent) {
    console.log('✅ 今天的批次已发送，跳过');
    process.exit(0);
  }

  console.log(`📡 找到批次: ${todayBatch.issue}, ${todayBatch.indices.length} 篇文章`);

  // 读取文章
  const issueDate = todayBatch.issue;
  const articlesJsonPath = path.join(DATA_DIR, 'issues', issueDate, 'articles.json');
  if (!fs.existsSync(articlesJsonPath)) {
    console.error(`❌ 文章文件不存在: ${articlesJsonPath}`);
    process.exit(1);
  }

  const articles = JSON.parse(fs.readFileSync(articlesJsonPath, 'utf8'));

  // 获取飞书 token
  const token = await getTenantAccessToken();
  console.log('✅ 飞书 Token 获取成功');

  // 逐篇发送
  const articleIndices = todayBatch.indices;
  let sentCount = 0;

  for (const idx of articleIndices) {
    const article = articles[idx];
    if (!article) {
      console.log(`⚠️  文章索引 ${idx} 不存在，跳过`);
      continue;
    }

    try {
      await sendArticle(token, article, idx + 1, articleIndices.length, issueDate);
      sentCount++;
      console.log(`✅ [${sentCount}/${articleIndices.length}] ${article.title}`);

      // 飞书消息频率限制：每秒不超过20条，保守起见间隔1秒
      if (sentCount < articleIndices.length) {
        await sleep(1500);
      }
    } catch (e) {
      console.error(`❌ 发送失败: ${article.title} — ${e.message}`);
      // 继续发送下一篇
    }
  }

  // 标记已发送
  batches[today].sent = true;
  batches[today].sentAt = new Date().toISOString();
  batches[today].sentCount = sentCount;
  scheduleData.lastUpdated = new Date().toISOString();

  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleData, null, 2));
  console.log(`\n💾 schedule.json 已更新`);

  console.log(`\n✅ 推送完成: ${sentCount} 篇文章`);
}

/**
 * 发送单篇文章到飞书
 * 使用富文本消息格式（post），支持标题+正文
 */
async function sendArticle(token, article, index, total, issueDate) {
  // 截取正文前 4000 字符（飞书消息长度限制）
  const maxLen = 4000;
  let text = article.text;
  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + '\n\n... [全文过长，已截断]';
    truncated = true;
  }

  // 使用 post 类型消息（富文本）
  const content = { text: `📰 The Economist ${issueDate} · ${index}/${total}\n\n${article.title}\n\n${text}` };

  await sendFeishuMessage(token, 'post', content);
}

main().catch(e => {
  console.error(`\n❌ 错误: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
