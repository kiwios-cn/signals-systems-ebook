const manifest = window.BOOK_MANIFEST || { categories: [], documents: [], stats: {} };
const searchIndex = window.SEARCH_INDEX || [];

const categoryAccentMap = new Map(
  (manifest.categories || []).map((category) => [category.title, category.accent])
);

const PAGE_PRELOAD_RADIUS = 1;
const PAGE_OBSERVER_MARGIN = "900px 0px";
const BACKGROUND_PRELOAD_START_DELAY_MS = 1800;
const BACKGROUND_PRELOAD_BATCH_DELAY_MS = 320;
const BACKGROUND_PRELOAD_BATCH_SIZE = 2;
const APP_VERSION = "20260805-signals-systems-v5";
const SERVICE_WORKER_FILE = "./sw.js";
const BOOK_RENDER_ID = "__full_book__";

const state = {
  activeDocId: null,
  activePage: 1,
  activeCategory: "全部",
  query: "",
  renderedDocId: null,
  pageImageObserver: null,
  warmedImageUrls: new Set(),
  scrollSyncTimer: null,
  backgroundPreloadTimer: null,
  backgroundPreloadDocId: null,
};

const elements = {};

function bindElements() {
  elements.bookSubtitle = document.querySelector("#bookSubtitle");
  elements.libraryMeta = document.querySelector("#libraryMeta");
  elements.toc = document.querySelector("#toc");
  elements.currentCategory = document.querySelector("#currentCategory");
  elements.currentTitle = document.querySelector("#currentTitle");
  elements.pageInput = document.querySelector("#pageInput");
  elements.paperStage = document.querySelector("#paperStage");
  elements.viewerWrap = document.querySelector("#viewerWrap");
  elements.pageStack = document.querySelector("#pageStack");
  elements.prevPageButton = document.querySelector("#prevPageButton");
  elements.nextPageButton = document.querySelector("#nextPageButton");
  elements.searchBox = document.querySelector("#searchBox");
  elements.searchInput = document.querySelector("#searchInput");
  elements.searchPopover = document.querySelector("#searchPopover");
  elements.subjectTabs = document.querySelector("#subjectTabs");
  elements.searchSummary = document.querySelector("#searchSummary");
  elements.searchResults = document.querySelector("#searchResults");
}

function getDocumentById(docId) {
  return (manifest.documents || []).find((documentItem) => documentItem.id === docId) || null;
}

function getFirstDocument() {
  return (manifest.documents || [])[0] || null;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getPageAssetVersion() {
  const stats = manifest.stats || {};
  return [
    stats.renderDpi || "dpi",
    stats.pageRenderer || "renderer",
    stats.pageImageExtension || "image",
    manifest.generatedAt || "local",
  ].join("-");
}

function getAppAssetVersion() {
  return APP_VERSION;
}

function encodePageImagePath(documentItem, pageNumber) {
  const pageDigits = documentItem.pageCount >= 10 ? String(documentItem.pageCount).length : 1;
  const imagePageNumber = String(pageNumber).padStart(pageDigits, "0");
  const imageExtension = documentItem.pageImageExtension || manifest.stats?.pageImageExtension || "webp";
  const version = new URLSearchParams({ v: getPageAssetVersion() });
  return `${documentItem.pageImageBase}${imagePageNumber}.${imageExtension}?${version.toString()}`;
}

function getServiceWorkerUrl() {
  const version = new URLSearchParams({ v: getAppAssetVersion() });
  return `${SERVICE_WORKER_FILE}?${version.toString()}`;
}

function canRegisterServiceWorker() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

function getPrefetchPageRange(pageCount, centerPage, radius = PAGE_PRELOAD_RADIUS) {
  const safeCenter = Math.min(Math.max(1, centerPage), pageCount);
  const firstPage = Math.max(1, safeCenter - radius);
  const lastPage = Math.min(pageCount, safeCenter + radius);
  return Array.from({ length: lastPage - firstPage + 1 }, (_, index) => firstPage + index);
}

/**
 * 生成后台预加载顺序：跳过当前页附近，优先加载阅读方向上的近邻页面。
 */
function getBackgroundPreloadPageOrder(pageCount, centerPage, radius = PAGE_PRELOAD_RADIUS) {
  const safeCenter = Math.min(Math.max(1, centerPage), pageCount);
  const immediatePages = new Set(getPrefetchPageRange(pageCount, safeCenter, radius));
  return Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((pageNumber) => !immediatePages.has(pageNumber))
    .sort((firstPage, secondPage) => {
      const firstDistance = Math.abs(firstPage - safeCenter);
      const secondDistance = Math.abs(secondPage - safeCenter);
      if (firstDistance !== secondDistance) {
        return firstDistance - secondDistance;
      }
      const firstIsForward = firstPage > safeCenter ? 0 : 1;
      const secondIsForward = secondPage > safeCenter ? 0 : 1;
      return firstIsForward - secondIsForward || firstPage - secondPage;
    });
}

function getBookDocuments() {
  return manifest.documents || [];
}

function getBookPageEntries() {
  const entries = [];
  getBookDocuments().forEach((documentItem) => {
    for (let pageNumber = 1; pageNumber <= documentItem.pageCount; pageNumber += 1) {
      entries.push({
        docId: documentItem.id,
        page: pageNumber,
        globalIndex: entries.length + 1,
        documentItem,
      });
    }
  });
  return entries;
}

function getBookPageIndex(docId, pageNumber) {
  return getBookPageEntries().findIndex((entry) => entry.docId === docId && entry.page === pageNumber);
}

function getBookPageWindow(docId, pageNumber, radius = PAGE_PRELOAD_RADIUS) {
  const entries = getBookPageEntries();
  const centerIndex = getBookPageIndex(docId, pageNumber);
  if (centerIndex < 0) {
    return [];
  }
  const firstIndex = Math.max(0, centerIndex - radius);
  const lastIndex = Math.min(entries.length - 1, centerIndex + radius);
  return entries.slice(firstIndex, lastIndex + 1);
}

/**
 * 全书连续预加载顺序：跨章节按当前位置远近排序，并优先加载阅读方向。
 */
function getBackgroundBookPreloadPageOrder(docId, pageNumber, radius = PAGE_PRELOAD_RADIUS) {
  const entries = getBookPageEntries();
  const centerIndex = getBookPageIndex(docId, pageNumber);
  if (centerIndex < 0) {
    return [];
  }
  const immediateIndexes = new Set(
    getBookPageWindow(docId, pageNumber, radius).map((entry) => entry.globalIndex - 1)
  );
  return entries
    .filter((entry) => !immediateIndexes.has(entry.globalIndex - 1))
    .sort((firstEntry, secondEntry) => {
      const firstDistance = Math.abs(firstEntry.globalIndex - 1 - centerIndex);
      const secondDistance = Math.abs(secondEntry.globalIndex - 1 - centerIndex);
      if (firstDistance !== secondDistance) {
        return firstDistance - secondDistance;
      }
      const firstIsForward = firstEntry.globalIndex - 1 > centerIndex ? 0 : 1;
      const secondIsForward = secondEntry.globalIndex - 1 > centerIndex ? 0 : 1;
      return firstIsForward - secondIsForward || firstEntry.globalIndex - secondEntry.globalIndex;
    });
}

function getAdjacentBookPage(docId, pageNumber, direction) {
  const entries = getBookPageEntries();
  const currentIndex = getBookPageIndex(docId, pageNumber);
  if (currentIndex < 0) {
    return null;
  }
  return entries[currentIndex + direction] || null;
}

function getPageImageElement(entry) {
  return elements.pageStack.querySelector(`[data-global-index="${entry.globalIndex}"] .page-image`);
}

function getActiveSection(documentItem, pageNumber = state.activePage) {
  const sections = [...(documentItem?.sections || [])].sort((first, second) => first.page - second.page);
  let activeSection = null;
  sections.forEach((section) => {
    if (section.page <= pageNumber) {
      activeSection = section;
    }
  });
  return activeSection;
}

function updateHash() {
  const params = new URLSearchParams();
  if (state.activeDocId) {
    params.set("doc", state.activeDocId);
  }
  params.set("page", String(state.activePage));
  if (state.query) {
    params.set("q", state.query);
  }
  if (state.activeCategory !== "全部") {
    params.set("category", state.activeCategory);
  }
  window.history.replaceState(null, "", `#${params.toString()}`);
}

function restoreStateFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const firstDocument = getFirstDocument();
  state.activeDocId = params.get("doc") || firstDocument?.id || null;
  state.activePage = Math.max(1, Number.parseInt(params.get("page") || "1", 10));
  state.query = params.get("q") || "";
  state.activeCategory = params.get("category") || "全部";
  elements.searchInput.value = state.query;
}

function renderMeta() {
  elements.bookSubtitle.textContent = manifest.subtitle || "时域分析 · 频域分析 · 复频域方法";
  const stats = manifest.stats || {};
  const generatedAt = formatDate(manifest.generatedAt);
  elements.libraryMeta.textContent = `${stats.documents || 0} 个章节 · ${stats.pages || 0} 页 · ${stats.searchEntries || searchIndex.length} 条索引${generatedAt ? ` · ${generatedAt}` : ""}`;
}

function renderToc() {
  elements.toc.innerHTML = "";
  (manifest.categories || []).forEach((category) => {
    const block = document.createElement("section");
    block.className = "category-block";

    const title = document.createElement("div");
    title.className = "category-title";
    const dot = document.createElement("span");
    dot.className = "category-dot";
    dot.style.background = category.accent;
    title.append(dot, document.createTextNode(category.title));
    block.append(title);

    category.documents.forEach((documentItem) => {
      block.append(renderTocDocument(documentItem, category));
    });
    elements.toc.append(block);
  });
}

function renderTocDocument(documentItem, category) {
  const item = document.createElement("div");
  item.className = "toc-document";
  item.dataset.docId = documentItem.id;
  item.classList.toggle("is-expanded", documentItem.id === state.activeDocId);

  const sections = documentItem.sections || [];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toc-button";
  button.style.setProperty("--active-accent", category.accent);
  button.dataset.docId = documentItem.id;
  button.setAttribute("aria-expanded", String(documentItem.id === state.activeDocId && sections.length > 0));
  button.innerHTML = `
    <span class="toc-main-row">
      <span class="toc-chevron" aria-hidden="true">${sections.length ? "▸" : ""}</span>
      <span class="toc-title">${escapeHtml(documentItem.chineseTitle || documentItem.title)}</span>
    </span>
    <span class="toc-pages">${escapeHtml(documentItem.englishTitle)} · ${documentItem.pageCount} 页 · ${sections.length} 个大点</span>
  `;
  button.addEventListener("click", () => openDocument(documentItem.id, 1));
  item.append(button);

  if (sections.length > 0) {
    item.append(renderTocSections(documentItem, category));
  }
  return item;
}

function renderTocSections(documentItem, category) {
  const sublist = document.createElement("div");
  sublist.className = "toc-sublist";
  sublist.hidden = documentItem.id !== state.activeDocId;
  const activeSection = getActiveSection(documentItem);
  (documentItem.sections || []).forEach((section) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toc-section-button";
    button.style.setProperty("--active-accent", category.accent);
    button.dataset.docId = documentItem.id;
    button.dataset.sectionId = section.id;
    button.classList.toggle("is-active", documentItem.id === state.activeDocId && section.id === activeSection?.id);
    button.innerHTML = `
      <span class="toc-section-page">P${section.page}</span>
      <span class="toc-section-title">${escapeHtml(section.title)}</span>
    `;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openDocument(documentItem.id, section.page);
    });
    sublist.append(button);
  });
  return sublist;
}

function renderSubjectTabs() {
  elements.subjectTabs.innerHTML = "";
  const categories = ["全部", ...(manifest.categories || []).map((category) => category.title)];
  categories.forEach((categoryName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "subject-tab";
    button.textContent = categoryName;
    button.style.setProperty("--tab-accent", categoryAccentMap.get(categoryName) || "#16252b");
    button.setAttribute("role", "listitem");
    button.addEventListener("click", () => {
      state.activeCategory = categoryName;
      renderSubjectTabs();
      performSearch();
      updateHash();
    });
    if (state.activeCategory === categoryName) {
      button.classList.add("is-active");
    }
    elements.subjectTabs.append(button);
  });
}

function openDocument(docId, pageNumber = 1) {
  const documentItem = getDocumentById(docId);
  if (!documentItem) {
    return;
  }
  const previousDocId = state.activeDocId;
  state.activeDocId = documentItem.id;
  state.activePage = Math.min(Math.max(1, pageNumber), documentItem.pageCount);
  updateReaderHeader(documentItem);
  renderPageStack(documentItem);
  warmNearbyPageImages(documentItem, state.activePage);
  scheduleBackgroundPagePreload(documentItem, state.activePage);
  updatePageControls(documentItem);
  renderToc();
  requestAnimationFrame(() => {
    scrollToPage(documentItem.id, state.activePage, previousDocId === documentItem.id ? "smooth" : "auto");
  });
  updateTocActiveState(documentItem);
  updateHash();
}

function renderPageStack(documentItem) {
  if (state.renderedDocId === BOOK_RENDER_ID) {
    return;
  }
  cancelBackgroundPagePreload();
  disconnectPageImageObserver();
  const fragment = document.createDocumentFragment();
  getBookPageEntries().forEach((entry) => {
    const sheet = document.createElement("figure");
    sheet.className = "page-sheet";
    sheet.dataset.docId = entry.docId;
    sheet.dataset.page = String(entry.page);
    sheet.dataset.globalIndex = String(entry.globalIndex);
    sheet.setAttribute("aria-label", `${entry.documentItem.chineseTitle || entry.documentItem.title} 第 ${entry.page} 页`);

    const image = document.createElement("img");
    image.className = "page-image";
    image.loading = "lazy";
    image.decoding = "async";
    image.dataset.src = encodePageImagePath(entry.documentItem, entry.page);
    image.alt = `${entry.documentItem.chineseTitle || entry.documentItem.title} 第 ${entry.page} 页`;

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "page-retry";
    retryButton.textContent = "重新加载";
    retryButton.addEventListener("click", () => retryPageImageLoad(image));

    sheet.append(image, retryButton);
    fragment.append(sheet);
  });
  elements.pageStack.replaceChildren(fragment);
  state.renderedDocId = BOOK_RENDER_ID;
  elements.viewerWrap.scrollTop = 0;
  elements.viewerWrap.scrollLeft = 0;
  observePageImages();
}

function disconnectPageImageObserver() {
  if (state.pageImageObserver) {
    state.pageImageObserver.disconnect();
    state.pageImageObserver = null;
  }
}

function observePageImages() {
  const images = [...elements.pageStack.querySelectorAll(".page-image")];
  if (!("IntersectionObserver" in window)) {
    images.forEach((image) => requestPageImageLoad(image));
    return;
  }
  state.pageImageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        requestPageImageLoad(entry.target);
        state.pageImageObserver.unobserve(entry.target);
      });
    },
    {
      root: elements.viewerWrap,
      rootMargin: PAGE_OBSERVER_MARGIN,
      threshold: 0.01,
    }
  );
  images.forEach((image) => state.pageImageObserver.observe(image));
}

function requestPageImageLoad(image, priority = "auto") {
  if (!image || image.src) {
    return;
  }
  configurePageImageRequest(image, priority);
  setPageImageState(image, "loading");
  image.addEventListener("load", () => setPageImageState(image, "loaded"), { once: true });
  image.addEventListener(
    "error",
    () => {
      image.removeAttribute("src");
      image.src = "";
      setPageImageState(image, "error");
    },
    { once: true }
  );
  image.src = image.dataset.src;
}

/**
 * 配置页图请求优先级：后台预加载必须关闭 lazy，否则远离视口时浏览器可能不下载。
 */
function configurePageImageRequest(image, priority = "auto") {
  if (priority === "high" || priority === "background") {
    image.loading = "eager";
    if ("fetchPriority" in image) {
      image.fetchPriority = priority === "high" ? "high" : "low";
    }
  }
}

function setPageImageState(image, status) {
  const sheet = image?.closest?.(".page-sheet") || image?.parentElement || null;
  const statusClasses = ["is-loading", "is-loaded", "is-error"];
  if (sheet?.classList) {
    sheet.classList.remove(...statusClasses);
    sheet.classList.add(`is-${status}`);
  }
  if (image?.classList) {
    if (status === "loaded") {
      image.classList.add("is-loaded");
    } else {
      image.classList.remove("is-loaded");
    }
  }
}

function retryPageImageLoad(image) {
  if (!image) {
    return;
  }
  image.removeAttribute("src");
  image.src = "";
  requestPageImageLoad(image, "high");
}

function warmNearbyPageImages(documentItem, centerPage) {
  getBookPageWindow(documentItem.id, centerPage).forEach((entry) => {
    const image = getPageImageElement(entry);
    if (!image) {
      return;
    }
    requestPageImageLoad(image, "high");
    decodePageImage(image);
  });
}

function cancelBackgroundPagePreload() {
  if (state.backgroundPreloadTimer) {
    window.clearTimeout(state.backgroundPreloadTimer);
  }
  state.backgroundPreloadTimer = null;
  state.backgroundPreloadDocId = null;
}

function scheduleBackgroundPagePreload(documentItem, centerPage) {
  cancelBackgroundPagePreload();
  const pageQueue = getBackgroundBookPreloadPageOrder(documentItem.id, centerPage);
  if (!pageQueue.length) {
    return;
  }
  state.backgroundPreloadDocId = documentItem.id;

  const loadNextBatch = () => {
    if (state.activeDocId !== documentItem.id || state.backgroundPreloadDocId !== documentItem.id) {
      return;
    }
    let loadedCount = 0;
    while (pageQueue.length && loadedCount < BACKGROUND_PRELOAD_BATCH_SIZE) {
      const entry = pageQueue.shift();
      const image = getPageImageElement(entry);
      if (!image || image.src) {
        continue;
      }
      requestPageImageLoad(image, "background");
      loadedCount += 1;
    }
    state.backgroundPreloadTimer = pageQueue.length
      ? window.setTimeout(loadNextBatch, BACKGROUND_PRELOAD_BATCH_DELAY_MS)
      : null;
  };

  state.backgroundPreloadTimer = window.setTimeout(loadNextBatch, BACKGROUND_PRELOAD_START_DELAY_MS);
}

function decodePageImage(image) {
  const imageUrl = image.currentSrc || image.src || image.dataset.src;
  if (!imageUrl || state.warmedImageUrls.has(imageUrl) || typeof image.decode !== "function") {
    return;
  }
  state.warmedImageUrls.add(imageUrl);
  image.decode().catch(() => {
    state.warmedImageUrls.delete(imageUrl);
  });
}

function scrollToPage(docId, pageNumber, behavior = "auto") {
  const pageEntry = getBookPageWindow(docId, pageNumber, 0)[0];
  const targetPage = pageEntry
    ? elements.pageStack.querySelector(`[data-global-index="${pageEntry.globalIndex}"]`)
    : null;
  if (!targetPage) {
    return;
  }
  elements.viewerWrap.scrollTo({
    top: Math.max(0, targetPage.offsetTop - 24),
    left: 0,
    behavior,
  });
}

function updatePageControls(documentItem = getDocumentById(state.activeDocId)) {
  if (!documentItem) {
    return;
  }
  elements.pageInput.max = String(documentItem.pageCount);
  elements.pageInput.value = String(state.activePage);
  elements.prevPageButton.disabled = !getAdjacentBookPage(documentItem.id, state.activePage, -1);
  elements.nextPageButton.disabled = !getAdjacentBookPage(documentItem.id, state.activePage, 1);
}

function updateTocActiveState(documentItem = getDocumentById(state.activeDocId)) {
  if (!documentItem) {
    return;
  }
  const activeSection = getActiveSection(documentItem);
  document.querySelectorAll(".toc-document").forEach((item) => {
    const isExpanded = item.dataset.docId === documentItem.id;
    item.classList.toggle("is-expanded", isExpanded);
    const sublist = item.querySelector(".toc-sublist");
    if (sublist) {
      sublist.hidden = !isExpanded;
    }
  });
  document.querySelectorAll(".toc-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.docId === documentItem.id);
    const hasSections = button.closest(".toc-document")?.querySelector(".toc-sublist");
    button.setAttribute("aria-expanded", String(button.dataset.docId === documentItem.id && Boolean(hasSections)));
  });
  document.querySelectorAll(".toc-section-button").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.docId === documentItem.id && button.dataset.sectionId === activeSection?.id
    );
  });
}

function updateReaderHeader(documentItem) {
  elements.currentCategory.textContent = documentItem.category;
  elements.currentTitle.textContent = documentItem.chineseTitle || documentItem.title;
  elements.pageInput.max = String(documentItem.pageCount);
  elements.pageInput.value = String(state.activePage);
}

function syncPageFromScroll() {
  if (!elements.pageStack.children.length) {
    return;
  }
  const marker = elements.viewerWrap.scrollTop + elements.viewerWrap.clientHeight * 0.35;
  let currentDocId = state.activeDocId;
  let currentPage = state.activePage;
  for (const sheet of elements.pageStack.querySelectorAll(".page-sheet")) {
    if (sheet.offsetTop <= marker) {
      currentDocId = sheet.dataset.docId || currentDocId;
      currentPage = Number.parseInt(sheet.dataset.page || "1", 10);
    } else {
      break;
    }
  }
  if (currentDocId !== state.activeDocId || currentPage !== state.activePage) {
    const documentItem = getDocumentById(currentDocId);
    if (!documentItem) {
      return;
    }
    state.activeDocId = currentDocId;
    state.activePage = currentPage;
    updateReaderHeader(documentItem);
    warmNearbyPageImages(documentItem, currentPage);
    scheduleBackgroundPagePreload(documentItem, currentPage);
    updatePageControls(documentItem);
    updateTocActiveState(documentItem);
    updateHash();
  }
}

function scheduleScrollSync() {
  window.clearTimeout(state.scrollSyncTimer);
  state.scrollSyncTimer = window.setTimeout(syncPageFromScroll, 80);
}

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, " ");
}

function tokenizeQuery(query) {
  return normalizeQuery(query)
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function entryMatches(entry, terms) {
  if (state.activeCategory !== "全部" && entry.category !== state.activeCategory) {
    return false;
  }
  if (!terms.length) {
    return false;
  }
  const haystack = (entry.text || "").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function scoreEntry(entry, terms) {
  const text = (entry.text || "").toLowerCase();
  return terms.reduce((score, term) => {
    const firstIndex = text.indexOf(term);
    if (firstIndex < 0) {
      return score;
    }
    const titleHit = entry.title.toLowerCase().includes(term) ? 20 : 0;
    const headingHit = entry.heading.toLowerCase().includes(term) ? 14 : 0;
    return score + titleHit + headingHit + Math.max(1, 8 - Math.floor(firstIndex / 80));
  }, 0);
}

function makeResultSnippet(entry, terms) {
  const text = entry.text || entry.snippet || "";
  if (!terms.length) {
    return entry.snippet || "";
  }
  const lowerText = text.toLowerCase();
  const firstTerm = terms.find((term) => lowerText.includes(term)) || terms[0];
  const index = lowerText.indexOf(firstTerm);
  if (index < 0) {
    return entry.snippet || text.slice(0, 150);
  }
  const start = Math.max(0, index - 46);
  const end = Math.min(text.length, index + 150);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function highlightTerms(text, terms) {
  let escaped = escapeHtml(text);
  terms
    .filter((term) => term.length > 0)
    .sort((first, second) => second.length - first.length)
    .forEach((term) => {
      const pattern = new RegExp(escapeRegExp(escapeHtml(term)), "gi");
      escaped = escaped.replace(pattern, (match) => `<mark>${match}</mark>`);
    });
  return escaped;
}

function performSearch() {
  const query = normalizeQuery(elements.searchInput.value);
  state.query = query;
  const terms = tokenizeQuery(query);
  const results = searchIndex
    .filter((entry) => entryMatches(entry, terms))
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .sort((first, second) => second.score - first.score || first.entry.page - second.entry.page)
    .slice(0, 80)
    .map((item) => item.entry);

  renderSearchResults(results, terms);
  updateHash();
}

function renderSearchResults(results, terms) {
  elements.searchResults.innerHTML = "";
  if (!terms.length) {
    elements.searchSummary.textContent = "输入关键词后显示命中位置";
    elements.searchResults.innerHTML = `<div class="empty-state">输入后会像地址栏建议一样显示章节、页码和命中片段。</div>`;
    updateSearchPopover();
    return;
  }

  elements.searchSummary.textContent = `找到 ${results.length} 处`;
  if (!results.length) {
    elements.searchResults.innerHTML = `<div class="empty-state">没有找到匹配内容。</div>`;
    updateSearchPopover(true);
    return;
  }

  const fragment = document.createDocumentFragment();
  results.forEach((entry) => {
    const documentItem = getDocumentById(entry.docId);
    const accent = categoryAccentMap.get(entry.category) || "#2563eb";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.style.setProperty("--result-accent", accent);
    button.innerHTML = `
      <span class="result-title">${escapeHtml(documentItem?.chineseTitle || entry.title)}</span>
      <span class="result-meta">${escapeHtml(entry.category)} · 第 ${entry.page} 页 · ${escapeHtml(entry.heading)}</span>
      <span class="result-snippet">${highlightTerms(makeResultSnippet(entry, terms), terms)}</span>
    `;
    button.addEventListener("pointerdown", (event) => selectSearchResult(event, entry));
    button.addEventListener("click", (event) => selectSearchResult(event, entry));
    fragment.append(button);
  });
  elements.searchResults.append(fragment);
  updateSearchPopover(true);
}

function selectSearchResult(event, entry) {
  event.preventDefault();
  event.stopPropagation();
  closeSearchPopover({ clearQuery: true });
  openDocument(entry.docId, entry.page);
}

function closeSearchPopover(options = {}) {
  const { clearQuery = false } = options;
  if (clearQuery) {
    state.query = "";
    elements.searchInput.value = "";
    elements.searchResults.innerHTML = "";
    elements.searchSummary.textContent = "输入关键词后显示命中位置";
  }
  elements.searchBox.classList.remove("is-open");
  elements.searchInput.blur();
}

function updateSearchPopover(forceOpen = false) {
  const hasQuery = normalizeQuery(elements.searchInput.value).length > 0;
  const isFocused = document.activeElement === elements.searchInput;
  elements.searchBox.classList.toggle("is-open", forceOpen || hasQuery || isFocused);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", () => performSearch());
  elements.searchInput.addEventListener("focus", () => updateSearchPopover());
  document.addEventListener("click", (event) => {
    if (!elements.searchBox.contains(event.target)) {
      closeSearchPopover();
    }
  });
  elements.searchBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSearchPopover();
    }
  });
  elements.pageInput.addEventListener("change", () => {
    const pageNumber = Number.parseInt(elements.pageInput.value || "1", 10);
    openDocument(state.activeDocId, pageNumber);
  });
  elements.viewerWrap.addEventListener("scroll", scheduleScrollSync, { passive: true });
  elements.prevPageButton.addEventListener("click", () => {
    const previousPage = getAdjacentBookPage(state.activeDocId, state.activePage, -1);
    if (previousPage) {
      openDocument(previousPage.docId, previousPage.page);
    }
  });
  elements.nextPageButton.addEventListener("click", () => {
    const nextPage = getAdjacentBookPage(state.activeDocId, state.activePage, 1);
    if (nextPage) {
      openDocument(nextPage.docId, nextPage.page);
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function registerServiceWorker() {
  if (!canRegisterServiceWorker()) {
    return Promise.resolve(null);
  }
  return navigator.serviceWorker.register(getServiceWorkerUrl(), { scope: "./" }).catch((error) => {
    console.warn("Service Worker 注册失败，页面仍会按普通模式加载。", error);
    return null;
  });
}

function init() {
  bindElements();
  restoreStateFromHash();
  renderMeta();
  renderToc();
  renderSubjectTabs();
  bindEvents();
  registerServiceWorker();
  openDocument(state.activeDocId, state.activePage);
  performSearch();
}

document.addEventListener("DOMContentLoaded", init);
