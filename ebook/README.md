# 信号与系统电子书阅读器

这是一个本地静态网页阅读器，用来把 `typst/` 中的信号与系统章节组织成连续阅读的电子书。

## 功能

- 自动扫描正式 Typst 章节，并按“基础与时域、频域分析、复频域与系统、题型方法”分组。
- 左侧目录支持展开到章节一级大点，点击后跳转到对应页。
- 右侧阅读区域采用全书连续页面流，章节之间自然衔接。
- 顶部搜索框基于 Typst 源文本建立索引，点击结果可跳转到命中章节页。
- 页面由 Typst 以 260 DPI 直渲，再压缩为 WebP，保证公式清晰且适合网页阅读。
- Service Worker 使用版本化缓存，静态壳和页面图分开缓存。
- `data.js` 内嵌目录与搜索索引，支持直接打开 `index.html`。

## 构建命令

```bash
python3 ebook/scripts/build_index.py
```

## 当前版本

- 缓存版本：`20260808-signals-systems-v7`
- 内容规模：12 个章节，67 页，50 条搜索记录。
- 最近更新：`Signals and Systems Basics (信号与系统基础)` 中“信号的基本分类”已补充各类信号的定义、性质和图像表达。

## 输出文件

- `book-manifest.json`：目录、章节、页面数量和一级大点页码。
- `search-index.json`：搜索索引，来自 Typst 源文本。
- `data.js`：供前端直接读取的内嵌数据。
- `rendered-pages/`：WebP 页面图像。

## 验证命令

```bash
python3 -m unittest discover ebook/tests
node ebook/tests/test_app_performance.js
```

## 缓存版本

当前阅读器缓存版本在 `app.js` 和 `sw.js` 中维护。每次内容或前端资源更新后，应同步更新版本号，避免浏览器继续使用旧资源。
