#!/usr/bin/env node
/**
 * 经济学人周刊推送脚本（GitHub Actions 版）
 * 
 * 功能：
 * 1. 计算最新一期日期（上个周六）
 * 2. 下载 EPUB（带重试）
 * 3. 解压 EPUB
 * 4. 解析文章列表（读 toc.ncx）
 * 5. 获取飞书 tenant_access_token
 * 6. 发送文章列表到飞书
 * 7. 更新 state.json
 * 
 * 环境变量：
 *   FEISHU_APP_ID
 *   FEISHU_APP_SECRET
 *   FEISHU_RECEIVE_ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ============ 配置 ============
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RECEIVE_ID = process.env.FEISHU_RECEIVE_ID || 'ou_d9918c431007aee43b26b39844026065';

const SKILL_DIR = __dirname + '/..';
const STATE_PATH = path.join(SKILL_DIR, 'state.json');
const DOWNLOAD_DIR = path.join(SKILL_DIR, 'downloads');
const EXTRACT_DIR = path.join(SKILL_DIR, 'extracted');

// ============ 工具函数 ============

// HTTP(S) GET 请求（带重定向跟随）
function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        return resolve(httpGet(res.headers.location, maxRedirects - 1));
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', (e) => reject(e));
  });
}

// 延迟
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 核心功能 ============

// 计算最新一期日期（上个周六，格式 YYYY.MM.DD）
function getLatestEditionDate() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=周日, 6=周六
  const daysSinceSaturday = (dayOfWeek + 1) % 7;
  const saturday = new Date(now);
  saturday.setDate(now.getDate() - daysSinceSaturday);
  
  const y = saturday.getFullYear();
  const m = String(saturday.getMonth() + 1).padStart(2, '0');
  const d = String(saturday.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

// 下载 EPUB（带重试）
async function downloadEpub(editionDate) {
  const url = `https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_${editionDate}/TheEconomist.${editionDate}.epub`;
  const outputPath = path.join(DOWNLOAD_DIR, `TheEconomist.${editionDate}.epub`);
  
  // 确保目录存在
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  // 如果已存在，跳过下载
  if (fs.existsSync(outputPath)) {
    console.log(`⚠️  文件已存在，跳过下载: ${outputPath}`);
    return outputPath;
  }
  
  console.log(`📥 下载 EPUB: ${url}`);
  
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await httpGet(url);
      fs.writeFileSync(outputPath, data);
      console.log(`✅ 下载完成: ${outputPath} (${data.length} bytes)`);
      return outputPath;
    } catch (err) {
      console.error(`❌ 下载失败 (尝试 ${attempt}/${maxRetries}): ${err.message}`);
      if (attempt < maxRetries) {
        await sleep(2000 * attempt);
      } else {
        throw new Error(`下载失败: ${err.message}`);
      }
    }
  }
}

// 解压 EPUB
function extractEpub(epubPath) {
  console.log(`📂 解压 EPUB: ${epubPath}`);
  
  // 清理旧的解压目录
  if (fs.existsSync(EXTRACT_DIR)) {
    execSync(`rm -rf "${EXTRACT_DIR}"`);
  }
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  
  try {
    execSync(`unzip -o "${epubPath}" -d "${EXTRACT_DIR}"`, { encoding: 'utf8' });
    console.log(`✅ 解压完成: ${EXTRACT_DIR}`);
    return EXTRACT_DIR;
  } catch (e) {
    throw new Error(`解压失败: ${e.message}`);
  }
}

// 解析 toc.ncx 获取文章列表
function parseArticles(extractDir) {
  console.log(`📖 解析文章列表...`);
  
  // 查找 toc.ncx 文件
  let tocPath = null;
  function findToc(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        const result = findToc(fullPath);
        if (result) return result;
      } else if (file === 'toc.ncx') {
        return fullPath;
      }
    }
    return null;
  }
  
  tocPath = findToc(extractDir);
  if (!tocPath) {
    console.log(`⚠️  找不到 toc.ncx，尝试解析 content.opf`);
    return parseArticlesFromOpf(extractDir);
  }
  
  console.log(`📄 找到 toc.ncx: ${tocPath}`);
  
  // 解析 NCX XML
  const ncxContent = fs.readFileSync(tocPath, 'utf8');
  const articles = [];
  
  // 简单正则解析（匹配 <navPoint> 中的 <text>）
  const navPointRegex = /<navPoint[^>]*>[\s\S]*?<text>(.*?)<\/text>[\s\S]*?<content src="(.*?)"\/>[\s\S]*?<\/navPoint>/g;
  let match;
  while ((match = navPointRegex.exec(ncxContent)) !== null) {
    const title = match[1].replace(/<[^>]+>/g, '').trim(); // 去除 HTML 标签
    const src = match[2];
    articles.push({ title, src });
  }
  
  console.log(`✅ 解析到 ${articles.length} 篇文章`);
  return articles;
}

// 备用：从 content.opf 解析文章列表
function parseArticlesFromOpf(extractDir) {
  // 查找 content.opf
  let opfPath = null;
  function findOpf(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        const result = findOpf(fullPath);
        if (result) return result;
      } else if (file.endsWith('.opf')) {
        return fullPath;
      }
    }
    return null;
  }
  
  opfPath = findOpf(extractDir);
  if (!opfPath) {
    console.log(`⚠️  找不到 content.opf，列出所有 HTML 文件`);
    return listHtmlFiles(extractDir);
  }
  
  console.log(`📄 找到 content.opf: ${opfPath}`);
  
  const opfContent = fs.readFileSync(opfPath, 'utf8');
  const articles = [];
  
  // 解析 <manifest> 中的 <item> 标签
  const itemRegex = /<item[^>]*href="(.*?)"[^>]*media-type="application\/xhtml\+xml"[^>]*\/>/g;
  let match;
  while ((match = itemRegex.exec(opfContent)) !== null) {
    const src = match[1];
    articles.push({ title: path.basename(src, path.extname(src)), src });
  }
  
  console.log(`✅ 解析到 ${articles.length} 个 HTML 文件`);
  return articles;
}

// 备用：列出所有 HTML 文件
function listHtmlFiles(extractDir) {
  const htmlFiles = [];
  function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        walkDir(fullPath);
      } else if (file.endsWith('.html') || file.endsWith('.xhtml')) {
        htmlFiles.push(fullPath);
      }
    }
  }
  walkDir(extractDir);
  
  return htmlFiles.map(f => ({
    title: path.basename(f, path.extname(f)),
    src: path.relative(extractDir, f)
  }));
}

// 获取 tenant_access_token
function getTenantAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      app_id: APP_ID,
      app_secret: APP_SECRET
    });
    
    const options = {
      hostname: 'open.feishu.cn',
      port: 443,
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0) {
            resolve(result.tenant_access_token);
          } else {
            reject(new Error(`获取 token 失败: ${result.msg} (code: ${result.code})`));
          }
        } catch (e) {
          reject(new Error(`解析 token 响应失败: ${e.message}`));
        }
      });
    });
    
    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// 发送文本消息
function sendTextMessage(token, text) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      receive_id: RECEIVE_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: text })
    });
    
    const options = {
      hostname: 'open.feishu.cn',
      port: 443,
      path: '/open-apis/im/v1/messages?receive_id_type=open_id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0) {
            resolve(result.data);
          } else {
            reject(new Error(`发送消息失败: ${result.msg} (code: ${result.code})`));
          }
        } catch (e) {
          reject(new Error(`解析发送响应失败: ${e.message}`));
        }
      });
    });
    
    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// 主函数
async function main() {
  console.log('========================================');
  console.log('《经济学人》周刊推送脚本');
  console.log('========================================');
  
  // 检查环境变量
  if (!APP_ID || !APP_SECRET) {
    console.error('❌ 缺少环境变量：FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    console.error('   请在 GitHub Secrets 中配置这两个变量');
    process.exit(1);
  }
  
  console.log(`📡 接收者 open_id: ${RECEIVE_ID}`);
  
  try {
    // 1. 获取最新一期日期
    const editionDate = getLatestEditionDate();
    console.log(`\n📅 最新一期日期: ${editionDate}`);
    
    // 2. 读取 state.json（检查是否已处理）
    let state = {};
    if (fs.existsSync(STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
    
    if (state.edition_date === editionDate && state.sent_at) {
      console.log(`⚠️  本期已发送（${state.sent_at}），跳过`);
      return;
    }
    
    // 3. 下载 EPUB
    const epubPath = await downloadEpub(editionDate);
    
    // 4. 解压 EPUB
    const extractDir = extractEpub(epubPath);
    
    // 5. 解析文章
    const articles = parseArticles(extractDir);
    
    if (articles.length === 0) {
      console.error('❌ 没有解析到文章');
      process.exit(1);
    }
    
    // 6. 获取 token
    console.log('\n🔑 获取 tenant_access_token...');
    const token = await getTenantAccessToken();
    console.log('✅ Token 获取成功');
    
    // 7. 发送消息
    console.log('\n📤 发送消息到飞书...');
    
    // 构建文章列表消息
    const articleList = articles.slice(0, 20).map((a, i) => `  ${i+1}. ${a.title}`).join('\n');
    const message = `📰 《经济学人》${editionDate} 已发布\n\n共 ${articles.length} 篇文章，本期推荐：\n${articleList}\n\n📚 完整内容请阅读 EPUB 文件`;
    
    await sendTextMessage(token, message);
    console.log('✅ 消息发送成功');
    
    // 8. 更新 state.json
    state = {
      edition_date: editionDate,
      downloaded_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
      article_count: articles.length,
      articles: articles
    };
    
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`✅ 状态已保存: ${STATE_PATH}`);
    
    console.log('\n========================================');
    console.log('✅ 完成');
    console.log('========================================');
    
  } catch (err) {
    console.error(`\n❌ 错误: ${err.message}`);
    process.exit(1);
  }
}

// 执行
if (require.main === module) {
  main();
}

module.exports = { getTenantAccessToken, sendTextMessage, parseArticles };
