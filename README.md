# Journal Weekly Delivery

周刊自动推送系统 — 从 [awesome-english-ebooks](https://github.com/hehonghui/awesome-english-ebooks) 下载 EPUB，拆分文章，通过飞书推送。

## 支持杂志

| 杂志 | 参数名 | 源路径 |
|------|--------|--------|
| The Economist | `economist` | `01_economist/te_{date}/` |
| The New Yorker | `new_yorker` | `02_new_yorker/{date}/` |
| The Atlantic | `atlantic` | `03_atlantic/{date}/` |
| Wired | `wired` | `04_wired/{date}/` |

## 使用方式

### 手动触发

在 GitHub Actions 页面点击 **Run workflow**，选择：

- **magazine**（必选）：`economist` / `new_yorker` / `atlantic` / `wired`
- **date**（可选）：指定期刊日期（如 `2026.05.25`），留空自动获取最新未获取期
- **push**（默认 true）：获取后立即推送到飞书

### 通过 API 触发

```bash
gh workflow run daily-push.yml \
  -f magazine=economist \
  -f date=2026.05.25 \
  -f push=true
```

## 工作流程

```
awesome-english-ebooks ──download──→ EPUB
                                      │
                                 JSZip 解压
                                      │
                              按 ≤10 篇拆分 ──→ split_1.epub, split_2.epub, ...
                                      │
                              一次性推送 ──→ 飞书
```

1. **deliver.js**：查询源仓库 → 下载 EPUB → 拆分 → 保存到 `data/issues/{magazine}/{date}/`
2. **daily-push.js**：读取拆分文件 → 解压提取文章 HTML → 发送飞书消息
3. **workflow**：串联以上步骤，自动 commit 数据文件

## 数据文件

| 文件 | 说明 |
|------|------|
| `data/schedule.json` | 按杂志索引的拆分记录 |
| `data/fetched.json` | 已获取期刊历史（防重复） |
| `data/issues/` | 拆分后的 EPUB 文件 |

## Secrets

| 名称 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 飞书应用密钥 |
| `FEISHU_RECEIVE_ID` | 飞书接收者 ID |

> `GITHUB_TOKEN` 由 GitHub Actions 自动提供，无需手动配置。
