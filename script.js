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
const PAGE_SIZE = 12; // 预览固定 4×3 张（上下布局全宽）

// =========================================================
// 1.5 卡图印刷版本选择（参考 mtgprint.net）
//    每张卡在预览中显示下拉菜单，可切换不同印刷的卡图
// =========================================================
const allPrintingsCache = new Map();

// 按 oracle_id 获取该卡的全部印刷（含 set/编号/图地址）
// 基础地印刷极多（数百个），跟随 Scryfall 分页全部获取；其他卡只取第一页
async function fetchAllPrintings(oracleId) {
  if (!oracleId) return [];
  if (allPrintingsCache.has(oracleId)) return allPrintingsCache.get(oracleId);

  const mapCard = (c) => ({
    id: c.id,
    name: c.name,
    set: c.set,
    setName: c.set_name || c.set,
    collectorNumber: c.collector_number,
    enUrl:
      c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || null,
    oracleId: c.oracle_id,
  });

  const firstUrl = `https://api.scryfall.com/cards/search?q=oracleid:${encodeURIComponent(
    oracleId
  )}&unique=prints&order=released&dir=desc`;
  const first = await fetchJson(firstUrl);
  if (!first || !first.data) {
    allPrintingsCache.set(oracleId, []);
    return [];
  }
  let printings = first.data.filter((c) => c.collector_number).map(mapCard);
  const isBasic = printings.some((p) => BASIC_LANDS.includes(p.name));

  // 基础地：跟随分页，最多再取 4 页（总计约 875 个），拿全所有美术
  if (isBasic && first.has_more) {
    let next = first.next_page;
    let pages = 1;
    while (next && pages < 5) {
      const d = await fetchJson(next);
      if (!d || !d.data) break;
      printings = printings.concat(
        d.data.filter((c) => c.collector_number).map(mapCard)
      );
      next = d.has_more ? d.next_page : null;
      pages++;
    }
  }
  allPrintingsCache.set(oracleId, printings);
  return printings;
}

// 为单张实例构建印刷选择器 <select>（所有找到的卡都显示，至少含当前版本）
// 参考 mtgprint.net：用 <optgroup> 按系列分组，每组标注数量
function buildPrintingSelect(inst) {
  if (!inst.allPrintings || inst.allPrintings.length === 0) return null;
  const sel = document.createElement("select");
  sel.className = "printing-select";
  sel.title = "切换卡图印刷版本（共 " + inst.allPrintings.length + " 种）";

  // 按系列分组
  const groups = new Map(); // setName -> [{p, idx}]
  inst.allPrintings.forEach(function (p, i) {
    const name = p.setName || p.set || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ p: p, idx: i });
  });

  let html = "";
  // 按系列内第一张卡的发行顺序排列组
  var sortedSetNames = Array.from(groups.keys()).sort(function (a, b) {
    var ai = groups.get(a)[0].idx;
    var bi = groups.get(b)[0].idx;
    return ai - bi; // 保持发行时间倒序（fetchAllPrintings 已排好）
  });
  sortedSetNames.forEach(function (setName) {
    var items = groups.get(setName);
    html +=
      '<optgroup label="' +
      escHtml(setName) +
      " (" +
      items.length +
      ')">';
    items.forEach(function (item) {
      html +=
        '<option value="' +
        item.idx +
        '"' +
        (item.idx === inst.selectedPrintingIdx ? " selected" : "") +
        ">" +
        escHtml(item.p.collectorNumber) +
        "</option>";
    });
    html += "</optgroup>";
  });
  sel.innerHTML = html;

  sel.addEventListener("change", async function () {
    await onPrintingChange(inst, parseInt(sel.value, 10));
    renderPage();
  });
  return sel;
}

// 用户选择了新印刷 → 重新解析该卡的 faceUrl / displayUrl
async function onPrintingChange(inst, idx) {
  const p = inst.allPrintings[idx];
  if (!p) return;
  inst.selectedPrintingIdx = idx;
  // 用新印刷的信息重新解析卡图（走中文优先逻辑）
  const preferZh = optZh.checked;
  const newInfo = {
    enUrl: p.enUrl,
    name: p.name,
    oracleId: p.oracleId,
    set: p.set,
    collectorNumber: p.collectorNumber,
  };
  const r = await resolveFaceUrl(newInfo, preferZh);
  inst.faceUrl = r.faceUrl;
  inst.displayUrl = r.displayUrl;
  inst.enUrl = p.enUrl;
}

// HTML 转义
function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

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
        oracleId: info.oracle_id || null,
        set: info.set || null,
        collectorNumber: info.collector_number || null,
        // 该卡在游戏中会生成的指示物（来自 all_parts 中 component === "token"）
        tokens: (info.all_parts || [])
          .filter((p) => p.component === "token")
          .map((p) => ({ id: p.id, name: p.name })),
      }
    : null;
  cardCache.set(key, result);
  return result;
}

// =========================================================
// Scryfall 请求调度器（限流核心）
// ---------------------------------------------------------
// 问题复盘：导入瞬间几十个请求并发 → Scryfall 限流(429)，而 429 错误响应不带 CORS 头，
// 浏览器拦截成 CORS 错误 → 印刷列表获取失败 → 卡牌没有下拉框。
// 关键：必须保证【全局请求速率】低于 Scryfall 软上限(10/sec)，否则必被限流。
// 做法：单一调度队列 —— 最多 N 个并发，且任意两次请求的【发起时刻】间隔 ≥ GLOBAL_GAP。
// 重试也走同一队列（绝不绕过调度器直接 fetch），因此无论网络快慢、是否重试，
// 总速率始终被压在限额内。
const SRV_MAX = 3; // 最大并发
const SRV_GLOBAL_GAP = 250; // 全局最小发起间隔(ms) → 总速率 ≈ 3/(reqTime+0.25) ≤ 限额
let _srvBusy = 0;
let _srvNextStart = 0;
const _srvQueue = [];
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function _enqueueFetch(task) {
  return new Promise((resolve, reject) => {
    _srvQueue.push({ task, resolve, reject });
    _pump();
  });
}
function _pump() {
  if (_srvQueue.length === 0) return;
  if (_srvBusy >= SRV_MAX) return;
  const now = Date.now();
  const target = Math.max(now, _srvNextStart);
  const wait = target - now;
  if (wait > 0) {
    setTimeout(_pump, wait + 1);
    return;
  }
  // 可以发起：占用并发槽，并预约下一个全局发起时刻
  _srvBusy++;
  _srvNextStart = target + SRV_GLOBAL_GAP;
  const { task, resolve, reject } = _srvQueue.shift();
  _runWorker(task)
    .then(resolve, reject)
    .finally(() => {
      _srvBusy--;
      _pump();
    });
}

// 单次尝试（不自带重试）：返回 {kind:'done', data} 或 {kind:'retry', backoff}
async function _tryFetchOnce(url, isList) {
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.status === 429) {
      const ra = parseInt(resp.headers.get("Retry-After") || "1", 10);
      return { kind: "retry", backoff: (isNaN(ra) ? 1 : ra) * 1000 };
    }
    if (!resp.ok) return { kind: "done", data: null };
    return { kind: "done", data: await resp.json() };
  } catch (e) {
    // CORS / 网络抖动（多为 429 无 CORS 头被拦截）
    return { kind: "retry", backoff: 400 };
  }
}

// 真正的限流锁：控制【实际 fetch 发起】的并发与间隔（与 worker 池解耦）。
// 重试在 worker 内部进行，等待期间释放锁，避免「重试重新入队」导致死锁。
let _rateBusy = 0;
let _rateNext = 0;
async function _rateAcquire() {
  for (;;) {
    const now = Date.now();
    const target = Math.max(now, _rateNext);
    if (_rateBusy < SRV_MAX && target <= now) {
      _rateBusy++;
      _rateNext = target + SRV_GLOBAL_GAP;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          _rateBusy--;
          _rateNext = Math.max(_rateNext, Date.now());
        }
      };
    }
    await _sleep(Math.max(8, target - now));
  }
}

// worker：获取限流锁 → 发起一次请求 → 若 429/CORS 则退避后重试（最多 6 次）。
// 重试的等待在「释放锁之后」进行，因此不会占用并发槽、不会死锁。
async function _runWorker(task) {
  for (let attempt = 0; attempt <= 6; attempt++) {
    const release = await _rateAcquire();
    let r;
    try {
      r = await _tryFetchOnce(task.url, task.isList);
    } finally {
      release(); // 取完图立即释放锁，退避等待不占槽
    }
    if (r.kind === "done") return r.data;
    await _sleep(r.backoff * (attempt + 1)); // 指数退避：随失败次数拉开间隔，避免重试风暴锤击 Scryfall
  }
  return null;
}

// 对外接口：所有 Scryfall 请求都经此调度，避免突发被限流
function fetchJson(url, isList) {
  return _enqueueFetch({ url, isList });
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
// 3. 拼中文卡图 URL（大学院废墟 / mtgch）
// =========================================================
// 关键修正：mtgch 的中文图用的是它【自己的 uuid】，≠ Scryfall 的卡 id。
// 之前用 Scryfall id 拼 URL 只能“撞巧”命中（如 2X2 Bolt 两者 id 恰好相同），
// 对大多数卡（如 GRN Healer's Hawk）会 404。正确做法是用 mtgch 官方 API：
//   GET https://mtgch.com/api/v1/card/{set}/{collector_number}/
// 从返回的 zhs_image_uris.large 取真实中文图地址。
// CORS：mtgch 反射任意 Origin（含本地 file:// 的 null），浏览器/本地均可跨域 fetch。
// 若某印刷没有中文（zhs_image_uris 缺失），API 返回里就没有该字段 → 直接回退英文。
const mtgchApiCache = new Map();
async function fetchMtgchZh(set, collectorNumber) {
  if (!set || !collectorNumber) return null;
  const key = set + "/" + collectorNumber;
  if (mtgchApiCache.has(key)) return mtgchApiCache.get(key);
  let url = null;
  try {
    const r = await fetch(
      `https://mtgch.com/api/v1/card/${encodeURIComponent(
        set
      )}/${encodeURIComponent(collectorNumber)}/`
    );
    if (r.ok) {
      const d = await r.json();
      const z = d.zhs_image_uris;
      if (z && z.large) url = z.large.split("?")[0]; // 去 ?ts= 缓存戳，TTS 加载更稳
    }
  } catch (e) {
    /* 跨域/网络失败 → 上层回退英文 */
  }
  mtgchApiCache.set(key, url);
  return url;
}

// 经参考站代理转发 Scryfall 英文图：TTS 直连 cards.scryfall.io 会被拦，
// 但 tts-magic-booster.fly.dev/i/ 可正常加载。
// 注：卡背 backs.scryfall.io 在 TTS 可直连，故不代理；mtgch 中文图在 TTS 也可直连，不代理。
function proxify(url) {
  if (!url) return url;
  return "https://tts-magic-booster.fly.dev/i/" + url.replace(/^https?:\/\//, "");
}

// 决定卡图地址，返回两个：
//  - faceUrl   → 写入 TTS JSON（mtgch 中文图可直连，故不代理；英文图才走代理）
//  - displayUrl→ 浏览器直连展示用（预览/弹窗/打印）
// 规则：
//  - 基础地 / 不想要中文 → 英文 Scryfall 图（导出代理、展示直连）
//  - 否则尝试 mtgch 中文图（仅当前系列）；若无中文图则回退英文
async function resolveFaceUrl(info, preferZh) {
  if (!info) return { faceUrl: null, displayUrl: null };
  if (BASIC_LANDS.includes(info.name) || !preferZh) {
    return { faceUrl: proxify(info.enUrl), displayUrl: info.enUrl };
  }
  // 当前系列中文图（用 set + collector_number 查 mtgch API 拿真实地址）
  const curZh = await fetchMtgchZh(info.set, info.collectorNumber);
  if (curZh) return { faceUrl: curZh, displayUrl: curZh };
  // 当前系列无中文图 → 回退英文
  return { faceUrl: proxify(info.enUrl), displayUrl: info.enUrl };
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

  // 解析每张实例的最终图（限流 + 中文图解析）
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

  // 批量获取每张卡的印刷版本列表（用于预览区下拉选择）
  setStatus("正在获取印刷版本列表…", "");
  const oracleIdSet = new Set();
  for (const inst of instances) {
    const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
    const info = infoMap.get(key);
    if (info?.oracleId) oracleIdSet.add(info.oracleId);
  }
  const printingsMap = new Map();
  await mapLimit([...oracleIdSet], 3, async (oid) => {
    printingsMap.set(oid, await fetchAllPrintings(oid));
  });
  // 将印刷列表挂到每个实例上
  for (const inst of instances) {
    const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
    const info = infoMap.get(key);
    const prints = info?.oracleId ? printingsMap.get(info.oracleId) || [] : [];
    inst.allPrintings = prints;
    // 定位当前印刷在列表中的索引
    const curIdx = prints.findIndex(
      (p) => p.set === info?.set && p.collectorNumber === info?.collectorNumber
    );
    inst.selectedPrintingIdx = curIdx >= 0 ? curIdx : 0;
  }

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
    // 外层包裹：卡格 + 下拉选择器
    const wrap = document.createElement("div");
    wrap.className = "printing-wrap";

    const cell = document.createElement("div");
    cell.className = "card-cell loading";
    const img = document.createElement("img");
    img.alt = inst.name;
    img.loading = "lazy";
    img.onload = () => cell.classList.remove("loading");
    img.onerror = () => {
      cell.classList.remove("loading");
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

    wrap.appendChild(cell);

    // 印刷版本选择下拉（放在卡格下方）
    const sel = buildPrintingSelect(inst);
    if (sel) wrap.appendChild(sel);

    cardGrid.appendChild(wrap);
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
