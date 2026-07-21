/* =========================================================
 * TTS 万智牌牌表导出工具（中文卡图版）
 * 流程：解析牌表 → 查 Scryfall 拿 UUID → 拼大学院废墟(mtgch) 中文图
 *       → 生成并导出 TTS 可用的 JSON
 * ========================================================= */

// ---------- 常量 ----------
const BASIC_LANDS = ["Island", "Mountain", "Swamp", "Forest", "Plains"];
const SCRYFALL_BACK =
  "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";

// 复用参考 deck.json 中的 Transform 字面量
const DECK_TRANSFORM = {
  posX: 0.1779872,
  posY: 3.08887124,
  posZ: 0.29411754,
  rotX: 358.469971,
  rotY: 179.966263,
  rotZ: 1.77417183,
  scaleX: 1.0,
  scaleY: 1.0,
  scaleZ: 1.0,
};
const CARD_TRANSFORM = {
  posX: 0.5254047,
  scaleZ: 1,
  rotX: -0.0008576067,
  posY: 1.21068287,
  scaleY: 1,
  scaleX: 1,
  rotZ: 179.9986,
  posZ: 0.19025977,
  rotY: 180.000061,
};
const COLOR_DIFFUSE = { r: 0.713235259, g: 0.713235259, b: 0.713235259 };

// ---------- DOM 引用 ----------
const $ = (id) => document.getElementById(id);
const deckInput = $("deckInput");
const inputCount = $("inputCount");
const importBtn = $("importBtn");
const clearBtn = $("clearBtn");
const importStatus = $("importStatus");
const statTotal = $("statTotal");
const statTypes = $("statTypes");
const prevPage = $("prevPage");
const nextPage = $("nextPage");
const pageInd = $("pageInd");
const cardGrid = $("cardGrid");
const cardCount = $("cardCount");
const exportBtn = $("exportBtn");
const printBtn = $("printBtn");
const optFix = $("optFix");
const optZh = $("optZh");
const optToken = $("optToken");
const statTokens = $("statTokens");

// ---------- 状态 ----------
let deckData = null; // { instances, totalCount, typeCount }
let previewInstances = [];
let currentPage = 0;
const PAGE_SIZE = 9; // 预览固定 3×3 张

// =========================================================
// 1. 解析牌表
// =========================================================
function parseDeck(text) {
  const lines = text.split(/\r?\n/);
  const cards = [];
  let warned = false;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 注释行（以 // 开头）跳过，例如 // Maindeck、// Sideboard 等区块标题
    if (line.startsWith("//")) continue;

    // 数量 卡名 (系列) [编号]
    const m = line.match(/^(\d+)\s+(.+?)(?:\s+\(([^)]+)\)(?:\s+(\d+))?)?\s*$/);
    if (!m) {
      warned = true;
      continue;
    }
    const qty = parseInt(m[1], 10);
    let name = m[2].split("//")[0].trim(); // 双面卡取正面
    const set = m[3] || null;
    if (name) cards.push({ qty, name, set });
  }
  return { cards, warned };
}

// =========================================================
// 2. 查 Scryfall 拿 UUID（带缓存 + 自动修复）
// =========================================================
const cardCache = new Map();

async function lookupCard(name, set, autoFix) {
  const key = set ? `${name}|${set}` : name;
  if (cardCache.has(key)) return cardCache.get(key);

  const q = encodeURIComponent(name);
  let url = `https://api.scryfall.com/cards/named?exact=${q}`;
  if (set) url += `&set=${encodeURIComponent(set)}`;

  let info = await fetchJson(url);
  if (!info && autoFix) {
    // 自动修复：退化为模糊搜索
    const sq = encodeURIComponent(`!"${name}"${set ? " set:" + set : ""}`);
    const sUrl = `https://api.scryfall.com/cards/search?q=${sq}&unique=cards`;
    const sData = await fetchJson(sUrl, true);
    if (sData && sData.data && sData.data.length) {
      info = sData.data[0];
    }
  }

  const result = info
    ? {
        id: info.id,
        enUrl:
          info.image_uris?.normal ||
          info.card_faces?.[0]?.image_uris?.normal ||
          null,
        name: info.name,
        // 该卡在游戏中会生成的指示物（来自 all_parts 中 component === "token"）
        tokens: (info.all_parts || [])
          .filter((p) => p.component === "token")
          .map((p) => ({ id: p.id, name: p.name })),
      }
    : null;
  cardCache.set(key, result);
  return result;
}

async function fetchJson(url, isList) {
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

// 按 Scryfall id 取指示物卡数据（带缓存）
const tokenCache = new Map();
async function fetchTokenInfo(id) {
  if (tokenCache.has(id)) return tokenCache.get(id);
  const info = await fetchJson(`https://api.scryfall.com/cards/${id}`);
  const result = info
    ? {
        id: info.id,
        name: info.name,
        enUrl:
          info.image_uris?.normal ||
          (info.card_faces && info.card_faces[0]?.image_uris?.normal) ||
          null,
      }
    : null;
  tokenCache.set(id, result);
  return result;
}

// =========================================================
// 3. 拼中文卡图 URL（大学院废墟）
// =========================================================
function mtgchUrl(id) {
  return `https://images.mtgch.com/zhs/large/front/${id[0]}/${id[1]}/${id}.webp`;
}

// 经参考站代理转发 Scryfall 图：TTS 直连 cards.scryfall.io 会被拦，
// 但 tts-magic-booster.fly.dev/i/ 可正常加载。
// 注：卡背 backs.scryfall.io 在 TTS 可直连，故不代理。
function proxify(url) {
  if (!url) return url;
  return "https://tts-magic-booster.fly.dev/i/" + url.replace(/^https?:\/\//, "");
}

// 校验图片是否可达（浏览器内不受 CORS 限制，onerror 可捕获）
function verifyImage(url, timeout = 4000) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    // 超时也算失败，回退英文
    setTimeout(() => finish(false), timeout);
    img.src = url;
  });
}

// 决定卡图地址，返回两个：
//  - faceUrl   → 写入 TTS JSON 用（基础地/英文图经代理，确保 TTS 可加载）
//  - displayUrl→ 浏览器直连展示用（预览/弹窗/打印，不经代理，避免代理在浏览器里不稳定）
// 规则：
//  - 基础地 / 不想要中文 → 英文 Scryfall 图（导出代理、展示直连）
//  - 否则尝试 mtgch 中文图（本身可直连，导出/展示同一地址），失败再回退英文
async function resolveFaceUrl(info, preferZh) {
  if (!info) return { faceUrl: null, displayUrl: null };
  if (BASIC_LANDS.includes(info.name) || !preferZh) {
    return { faceUrl: proxify(info.enUrl), displayUrl: info.enUrl };
  }
  const zh = mtgchUrl(info.id);
  const ok = await verifyImage(zh);
  return ok
    ? { faceUrl: zh, displayUrl: zh }
    : { faceUrl: proxify(info.enUrl), displayUrl: info.enUrl };
}

// =========================================================
// 4. 限流并发
// =========================================================
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// =========================================================
// 5. 导入主流程
// =========================================================
async function importDeck() {
  const text = deckInput.value;
  if (!text.trim()) {
    setStatus("请先粘贴牌表内容。", "error");
    return;
  }
  const { cards, warned } = parseDeck(text);
  if (!cards.length) {
    setStatus("未能解析出任何卡牌，请检查牌表格式。", "error");
    return;
  }

  importBtn.disabled = true;
  setStatus("正在查询卡牌信息…", "");

  // 展开为实例（不再区分主牌/备牌，整副牌作为一个卡组）
  const instances = [];
  for (const c of cards)
    for (let k = 0; k < c.qty; k++) instances.push({ ...c });

  // 去重查询
  const uniqueMap = new Map();
  for (const inst of instances) {
    const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
    if (!uniqueMap.has(key)) uniqueMap.set(key, inst);
  }
  const uniqueCards = [...uniqueMap.values()];
  const autoFix = optFix.checked;
  const lookups = await Promise.all(
    uniqueCards.map((c) => lookupCard(c.name, c.set, autoFix))
  );
  const infoMap = new Map();
  uniqueCards.forEach((c, i) => {
    infoMap.set(c.set ? `${c.name}|${c.set}` : c.name, lookups[i]);
  });

  // 解析每张实例的最终图（限流 + 可达性校验）
  const preferZh = optZh.checked;
  await mapLimit(instances, 5, async (inst) => {
    const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
    const info = infoMap.get(key);
    const r = await resolveFaceUrl(info, preferZh);
    inst.faceUrl = r.faceUrl;
    inst.displayUrl = r.displayUrl;
    inst.enUrl = info?.enUrl || null;
    inst.found = !!info;
  });

  const totalCount = instances.length;
  const typeCount = uniqueCards.length;
  const missing = instances.filter((i) => !i.found).length;

  // 自动收集指示物：汇总所有主牌 all_parts 里的 token（按 id 去重）
  const tokens = [];
  let tokenMissing = 0;
  if (optToken.checked) {
    const tokenIdMap = new Map();
    for (const info of infoMap.values()) {
      if (info && info.tokens) {
        for (const t of info.tokens) {
          if (!tokenIdMap.has(t.id)) tokenIdMap.set(t.id, t.name);
        }
      }
    }
    if (tokenIdMap.size) {
      importBtn.disabled = true;
      setStatus(`正在查询 ${tokenIdMap.size} 个指示物…`, "");
      const tokenInfos = await Promise.all(
        [...tokenIdMap.keys()].map((id) => fetchTokenInfo(id))
      );
      for (const ti of tokenInfos) {
        if (!ti || !ti.enUrl) {
          tokenMissing++;
          continue;
        }
        tokens.push({
          name: ti.name,
          faceUrl: proxify(ti.enUrl),
          displayUrl: ti.enUrl,
          enUrl: ti.enUrl,
          isToken: true,
        });
      }
    }
  }

  deckData = { instances, tokens, totalCount, typeCount, tokenCount: tokens.length };

  statTotal.textContent = totalCount;
  statTypes.textContent = typeCount;
  statTokens.textContent = tokens.length;

  // 初始化分页并渲染第一页（主牌在前，指示物在后）
  previewInstances = [...instances, ...tokens];
  currentPage = 0;
  renderPage();
  exportBtn.disabled = false;
  printBtn.disabled = false;

  let msg = `导入成功：${totalCount} 张卡（${typeCount} 种）`;
  if (tokens.length) msg += ` · ${tokens.length} 个指示物`;
  if (missing > 0) msg += `；${missing} 张卡未找到，已用占位。`;
  else if (warned) msg += "；部分无法识别的行已跳过。";
  if (tokenMissing > 0) msg += `；${tokenMissing} 个指示物获取失败已跳过。`;
  setStatus(msg, missing > 0 || tokenMissing > 0 ? "error" : "ok");
  importBtn.disabled = false;
}

// =========================================================
// 6. 预览渲染
// =========================================================
function renderPage() {
  const total = previewInstances.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage >= pageCount) currentPage = pageCount - 1;
  if (currentPage < 0) currentPage = 0;

  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageItems = previewInstances.slice(start, end);

  cardGrid.innerHTML = "";
  for (const inst of pageItems) {
    const cell = document.createElement("div");
    cell.className = "card-cell loading";
    const img = document.createElement("img");
    img.alt = inst.name;
    img.loading = "lazy";
    img.onload = () => cell.classList.remove("loading");
    img.onerror = () => {
      cell.classList.remove("loading");
      // 直连图失败时回退英文原图
      if (inst.enUrl && img.src !== inst.enUrl) img.src = inst.enUrl;
    };
    img.src = inst.displayUrl || inst.faceUrl || inst.enUrl || "";
    cell.appendChild(img);

    // 悬浮放大：跟随鼠标显示大图
    attachHoverZoom(cell, inst.displayUrl || inst.enUrl, inst.enUrl);

    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = inst.name;
    cell.appendChild(name);

    // 指示物角标
    if (inst.isToken) {
      cell.classList.add("token-cell");
      const badge = document.createElement("div");
      badge.className = "token-badge";
      badge.textContent = "指示物";
      cell.appendChild(badge);
    }

    cardGrid.appendChild(cell);
  }

  // 更新计数与翻页控件
  if (total) {
    cardCount.textContent = `第 ${currentPage + 1} / ${pageCount} 页 · 显示 ${start + 1}–${end} / 共 ${total} 张`;
  } else {
    cardCount.textContent = "显示 0 / 0 张";
  }
  pageInd.textContent = `第 ${currentPage + 1} / ${pageCount} 页`;
  prevPage.disabled = currentPage <= 0;
  nextPage.disabled = currentPage >= pageCount - 1;
}

// =========================================================
// 7. 生成 TTS JSON
// =========================================================
function buildTTSJson(instances, tokens = []) {
  const N = instances.length;
  const deckIds = [];
  const customDeck = {};
  const contained = [];

  for (let i = 0; i < N; i++) {
    const inst = instances[i];
    const idx = i + 1;
    const cardId = idx * 100;
    const face = inst.faceUrl || inst.enUrl || "";
    deckIds.push(cardId);
    customDeck[String(idx)] = {
      NumHeight: 1,
      BackIsHidden: true,
      UniqueBack: false,
      BackURL: SCRYFALL_BACK,
      FaceURL: face,
      NumWidth: 1,
    };
    contained.push({
      Description: "",
      Nickname: inst.name,
      ColorDiffuse: { ...COLOR_DIFFUSE },
      Name: "CardCustom",
      CardID: cardId,
      Transform: { ...CARD_TRANSFORM },
      CustomDeck: {
        [String(idx)]: {
          NumHeight: 1,
          BackIsHidden: true,
          UniqueBack: false,
          FaceURL: face,
          NumWidth: 1,
          BackURL: SCRYFALL_BACK,
        },
      },
      HideWhenFaceDown: true,
    });
  }

  const guid = Math.random().toString(16).slice(2, 7);

  const deckState = {
    Name: "Deck",
    Transform: { ...DECK_TRANSFORM },
    Nickname: "",
    Description: "",
    GMNotes: "",
    ColorDiffuse: { ...COLOR_DIFFUSE },
    Locked: false,
    Grid: true,
    Snap: true,
    IgnoreFoW: false,
    Autoraise: true,
    Sticky: true,
    Tooltip: true,
    GridProjection: false,
    HideWhenFaceDown: true,
    Hands: false,
    SidewaysCard: false,
    DeckIDs: deckIds,
    CustomDeck: customDeck,
    XmlUI: "",
    LuaScript: "",
    LuaScriptState: "",
    ContainedObjects: contained,
    GUID: guid,
  };

  // 指示物作为独立 CardCustom 对象，排在主牌堆右侧的网格里（不混入牌堆）
  const objectStates = [deckState];
  const baseX = DECK_TRANSFORM.posX + 3.0;
  const baseZ = DECK_TRANSFORM.posZ;
  const COLS = 6;
  const GAP = 1.7;
  tokens.forEach((t, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const idx = i + 1;
    const face = t.faceUrl || t.enUrl || "";
    objectStates.push({
      Description: "",
      Nickname: t.name,
      ColorDiffuse: { ...COLOR_DIFFUSE },
      Name: "CardCustom",
      CardID: idx * 100 + 1,
      Transform: {
        posX: baseX + col * GAP,
        posY: DECK_TRANSFORM.posY,
        posZ: baseZ + row * GAP,
        rotX: 0,
        rotY: 180,
        rotZ: 180,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
      CustomDeck: {
        [String(idx)]: {
          NumHeight: 1,
          BackIsHidden: true,
          UniqueBack: false,
          FaceURL: face,
          NumWidth: 1,
          BackURL: SCRYFALL_BACK,
        },
      },
      HideWhenFaceDown: true,
    });
  });

  return {
    SaveName: "",
    GameMode: "",
    Gravity: 0.5,
    PlayArea: 0.5,
    Date: "",
    Table: "",
    Sky: "",
    Note: "",
    Rules: "",
    XmlUI: "",
    LuaScript: "",
    LuaScriptState: "",
    ObjectStates: objectStates,
    TabStates: {},
    VersionNumber: "",
  };
}

function exportJson() {
  if (!deckData) return;
  const json = buildTTSJson(deckData.instances, deckData.tokens || []);
  const blob = new Blob([JSON.stringify(json, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "deck_tts.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("已导出 deck_tts.json，放入 TTS 的 Saved Objects 文件夹即可。", "ok");
}

// =========================================================
// 7.5 打印卡图（A4 · 3×3=9 张/页 · 真实 MTG 尺寸）
// 参考 17lands 卡图替换脚本的「打印卡图」实现：生成打印级 HTML，
// 浏览器原生支持 @page / mm 单位 / table，打开即弹打印对话框。
// 注意：本工具为纯网页（无 userscript 跨域特权），故打印页直接引用
// 已验证可加载的 faceUrl（mtgch 中文图 / 代理 Scryfall 图），在线打印即可。
// =========================================================
const PRINT_COLS = 3;
const PRINT_ROWS = 3;
const PRINT_PER_PAGE = PRINT_COLS * PRINT_ROWS;

// 构建自包含的打印 HTML（每页 9 张，A4 分页）
function buildPrintHtml(items) {
  let pages = "";
  for (let p = 0; p < items.length; p += PRINT_PER_PAGE) {
    let rows = "";
    for (let r = 0; r < PRINT_ROWS; r++) {
      let cells = "";
      for (let c = 0; c < PRINT_COLS; c++) {
        const it = items[p + r * PRINT_COLS + c];
        if (it && it.faceUrl) {
          const fb =
            it.enUrl && it.enUrl !== it.faceUrl
              ? ` onerror="this.onerror=null;this.src='${it.enUrl}'"`
              : "";
          cells += `<td><img src="${it.faceUrl}"${fb} alt=""></td>`;
        } else {
          cells += "<td></td>";
        }
      }
      rows += "<tr>" + cells + "</tr>";
    }
    pages += `<table class="pg">${rows}</table>`;
  }
  return (
    "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>MTG 卡图打印</title><style>" +
    "@page{size:A4 portrait;margin:2.5mm}" +
    "*{margin:0;padding:0;box-sizing:border-box}" +
    "body{background:#fff}" +
    "table.pg{width:205mm;height:292mm;margin:0 auto;border-collapse:collapse;table-layout:fixed;page-break-after:always;page-break-inside:avoid}" +
    "table.pg:last-child{page-break-after:auto}" +
    "table.pg td{width:68.333mm;height:97.333mm;padding:0;text-align:center;vertical-align:middle;border:none}" +
    "table.pg td img{width:62.5mm;height:87mm;display:block;object-fit:cover;margin:0 auto}" +
    "@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}" +
    "</style></head><body>" + pages +
    "<script>window.onload=function(){window.print()};<\/script></body></html>"
  );
}

// 在新标签页打开打印页（弹窗被拦截时退化为下载）
function openPrintHtml(html) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "mtg_cards_print.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStatus("已下载打印文件 mtg_cards_print.html，请打开后按 Ctrl/Cmd+P 打印。", "ok");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 指示物打印数量选择弹窗（参考脚本的 chooseTokenCounts）
function chooseTokenCounts(tokens) {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(45,27,78,.55);z-index:9999;display:flex;align-items:center;justify-content:center";
    const box = document.createElement("div");
    box.style.cssText =
      "background:var(--surface,#fff);color:var(--ink,#2d1b4e);border-radius:12px;padding:18px;max-width:520px;max-height:80vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.4);font-family:var(--font);min-width:300px";
    box.innerHTML =
      '<h3 style="margin:0 0 12px;font-size:16px">选择要打印的指示物数量</h3>' +
      '<div id="tk-list"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
      '<button id="tk-cancel" style="padding:8px 16px;border:0;border-radius:8px;background:#bbb;color:#fff;font-size:13px;font-weight:600;cursor:pointer">取消</button>' +
      '<button id="tk-ok" style="padding:8px 16px;border:0;border-radius:8px;background:var(--primary,#7c3aed);color:#fff;font-size:13px;font-weight:600;cursor:pointer">确认打印</button>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.appendChild(box);
    const list = box.querySelector("#tk-list");
    tokens.forEach((t) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;margin:6px 0";
      const dUrl = t.displayUrl || t.enUrl || t.faceUrl;
      const fUrl = t.enUrl || "";
      const thumb = document.createElement("img");
      thumb.src = dUrl;
      thumb.style.cssText =
        "width:48px;height:67px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#ccc);flex-shrink:0;cursor:zoom-in";
      thumb.onerror = () => {
        if (fUrl && thumb.src !== fUrl) thumb.src = fUrl;
      };
      attachHoverZoom(thumb, dUrl, fUrl);
      const nameSpan = document.createElement("span");
      nameSpan.style.cssText = "flex:1;font-size:13px";
      nameSpan.textContent = t.name || "指示物";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.value = "1";
      input.style.cssText =
        "width:56px;text-align:center;font-size:13px;padding:3px;border:1px solid #ccc;border-radius:4px";
      row.appendChild(thumb);
      row.appendChild(nameSpan);
      row.appendChild(input);
      list.appendChild(row);
    });
    const close = () => overlay.remove();
    box.querySelector("#tk-cancel").onclick = () => {
      close();
      reject("cancel");
    };
    box.querySelector("#tk-ok").onclick = () => {
      const inputs = box.querySelectorAll("input[type=number]");
      const out = [];
      inputs.forEach((inp, i) => {
        const n = parseInt(inp.value, 10) || 0;
        if (n > 0)
          out.push({
            faceUrl: tokens[i].faceUrl,
            displayUrl: tokens[i].displayUrl || tokens[i].enUrl,
            enUrl: tokens[i].enUrl,
            name: tokens[i].name,
            count: n,
          });
      });
      close();
      resolve(out);
    };
  });
}

// 主流程：拼装卡图清单 →（若有指示物）选数量 → 生成打印页
async function printCards() {
  if (!deckData) {
    setStatus("请先导入牌表再打印卡图。", "error");
    return;
  }
  // 打印页在浏览器内加载，用直连 displayUrl（避免代理不稳定），enUrl 作回退
  const items = deckData.instances.map((inst) => ({
    faceUrl: inst.displayUrl || inst.enUrl || inst.faceUrl,
    enUrl: inst.enUrl,
    name: inst.name,
  }));

  // 指示物：开启「自动导入指示物」且已收集到时才询问数量
  if (optToken.checked && deckData.tokens && deckData.tokens.length) {
    try {
      const chosen = await chooseTokenCounts(deckData.tokens);
      chosen.forEach((t) => {
        for (let i = 0; i < t.count; i++) {
          items.push({
            faceUrl: t.displayUrl || t.enUrl || t.faceUrl,
            enUrl: t.enUrl,
            name: t.name,
          });
        }
      });
    } catch (e) {
      // 用户取消指示物选择 → 仅打印主牌
    }
  }

  if (!items.length) {
    setStatus("没有可打印的卡图。", "error");
    return;
  }
  openPrintHtml(buildPrintHtml(items));
  const totalPages = Math.ceil(items.length / PRINT_PER_PAGE);
  setStatus(
    `已生成打印页面（${items.length} 张 · 约 ${totalPages} 页 A4），在弹出窗口按打印即可；指示物已一并包含。`,
    "ok"
  );
}

// =========================================================
// 7.6 悬浮放大：鼠标移到卡图上时，跟随光标显示大图
// =========================================================
let zoomEl = null;
function ensureZoomEl() {
  if (!zoomEl) {
    zoomEl = document.createElement("img");
    zoomEl.className = "card-zoom";
    zoomEl.style.display = "none";
    document.body.appendChild(zoomEl);
  }
  return zoomEl;
}

function attachHoverZoom(el, url, fallbackUrl) {
  if (!url) return;
  el.addEventListener("mouseenter", () => {
    const z = ensureZoomEl();
    z.onerror = () => {
      if (fallbackUrl && z.src !== fallbackUrl) z.src = fallbackUrl;
    };
    z.src = url;
    z.style.display = "block";
  });
  el.addEventListener("mousemove", (e) => {
    const z = ensureZoomEl();
    const w = 268;
    const h = 374;
    const pad = 18;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > window.innerWidth) x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = window.innerHeight - h - pad;
    if (y < pad) y = pad;
    z.style.left = x + "px";
    z.style.top = y + "px";
  });
  el.addEventListener("mouseleave", () => {
    if (zoomEl) zoomEl.style.display = "none";
  });
}

// =========================================================
// 8. 辅助 & 事件绑定
// =========================================================
function setStatus(msg, type) {
  importStatus.textContent = msg;
  importStatus.className = "import-status" + (type ? " " + type : "");
}

function updateInputCount() {
  const text = deckInput.value;
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  inputCount.textContent = `${lines} 行 · ${text.length} 字`;
}

deckInput.addEventListener("input", updateInputCount);

importBtn.addEventListener("click", importDeck);
exportBtn.addEventListener("click", exportJson);
printBtn.addEventListener("click", printCards);

clearBtn.addEventListener("click", () => {
  deckInput.value = "";
  updateInputCount();
  cardGrid.innerHTML = "";
  cardCount.textContent = "显示 0 / 0 张";
  statTotal.textContent = "0";
  statTypes.textContent = "0";
  statTokens.textContent = "0";
  previewInstances = [];
  currentPage = 0;
  pageInd.textContent = "第 1 / 1 页";
  prevPage.disabled = true;
  nextPage.disabled = true;
  exportBtn.disabled = true;
  printBtn.disabled = true;
  deckData = null;
  setStatus("", "");
});

// 翻页控件
prevPage.addEventListener("click", () => {
  if (currentPage > 0) {
    currentPage--;
    renderPage();
  }
});
nextPage.addEventListener("click", () => {
  const pageCount = Math.max(1, Math.ceil(previewInstances.length / PAGE_SIZE));
  if (currentPage < pageCount - 1) {
    currentPage++;
    renderPage();
  }
});

// URL 导入标签（本期未实现）
$("tabUrl").addEventListener("click", () => {
  setStatus("URL 导入功能即将推出，请暂时使用「牌表输入」粘贴文本。", "");
});

updateInputCount();
