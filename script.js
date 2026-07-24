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

  let info = null;
  try {
    info = await fetchJson(url);
  } catch (e) {
    console.warn("Scryfall 查卡失败：", name, e);
  }
  if (!info && autoFix) {
    // 自动修复：退化为模糊搜索
    try {
      const sq = encodeURIComponent(`!"${name}"${set ? " set:" + set : ""}`);
      const sUrl = `https://api.scryfall.com/cards/search?q=${sq}&unique=cards`;
      const sData = await fetchJson(sUrl, true);
      if (sData && sData.data && sData.data.length) {
        info = sData.data[0];
      }
    } catch (e) {
      console.warn("Scryfall 模糊搜索失败：", name, e);
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
        setName: info.set_name || null,
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
// =========================================================
// Scryfall 请求客户端（限流 + 自动重试，单一实现）
// ---------------------------------------------------------
// 设计要点：
//  - 所有 Scryfall 请求统一走这里，杜绝「绕过调度器直接 fetch」导致的突发限流。
//  - 单一限流锁：并发数 ≤ MAX_CONCURRENT，且任意两次请求【发起时刻】间隔 ≥ MIN_INTERVAL_MS，
//    总速率被压在 Scryfall 软上限(10/sec) 以内，避免 429。
//  - 429 / 网络错误（多为 429 无 CORS 头被浏览器拦截成 CORS 错误）自动指数退避重试；
//    HTTP 404 等确定性无数据返回 null（不重试）。
//  - 持续失败（超过重试上限）抛错，由调用方决定降级策略；【失败不缓存】，
//    因此重新导入仍可重试，不会出现「某张卡永久没有下拉框」。
// =========================================================
const ScryfallClient = (() => {
  const MAX_CONCURRENT = 3; // 最大并发请求数
  const MIN_INTERVAL_MS = 250; // 任意两次请求发起时刻的最小间隔
  const MAX_RETRIES = 4; // 429 / 网络错误的重试次数

  let active = 0; // 当前在途请求数
  let nextStart = 0; // 下一个允许发起请求的时刻

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 在限流锁保护下获取一个「发起名额」：保证并发与间隔约束；返回释放函数
  async function acquire() {
    for (;;) {
      const now = Date.now();
      const target = Math.max(now, nextStart);
      if (active < MAX_CONCURRENT && target <= now) {
        active++;
        nextStart = target + MIN_INTERVAL_MS;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            active--;
          }
        };
      }
      await sleep(Math.max(5, target - now));
    }
  }

  // 单次 HTTP 尝试：成功返回 JSON；确定性无数据(404 等)返回 null；需重试的情况抛错
  async function requestOnce(url, isList) {
    try {
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.status === 429) {
        const ra = parseInt(resp.headers.get("Retry-After") || "1", 10);
        const err = new Error("rate-limited");
        err.retryAfter = (isNaN(ra) ? 1 : ra) * 1000;
        throw err;
      }
      if (!resp.ok) return null; // 确定性失败（如 404）→ 无数据，不重试
      return await resp.json();
    } catch (e) {
      // 网络 / CORS 抖动（429 无 CORS 头被拦截）→ 抛错以触发重试
      const err = new Error("network");
      err.retryAfter = 400;
      throw err;
    }
  }

  // 对外：带限流 + 指数退避重试的 GET。
  //   成功 → 返回 JSON（可能为 null 表示无数据）
  //   持续失败 → 抛错（由调用方降级）
  async function get(url, isList = false) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const release = await acquire();
      try {
        return await requestOnce(url, isList);
      } catch (e) {
        lastErr = e;
        const base = e.retryAfter || 400;
        await sleep(base * Math.pow(2, attempt)); // 指数退避：避免重试风暴
      } finally {
        release();
      }
    }
    throw lastErr || new Error("Scryfall 请求失败");
  }

  return { get };
})();

// 所有 Scryfall 请求的统一入口（失败时抛错，调用方自行 try/catch 降级）
function fetchJson(url, isList) {
  return ScryfallClient.get(url, isList);
}

// 按 Scryfall id 取指示物卡数据（带缓存）
const tokenCache = new Map();
async function fetchTokenInfo(id) {
  if (tokenCache.has(id)) return tokenCache.get(id);
  let info = null;
  try {
    info = await fetchJson(`https://api.scryfall.com/cards/${id}`);
  } catch (e) {
    console.warn("Scryfall 指示物查询失败：", id, e);
  }
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

  // 展开为实例（整副牌作为一个卡组，不再区分主牌/备牌）
  const instances = [];
  for (const c of cards)
    for (let k = 0; k < c.qty; k++) instances.push({ ...c });

  // 去重查询：相同「卡名|系列」只在 Scryfall 查一次，避免重复请求
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
  uniqueCards.forEach((c, idx) => {
    infoMap.set(c.set ? `${c.name}|${c.set}` : c.name, lookups[idx]);
  });

  // 解析每张实例的最终图（限流 + 中文图解析），并把关键信息挂到实例上
  const preferZh = optZh.checked;
  await mapLimit(instances, 5, async (inst) => {
    const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
    const info = infoMap.get(key);
    const r = await resolveFaceUrl(info, preferZh);
    inst.faceUrl = r.faceUrl;
    inst.displayUrl = r.displayUrl;
    inst.enUrl = info?.enUrl || null;
    inst.found = !!info;
    inst.oracleId = info?.oracleId || null;
    inst.set = info?.set || inst.set; // 用查到的实际系列/编号作为「当前印刷」
    inst.collectorNumber = info?.collectorNumber || null;
    // 立即把「当前印刷」种入 allPrintings（来自 lookupCard 结果），
    // 保证下拉框一定出现（参考 mtgprint.net：每张卡都有选择器，默认选中当前印刷）。
    // 后台再异步补充该卡的全部印刷版本；即使补充失败，下拉框也不会消失。
    if (info) {
      inst.allPrintings = [
        {
          id: info.id,
          name: info.name,
          set: info.set,
          setName: info.setName || info.set,
          collectorNumber: info.collectorNumber,
          enUrl: info.enUrl,
          oracleId: info.oracleId,
        },
      ];
    } else {
      inst.allPrintings = [];
    }
    inst.selectedPrintingIdx = 0;
    inst._printingsFull = false; // 后台完整列表尚未加载
  });

  const totalCount = instances.length;
  const typeCount = uniqueCards.length;
  const missing = instances.filter((it) => !it.found).length;

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

  // 先渲染预览（卡图立即可见），印刷版本下拉框在后台异步加载
  previewInstances = [...instances, ...tokens];
  currentPage = 0;
  renderPage();
  exportBtn.disabled = false;
  printBtn.disabled = false;

  // 同一张卡（同 oracle_id）只查一次印刷版本，结果共享给所有同名实例
  const oracleIdList = [...new Set(instances.map((it) => it.oracleId).filter(Boolean))];
  const gen = ++currentLoadGen; // 标记本次导入，避免旧的后台任务污染新牌表
  loadPrintings(oracleIdList, instances, gen).catch((e) =>
    console.warn("印刷版本加载异常：", e)
  );

  let msg = `导入成功：${totalCount} 张卡（${typeCount} 种）`;
  if (tokens.length) msg += ` · ${tokens.length} 个指示物`;
  if (missing > 0) msg += `；${missing} 张卡未找到，已用占位。`;
  else if (warned) msg += "；部分无法识别的行已跳过。";
  if (tokenMissing > 0) msg += `；${tokenMissing} 个指示物获取失败已跳过。`;
  lastImportMsg = msg;
  importBtn.disabled = false;
  // 卡图已就绪，印刷版本在后台继续加载
  setStatus(msg + " · 正在加载印刷版本…", missing > 0 || tokenMissing > 0 ? "error" : "");
}

// 后台加载状态（用于写入最终状态，并取消过期的后台加载任务）
let currentLoadGen = 0;
let lastImportMsg = "";

// 后台异步加载每张卡的印刷版本下拉数据；不阻塞导入，失败可重试且不污染新牌表
async function loadPrintings(oracleIdList, cardInstances, gen) {
  if (!oracleIdList.length) {
    setStatus(lastImportMsg + " · 印刷版本无需加载", "ok");
    return;
  }
  const total = oracleIdList.length;
  let failed = 0;
  await mapLimit(oracleIdList, 4, async (oid) => {
    if (gen !== currentLoadGen) return; // 已被新的导入取代，放弃本批
    let prints = null;
    try {
      prints = await fetchAllPrintings(oid);
    } catch (e) {
      failed++;
      console.warn("印刷版本获取失败（保留当前印刷下拉）：", oid, e);
      prints = null; // 失败：保留已 seed 的当前印刷，下拉框不消失、可重导重试
    }
    // 仅当拿到完整列表时才替换（printings 为空也保留 seed 的当前印刷）
    if (prints && prints.length) {
      for (const inst of cardInstances) {
        if (inst.oracleId === oid) {
          inst.allPrintings = prints;
          inst._printingsFull = true;
          const curIdx = prints.findIndex(
            (p) => p.set === inst.set && p.collectorNumber === inst.collectorNumber
          );
          inst.selectedPrintingIdx = curIdx >= 0 ? curIdx : 0;
        }
      }
    }
    if (gen === currentLoadGen) patchVisiblePrintingSelects(oid);
  });
  if (gen !== currentLoadGen) return; // 被新导入取代
  const ok = total - failed;
  setStatus(
    lastImportMsg + ` · 印刷版本已加载（${ok}/${total} 种可切换）`,
    failed > 0 ? "error" : "ok"
  );
}

// 为当前页中匹配该 oracleId 的卡格补/更新下拉：
//  - 尚无下拉 → 新建（可能是已 seed 的「仅当前印刷」版）
//  - 已有下拉但仍是「仅当前印刷」版，且完整列表已到达 → 替换为完整版
function patchVisiblePrintingSelects(oid) {
  for (const wrap of cardGrid.children) {
    const inst = wrap._inst;
    if (!inst || inst.oracleId !== oid) continue;
    const existing = wrap.querySelector(".printing-select");
    // 已是完整版（选项数 ≥ 完整列表数）则无需重建
    if (existing && inst._printingsFull && existing.options.length >= inst.allPrintings.length) {
      continue;
    }
    if (existing) existing.remove();
    const sel = buildPrintingSelect(inst);
    if (sel) wrap.appendChild(sel);
  }
}

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
    wrap._inst = inst; // 供后台异步加载印刷版本时补上下拉框

    // 印刷版本选择下拉（若已加载则立即显示）
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
  currentLoadGen++; // 取消可能仍在后台运行的印刷版本加载
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
