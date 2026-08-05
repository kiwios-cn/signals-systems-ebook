# 信号与系统电子书公开站点

本仓库是“信号与系统电子书”的静态发布仓库，用于 GitHub Pages 公开访问。正式内容源文件和构建脚本保留在本地维护目录 `信号与系统/` 中，本仓库只保存已经构建好的网页阅读器和 WebP 页面图。


## 公开站点

- GitHub 仓库：https://github.com/kiwios-cn/signals-systems-ebook
- GitHub Pages：https://kiwios-cn.github.io/signals-systems-ebook/
- 网页入口：https://kiwios-cn.github.io/signals-systems-ebook/ebook/index.html

## 在线入口

- 根入口：`index.html`
- 电子书入口：`ebook/index.html`

## 发布内容

- `ebook/index.html`：网页电子书入口。
- `ebook/app.js`：目录、搜索、连续阅读和页面预加载逻辑。
- `ebook/style.css`：长期阅读布局与视觉样式。
- `ebook/sw.js`：Service Worker 缓存版本控制。
- `ebook/book-manifest.json`：章节目录、页数和一级大点页码。
- `ebook/search-index.json`：搜索索引。
- `ebook/data.js`：前端直接读取的内嵌数据。
- `ebook/rendered-pages/`：Typst 直渲并压缩后的 WebP 页面。

## 更新流程

在本地源码目录更新内容后执行：

```bash
cd /Users/fsr/Desktop/知识总结与pdf生成/信号与系统
python3 ebook/scripts/build_index.py
python3 -m unittest discover ebook/tests
node ebook/tests/test_app_performance.js
```

确认通过后，将 `ebook/` 中的静态产物同步到本仓库，提交并推送到 GitHub。GitHub Pages 使用 `main` 分支根目录发布。

## 当前版本

- 缓存版本：`20260805-signals-systems-v2`
- 内容规模：12 个章节，60 页，48 条搜索记录。
