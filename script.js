/* =========================================================
 * TTS 万智牌牌表导出工具（中文卡图版）
 * 流程：解析牌表 → 查 Scryfall 拿 UUID → 拼大学院废墟(mtgch) 中文图
 *       → 生成并导出 TTS 可用的 JSON
 *
 * 架构（高内聚 / 低耦合）：
 *   整个文件封装在单一 IIFE 内，不污染全局作用域；内部按职责划分为
 *   若干相互独立的内聚模块，模块之间通过显式接口互相调用，而非共享可变全局变量：
 *     - dom          : 视图层元素引用 + 状态文案 / HTML 转义（唯一接触 DOM 的入口）
 *     - state        : 应用唯一状态源（单一数据源，杜绝散落的可变全局）
 *     - ScryfallClient: Scryfall 限流 + 退避重试网络客户端（纯网络，无 DOM）
 *     - CardService  : 卡牌数据层（查卡 / 指示物 / 中文图 / 印刷版本）
 *     - Printing     : 印刷版本下拉的构建与后台加载（UI 逻辑）
 *     - Preview      : 预览渲染（只读 state，写入 dom）
 *     - Exporter     : TTS JSON 生成与下载
 *     - Printer      : 打印页生成与指示物数量选择
 *     - importDeck   : 控制器，编排上述模块完成一次导入
 * ========================================================= */
(function () {
  "use strict";

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

  // =========================================================
  // dom —— 视图层唯一入口：缓存元素引用 + 状态文案 + HTML 转义
  // =========================================================
  const dom = (() => {
    const $ = (id) => document.getElementById(id);
    const el = {
      deckInput: $("deckInput"),
      inputCount: $("inputCount"),
      importBtn: $("importBtn"),
      clearBtn: $("clearBtn"),
      importStatus: $("importStatus"),
      statTotal: $("statTotal"),
      statTypes: $("statTypes"),
      prevPage: $("prevPage"),
      nextPage: $("nextPage"),
      pageInd: $("pageInd"),
      cardGrid: $("cardGrid"),
      cardCount: $("cardCount"),
      exportBtn: $("exportBtn"),
      printBtn: $("printBtn"),
      optFix: $("optFix"),
      optZh: $("optZh"),
      optToken: $("optToken"),
      optBackFace: $("optBackFace"),
      statTokens: $("statTokens"),
      tabUrl: $("tabUrl"),
    };

    function setStatus(msg, type) {
      el.importStatus.textContent = msg;
      el.importStatus.className = "import-status" + (type ? " " + type : "");
    }

    // HTML 转义（防止卡名中的特殊字符破坏 innerHTML）
    function escHtml(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    return Object.assign({}, el, { setStatus, escHtml });
  })();

  // =========================================================
  // state —— 应用唯一状态源（单一数据源）
  //   所有可变状态集中于此，模块通过 getter/setter 读写，避免散落的全局变量互相耦合
  // =========================================================
  const state = (() => {
    let deckData = null; // { instances, tokens, totalCount, typeCount, tokenCount }
    let previewInstances = [];
    let currentPage = 0;
    let loadGen = 0; // 后台印刷版本加载的代次，每次导入 +1，用于取消过期任务
    let lastMsg = ""; // 最近一次导入的状态文案（后台加载完成后续写）

    const PAGE_SIZE = 12; // 预览固定 4×3 张

    return {
      PAGE_SIZE,
      get deckData() {
        return deckData;
      },
      set deckData(v) {
        deckData = v;
      },
      get preview() {
        return previewInstances;
      },
      set preview(v) {
        previewInstances = v;
      },
      get page() {
        return currentPage;
      },
      set page(v) {
        currentPage = v;
      },
      get loadGen() {
        return loadGen;
      },
      bumpGen() {
        return ++loadGen;
      },
      get lastMsg() {
        return lastMsg;
      },
      set lastMsg(v) {
        lastMsg = v;
      },
      pageCount() {
        return Math.max(1, Math.ceil(previewInstances.length / PAGE_SIZE));
      },
    };
  })();

  // =========================================================
  // ScryfallClient —— 限流 + 自动退避重试的 Scryfall 网络客户端
  //   设计要点：
  //    - 所有 Scryfall 请求统一走这里，杜绝「绕过调度器直接 fetch」导致的突发限流。
  //    - 单一限流锁：并发数 ≤ MAX_CONCURRENT，且任意两次请求【发起时刻】间隔 ≥ MIN_INTERVAL_MS，
  //      总速率被压在 Scryfall 软上限(10/sec) 以内，避免 429。
  //    - 429 / 网络错误（多为 429 无 CORS 头被浏览器拦截成 CORS 错误）自动指数退避重试；
  //      HTTP 404 等确定性无数据返回 null（不重试）。
  //    - 持续失败（超过重试上限）抛错，由调用方决定降级策略；【失败不缓存】，
  //      因此重新导入仍可重试，不会出现「某张卡永久没有下拉框」。
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

  // 经参考站代理转发 Scryfall 英文图：TTS 直连 cards.scryfall.io 会被拦，
  // 但 tts-magic-booster.fly.dev/i/ 可正常加载。
  // 注：卡背 backs.scryfall.io 在 TTS 可直连，故不代理；mtgch 中文图在 TTS 也可直连，不代理。
  function proxify(url) {
    if (!url) return url;
    return "https://tts-magic-booster.fly.dev/i/" + url.replace(/^https?:\/\//, "");
  }

  // 限流并发工具：将 fn 作用于 items，任意时刻最多 limit 个并发
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
  // CardService —— 卡牌数据层（查卡 / 指示物 / 中文图 / 印刷版本）
  //   纯数据：不接触 DOM、不读写 state，仅通过返回值与调用方通信
  // =========================================================
  const CardService = (() => {
    const cardCache = new Map();
    const tokenCache = new Map();
    const mtgchApiCache = new Map();
    const allPrintingsCache = new Map();

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

      // 主查失败兜底（关键）：Scryfall 的 cards/named?set= 只接受「系列代号」(fdn)，
      // 不接受「系列全名」(Foundations)——后者直接 404。很多牌表导出写的是全名，
      // 因此这里无条件改用搜索接口（cards/search 的 set: 既能接代号也能接全名）再试一次。
      // 这一步是「修正查询格式」，不应受 autoFix 开关影响，否则全名牌表会整张消失。
      if (!info && set) {
        try {
          const sq = encodeURIComponent(`!"${name}" set:${set}`);
          const sData = await fetchJson(
            `https://api.scryfall.com/cards/search?q=${sq}&unique=cards`,
            true
          );
          if (sData && sData.data && sData.data.length) info = sData.data[0];
        } catch (e) {
          console.warn("Scryfall 搜索(带系列)失败：", name, e);
        }
      }

      // 自动修复（受 autoFix 开关控制）：系列代号确实写错（该系列无此卡）时，
      // 退化为「只按卡名」搜，避免整张卡消失。
      if (!info && autoFix) {
        try {
          const sq = encodeURIComponent(`!"${name}"`);
          const sData = await fetchJson(
            `https://api.scryfall.com/cards/search?q=${sq}&unique=cards`,
            true
          );
          if (sData && sData.data && sData.data.length) info = sData.data[0];
        } catch (e) {
          console.warn("Scryfall 模糊搜索(仅卡名)失败：", name, e);
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
            // 双面牌需要：透传 card_faces，供 importDeck 抽取背面陪伴卡
            cardFaces: info.card_faces || null,
            // 该卡在游戏中会生成的指示物（来自 all_parts 中 component === "token"）
            tokens: (info.all_parts || [])
              .filter((p) => p.component === "token")
              .map((p) => ({ id: p.id, name: p.name })),
          }
        : null;
      cardCache.set(key, result);
      return result;
    }

    // 按 Scryfall id 取指示物卡数据（带缓存）
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

    // 拼中文卡图 URL（大学院废墟 / mtgch）
    // 关键修正：mtgch 的中文图用的是它【自己的 uuid】，≠ Scryfall 的卡 id。
    // 正确做法是用 mtgch 官方 API：GET https://mtgch.com/api/v1/card/{set}/{collector_number}/
    // 从返回的 zhs_image_uris.large 取真实中文图地址。
    // CORS：mtgch 反射任意 Origin（含本地 file:// 的 null），浏览器/本地均可跨域 fetch。
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

    // 双面牌背面中文图地址：与正面共用同一 UUID，仅把路径 /front/ 换成 /back/，
    // 且仅 large 尺寸可用（small/normal 对背面均 404）。mtgch 的 API 字段
    // zhs_image_uris 只含正面，但 /back/ 路径真实存在（已用多张 DFC 验证）。
    function deriveZhBackUrl(zhFrontUrl) {
      if (!zhFrontUrl) return null;
      return zhFrontUrl.replace("/zhs/large/front/", "/zhs/large/back/");
    }

    // 决定卡图地址，返回：
    //  - faceUrl / displayUrl        → 正面图（写入 TTS / 浏览器展示）
    //  - backFaceUrl / backDisplayUrl→ 双面牌背面图（无背面时为 null）
    // 规则：
    //  - 基础地 / 不想要中文 → 英文 Scryfall 图（导出代理、展示直连）
    //  - 否则尝试 mtgch 中文图（仅当前系列）；背面同样取中文（/front/→/back/）
    //  - 当前系列无中文图 → 正反面都回退英文
    async function resolveFaceUrl(info, preferZh) {
      if (!info) return { faceUrl: null, displayUrl: null };
      const isDfc = !!(info.cardFaces && info.cardFaces.length >= 2);
      const bfEnUrl =
        isDfc && info.cardFaces[1].image_uris
          ? info.cardFaces[1].image_uris.normal || null
          : null;

      if (BASIC_LANDS.includes(info.name) || !preferZh) {
        return {
          faceUrl: proxify(info.enUrl),
          displayUrl: info.enUrl,
          backFaceUrl: bfEnUrl ? proxify(bfEnUrl) : null,
          backDisplayUrl: bfEnUrl,
        };
      }
      // 当前系列中文图（用 set + collector_number 查 mtgch API 拿真实地址）
      const curZh = await fetchMtgchZh(info.set, info.collectorNumber);
      if (curZh) {
        // 中文背面图与正面共用 UUID，仅路径 /front/ → /back/
        const backZh = deriveZhBackUrl(curZh);
        return {
          faceUrl: curZh,
          displayUrl: curZh,
          backFaceUrl: backZh,
          backDisplayUrl: backZh,
        };
      }
      // 当前系列无中文图 → 正反面都回退英文
      return {
        faceUrl: proxify(info.enUrl),
        displayUrl: info.enUrl,
        backFaceUrl: bfEnUrl ? proxify(bfEnUrl) : null,
        backDisplayUrl: bfEnUrl,
      };
    }

    // 获取某卡的全部印刷（含 set/编号/图地址）。
    // query：{ oracleId } 正面（默认）/ { name } 双面牌背面（Scryfall 的 cards/named
    //        不在 card_faces 内返回背面 oracle_id，故背面改用「卡名精确搜索」拿列表）
    // faceIndex：0=取正面图（默认），1=取双面牌背面图（用于背面陪伴卡的下拉）
    // 基础地印刷极多（数百个），跟随 Scryfall 分页全部获取；其他卡只取第一页
    async function fetchAllPrintings(query, faceIndex = 0) {
      if (!query) return [];
      const cacheKey =
        (query.oracleId ? "o:" + query.oracleId : "n:" + query.name) + "|" + faceIndex;
      if (allPrintingsCache.has(cacheKey)) return allPrintingsCache.get(cacheKey);

      const mapCard = (c) => {
        // faceIndex=0 取正面图；faceIndex=1 取双面牌背面图（背面陪伴卡回退用）
        const faceImg = c.card_faces && c.card_faces[faceIndex];
        const faceName = (faceImg && faceImg.name) || c.name;
        return {
          id: c.id,
          name: faceName,
          cardName: c.name, // 真实卡名（基础地判定用；双面牌此处为正面名）
          set: c.set,
          setName: c.set_name || c.set,
          collectorNumber: c.collector_number,
          enUrl:
            (faceIndex === 0
              ? c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal
              : faceImg?.image_uris?.normal) || null,
          oracleId: c.oracle_id,
        };
      };

      let firstUrl;
      if (query.oracleId) {
        firstUrl = `https://api.scryfall.com/cards/search?q=oracleid:${encodeURIComponent(
          query.oracleId
        )}&unique=prints&order=released&dir=desc`;
      } else {
        // 双面牌背面：按背面卡名精确搜索（如 "Photon, Living Light"）
        firstUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(
          '!"' + query.name + '"'
        )}&unique=prints&order=released&dir=desc`;
      }
      const first = await fetchJson(firstUrl);
      if (!first || !first.data) {
        allPrintingsCache.set(cacheKey, []);
        return [];
      }
      let printings = first.data.filter((c) => c.collector_number).map(mapCard);
      const isBasic = printings.some((p) => BASIC_LANDS.includes(p.cardName));

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
      allPrintingsCache.set(cacheKey, printings);
      return printings;
    }

    // 决定【双面牌背面】的卡图地址（独立于正面，供背面陪伴卡切换印刷版本用）。
    // 输入 printing 对象（含 set/collectorNumber/enUrl 等背面图信息），返回：
    //  - faceUrl / displayUrl → 该印刷版本的背面图（中文优先，无中文回退英文）
    // 中文背面图：用同系列同编号查 mtgch 拿正面中文图，再 /front/→/back/ 推导。
    async function resolveBackFaceUrl(p, preferZh) {
      if (!p) return { faceUrl: null, displayUrl: null };
      const bfEnUrl = p.enUrl;
      if (!preferZh) {
        return { faceUrl: proxify(bfEnUrl), displayUrl: bfEnUrl };
      }
      const curZh = await fetchMtgchZh(p.set, p.collectorNumber);
      if (curZh) {
        const backZh = deriveZhBackUrl(curZh);
        return { faceUrl: backZh, displayUrl: backZh };
      }
      return { faceUrl: proxify(bfEnUrl), displayUrl: bfEnUrl };
    }

    return { lookupCard, fetchTokenInfo, resolveFaceUrl, resolveBackFaceUrl, fetchAllPrintings };
  })();

  // =========================================================
  // Printing —— 印刷版本下拉的构建与后台加载（UI 逻辑）
  //   依赖：CardService（取数据）、dom（写视图）、state（读取后台加载代次/状态文案）
  // =========================================================
  const Printing = (() => {
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
          dom.escHtml(setName) +
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
            dom.escHtml(item.p.collectorNumber) +
            "</option>";
        });
        html += "</optgroup>";
      });
      sel.innerHTML = html;

      sel.addEventListener("change", async function () {
        const idx = parseInt(sel.value, 10);
        if (inst.isBackFace) await onBackPrintingChange(inst, idx);
        else await onPrintingChange(inst, idx);
        Preview.renderPage();
      });
      return sel;
    }

    // 用户选择了新印刷 → 重新解析该卡的 faceUrl / displayUrl
    async function onPrintingChange(inst, idx) {
      const p = inst.allPrintings[idx];
      if (!p) return;
      inst.selectedPrintingIdx = idx;
      // 用新印刷的信息重新解析卡图（走中文优先逻辑）
      const preferZh = dom.optZh.checked;
      const newInfo = {
        enUrl: p.enUrl,
        name: p.name,
        oracleId: p.oracleId,
        set: p.set,
        collectorNumber: p.collectorNumber,
      };
      const r = await CardService.resolveFaceUrl(newInfo, preferZh);
      inst.faceUrl = r.faceUrl;
      inst.displayUrl = r.displayUrl;
      inst.enUrl = p.enUrl;
    }

    // 双面牌背面陪伴卡的印刷切换：只改背面图，与正面解耦（对齐 mtgprint.net）
    async function onBackPrintingChange(inst, idx) {
      const p = inst.allPrintings[idx];
      if (!p) return;
      inst.selectedPrintingIdx = idx;
      const preferZh = dom.optZh.checked;
      const newInfo = {
        enUrl: p.enUrl,
        name: p.name,
        oracleId: p.oracleId,
        set: p.set,
        collectorNumber: p.collectorNumber,
      };
      const r = await CardService.resolveBackFaceUrl(newInfo, preferZh);
      inst.faceUrl = r.faceUrl;
      inst.displayUrl = r.displayUrl;
      inst.enUrl = p.enUrl;
    }

    // 为当前页中匹配 matchFn 的卡格补/更新下拉：
    //  - 尚无下拉 → 新建（可能是已 seed 的「仅当前印刷」版）
    //  - 已有下拉但仍是「仅当前印刷」版，且完整列表已到达 → 替换为完整版
    function patchVisiblePrintingSelects(matchFn) {
      for (const wrap of dom.cardGrid.children) {
        const inst = wrap._inst;
        if (!inst || !matchFn(inst)) continue;
        const existing = wrap.querySelector(".printing-select");
        // 已是完整版（选项数 ≥ 完整列表数）则无需重建
        if (
          existing &&
          inst._printingsFull &&
          existing.options &&
          existing.options.length >= inst.allPrintings.length
        ) {
          continue;
        }
        if (existing) existing.remove();
        const sel = buildPrintingSelect(inst);
        if (sel) wrap.appendChild(sel);
      }
    }

    // 带重试地获取某查询的全部印刷：确定无数据(返回空数组)不重试；
    // 仅在真正抛错(网络/限流抖动)时退避重试，避免【一次抖动就永久停在「仅当前1项」】。
    // faceIndex：0=正面印刷，1=双面牌背面印刷。
    async function fetchPrintsWithRetry(query, gen, attempts, faceIndex = 0) {
      for (let a = 0; a < attempts; a++) {
        if (gen !== state.loadGen) return null; // 已被新导入取代
        try {
          return await CardService.fetchAllPrintings(query, faceIndex); // 成功（含空数组=确定无数据）
        } catch (e) {
          console.warn(`印刷版本获取失败(第${a + 1}/${attempts}次重试)：`, query, e);
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, a)));
        }
      }
      return null;
    }

    // 后台异步加载每张卡（含双面牌背面）的印刷版本下拉数据；不阻塞导入。
    // 失败会自动重试；若仍失败则保留已 seed 的当前印刷下拉（不消失，用户重导即可再试）。
    //   oracleIdList：正面卡（按 oracle_id 查，faceIndex=0）
    //   backFaceNames：双面牌背面（按背面卡名查，faceIndex=1）
    async function loadPrintings(oracleIdList, backFaceNames, cardInstances, gen) {
      if (!oracleIdList.length && !backFaceNames.length) {
        dom.setStatus(state.lastMsg + " · 印刷版本无需加载", "ok");
        return;
      }
      const total = oracleIdList.length + backFaceNames.length;

      // 把完整列表写回匹配该 query 的全部实例（仅当真正拿到数据）
      const apply = (query, prints, matchFn) => {
        if (!prints || !prints.length) return;
        for (const inst of cardInstances) {
          if (matchFn(inst)) {
            inst.allPrintings = prints;
            inst._printingsFull = true;
            const curIdx = prints.findIndex(
              (p) => p.set === inst.set && p.collectorNumber === inst.collectorNumber
            );
            inst.selectedPrintingIdx = curIdx >= 0 ? curIdx : 0;
          }
        }
      };

      const onePass = async (list, attempts, faceIndex, toQuery, matchFn) => {
        await mapLimit(list, 4, async (key) => {
          const query = toQuery(key);
          const prints = await fetchPrintsWithRetry(query, gen, attempts, faceIndex);
          // matchFn 形如 (inst, key) => boolean；这里把当前 key 闭包进去，
          // 供 apply / patch 同时用于正面(oracleId)与背面(卡名)的匹配。
          const matcher = (inst) => matchFn(inst, key);
          apply(query, prints, matcher);
          if (gen === state.loadGen) patchVisiblePrintingSelects(matcher);
        });
      };

      // 第一遍：并发加载，每张卡最多重试 3 次
      await onePass(
        oracleIdList,
        3,
        0,
        (oid) => ({ oracleId: oid }),
        (inst, oid) => inst.oracleId === oid
      );
      if (gen !== state.loadGen) return; // 被新导入取代

      // 双面牌背面：按背面卡名查（faceIndex=1，取背面图）。
      // 注：Scryfall 的 cards/named 不在 card_faces 内返回背面 oracle_id，
      //     故改用「背面卡名精确搜索」拿背面印刷列表；实体双面牌正反面同系列同编号，
      //     故当前印刷的 set/collector 能与背面列表对上。
      await onePass(
        backFaceNames,
        3,
        1,
        (name) => ({ name }),
        (inst, name) => inst.isBackFace && inst.backFaceName === name
      );
      if (gen !== state.loadGen) return;

      // 补洞二遍：对仍停在「仅当前1项」(seed 未补全) 的查询稍等网络恢复后再补一次
      const pendingOids = oracleIdList.filter((oid) =>
        cardInstances.some((i) => i.oracleId === oid && i.found && !i._printingsFull)
      );
      const pendingNames = backFaceNames.filter((nm) =>
        cardInstances.some((i) => i.isBackFace && i.backFaceName === nm && i.found && !i._printingsFull)
      );
      if (pendingOids.length || pendingNames.length) {
        await new Promise((r) => setTimeout(r, 1200));
        if (gen !== state.loadGen) return;
        if (pendingOids.length) {
          await onePass(
            pendingOids,
            2,
            0,
            (oid) => ({ oracleId: oid }),
            (inst, oid) => inst.oracleId === oid
          );
          if (gen !== state.loadGen) return;
        }
        if (pendingNames.length) {
          await onePass(
            pendingNames,
            2,
            1,
            (name) => ({ name }),
            (inst, name) => inst.isBackFace && inst.backFaceName === name
          );
          if (gen !== state.loadGen) return;
        }
      }

      const failed =
        oracleIdList.filter((oid) =>
          cardInstances.some((i) => i.oracleId === oid && i.found && !i._printingsFull)
        ).length +
        backFaceNames.filter((nm) =>
          cardInstances.some((i) => i.isBackFace && i.backFaceName === nm && i.found && !i._printingsFull)
        ).length;
      dom.setStatus(
        state.lastMsg + ` · 印刷版本已加载（${total - failed}/${total} 种可切换）`,
        failed > 0 ? "error" : "ok"
      );
    }

    return { buildPrintingSelect, onPrintingChange, patchVisiblePrintingSelects, loadPrintings };
  })();

  // =========================================================
  // Preview —— 预览渲染（只读 state，写入 dom）
  // =========================================================
  const Preview = (() => {
    function renderPage() {
      const total = state.preview.length;
      const pageCount = state.pageCount();

      // 校正当前页（数据变化后可能越界）
      let cur = state.page;
      if (cur >= pageCount) cur = pageCount - 1;
      if (cur < 0) cur = 0;
      state.page = cur;

      const start = cur * state.PAGE_SIZE;
      const end = Math.min(start + state.PAGE_SIZE, total);
      const pageItems = state.preview.slice(start, end);

      dom.cardGrid.innerHTML = "";
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
        } else if (inst.isBackFace) {
          // 双面牌背面陪伴卡角标
          cell.classList.add("backface-cell");
          const badge = document.createElement("div");
          badge.className = "backface-badge";
          badge.textContent = "背面 · " + (inst.frontName || "");
          cell.appendChild(badge);
        }

        wrap.appendChild(cell);
        wrap._inst = inst; // 供后台异步加载印刷版本时补上下拉框

        // 印刷版本选择下拉（若已加载则立即显示）
        const sel = Printing.buildPrintingSelect(inst);
        if (sel) wrap.appendChild(sel);

        dom.cardGrid.appendChild(wrap);
      }

      // 更新计数与翻页控件
      if (total) {
        dom.cardCount.textContent = `第 ${cur + 1} / ${pageCount} 页 · 显示 ${start + 1}–${end} / 共 ${total} 张`;
      } else {
        dom.cardCount.textContent = "显示 0 / 0 张";
      }
      dom.pageInd.textContent = `第 ${cur + 1} / ${pageCount} 页`;
      dom.prevPage.disabled = cur <= 0;
      dom.nextPage.disabled = cur >= pageCount - 1;
    }

    return { renderPage };
  })();

  // =========================================================
  // Exporter —— TTS JSON 生成与下载（依赖 state）
  // =========================================================
  const Exporter = (() => {
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
      if (!state.deckData) return;
      const json = buildTTSJson(state.deckData.instances, state.deckData.tokens || []);
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
      dom.setStatus("已导出 deck_tts.json，放入 TTS 的 Saved Objects 文件夹即可。", "ok");
    }

    return { exportJson, buildTTSJson };
  })();

  // =========================================================
  // Printer —— 打印页生成与指示物数量选择（依赖 state、dom）
  // =========================================================
  const Printer = (() => {
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
        dom.setStatus("已下载打印文件 mtg_cards_print.html，请打开后按 Ctrl/Cmd+P 打印。", "ok");
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // 指示物打印数量选择弹窗
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
            "width:48px;height:67px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#ccc);flex-shrink:0";
          thumb.onerror = () => {
            if (fUrl && thumb.src !== fUrl) thumb.src = fUrl;
          };
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
      if (!state.deckData) {
        dom.setStatus("请先导入牌表再打印卡图。", "error");
        return;
      }
      // 打印页在浏览器内加载，用直连 displayUrl（避免代理不稳定），enUrl 作回退
      const items = state.deckData.instances.map((inst) => ({
        faceUrl: inst.displayUrl || inst.enUrl || inst.faceUrl,
        enUrl: inst.enUrl,
        name: inst.name,
      }));

      // 指示物：开启「自动导入指示物」且已收集到时才询问数量
      if (dom.optToken.checked && state.deckData.tokens && state.deckData.tokens.length) {
        try {
          const chosen = await chooseTokenCounts(state.deckData.tokens);
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
        dom.setStatus("没有可打印的卡图。", "error");
        return;
      }
      openPrintHtml(buildPrintHtml(items));
      const totalPages = Math.ceil(items.length / PRINT_PER_PAGE);
      dom.setStatus(
        `已生成打印页面（${items.length} 张 · 约 ${totalPages} 页 A4），在弹出窗口按打印即可；指示物已一并包含。`,
        "ok"
      );
    }

    return { printCards };
  })();

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
  // 控制器：importDeck（编排各模块完成一次导入）
  // =========================================================
  async function importDeck() {
    const text = dom.deckInput.value;
    if (!text.trim()) {
      dom.setStatus("请先粘贴牌表内容。", "error");
      return;
    }
    const { cards, warned } = parseDeck(text);
    if (!cards.length) {
      dom.setStatus("未能解析出任何卡牌，请检查牌表格式。", "error");
      return;
    }

    dom.importBtn.disabled = true;
    dom.setStatus("正在查询卡牌信息…", "");

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
    const autoFix = dom.optFix.checked;
    const lookups = await Promise.all(
      uniqueCards.map((c) => CardService.lookupCard(c.name, c.set, autoFix))
    );
    const infoMap = new Map();
    uniqueCards.forEach((c, idx) => {
      infoMap.set(c.set ? `${c.name}|${c.set}` : c.name, lookups[idx]);
    });

    // 解析每张实例的最终图（限流 + 中文图解析），并把关键信息挂到实例上
    const preferZh = dom.optZh.checked;
    const includeBack = dom.optBackFace.checked;
    const backCompanions = []; // 双面牌的背面陪伴卡（独立于正面，加入牌堆/预览/打印）
    await mapLimit(instances, 5, async (inst) => {
      const key = inst.set ? `${inst.name}|${inst.set}` : inst.name;
      const info = infoMap.get(key);
      const r = await CardService.resolveFaceUrl(info, preferZh);
      inst.faceUrl = r.faceUrl;
      inst.displayUrl = r.displayUrl;
      inst.enUrl = info?.enUrl || null;
      inst.found = !!info;
      inst.oracleId = info?.oracleId || null;
      // 双面牌：把卡名扩展成「正面 // 背面」，对齐 mtgprint.net 的展示
      // （无论 Scryfall 返回的 name 是否已含 //，都以两面 face name 拼接为准）
      if (info && info.cardFaces && info.cardFaces.length >= 2) {
        inst.name = info.cardFaces[0].name + " // " + info.cardFaces[1].name;
      }
      inst.set = info?.set || inst.set; // 用查到的实际系列/编号作为「当前印刷」
      inst.collectorNumber = info?.collectorNumber || null;
      inst.isBackFace = false;
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

      // 双面牌：抽取背面作为独立陪伴卡。
      // 中文背面图：resolveFaceUrl 已据正面中文图推导（/front/→/back/，仅 large）；
      // 若无中文（基础地/未勾选中文/该系列无中文），则回退 Scryfall 英文背面。
      if (includeBack && info && info.cardFaces && info.cardFaces.length >= 2) {
        const bf = info.cardFaces[1];
        const bfEnUrl = bf.image_uris?.normal || null;
        // 优先用中文背面图（r.backFaceUrl），否则回退英文背面
        const backFace = r.backFaceUrl || (bfEnUrl ? proxify(bfEnUrl) : null);
        const backDisplay = r.backDisplayUrl || bfEnUrl;
        if (backFace) {
          const backOracle = bf.oracle_id || null;
          backCompanions.push({
            name: bf.name,
            faceUrl: backFace,
            displayUrl: backDisplay,
            enUrl: bfEnUrl, // 中文背面若 404，预览 onerror 回退英文背面
            found: true,
            oracleId: backOracle, // 多数情况下 null（cards/named 不返回背面 oracle_id）
            backFaceName: bf.name, // 后台按此名查背面印刷列表（faceIndex=1）
            set: info.set,
            collectorNumber: info.collectorNumber,
            isBackFace: true,
            frontName: info.name, // 预览角标用：标明这是哪张正面的背面（用简明正面名）
            allPrintings: [
              {
                id: bf.id || info.id + "-back",
                name: bf.name,
                set: info.set,
                setName: info.setName || info.set,
                collectorNumber: info.collectorNumber,
                enUrl: bfEnUrl,
                oracleId: backOracle,
              },
            ],
            selectedPrintingIdx: 0,
            // 背面也走后台加载全部印刷版本（按背面卡名查），保持「仅当前1项」直到加载完成
            _printingsFull: false,
          });
        }
      }
    });

    // 把背面陪伴卡并入实例列表（位于各自正面卡之后；导出/预览/打印都会出现）
    if (backCompanions.length) instances.push(...backCompanions);

    const totalCount = instances.length;
    const typeCount = uniqueCards.length;
    const missing = instances.filter((it) => !it.found).length;

    // 自动收集指示物：汇总所有主牌 all_parts 里的 token（按 id 去重）
    const tokens = [];
    let tokenMissing = 0;
    if (dom.optToken.checked) {
      const tokenIdMap = new Map();
      for (const info of infoMap.values()) {
        if (info && info.tokens) {
          for (const t of info.tokens) {
            if (!tokenIdMap.has(t.id)) tokenIdMap.set(t.id, t.name);
          }
        }
      }
      if (tokenIdMap.size) {
        dom.importBtn.disabled = true;
        dom.setStatus(`正在查询 ${tokenIdMap.size} 个指示物…`, "");
        const tokenInfos = await Promise.all(
          [...tokenIdMap.keys()].map((id) => CardService.fetchTokenInfo(id))
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

    state.deckData = { instances, tokens, totalCount, typeCount, tokenCount: tokens.length };

    dom.statTotal.textContent = totalCount;
    dom.statTypes.textContent = typeCount;
    dom.statTokens.textContent = tokens.length;

    // 先渲染预览（卡图立即可见），印刷版本下拉框在后台异步加载
    state.preview = [...instances, ...tokens];
    state.page = 0;
    Preview.renderPage();
    dom.exportBtn.disabled = false;
    dom.printBtn.disabled = false;

    // 同一张卡（同 oracle_id / 同背面卡名）只查一次印刷版本，结果共享给所有同名实例
    const oracleIdList = [...new Set(instances.map((it) => it.oracleId).filter(Boolean))];
    const backFaceNames = [
      ...new Set(
        instances.filter((it) => it.isBackFace && it.backFaceName).map((it) => it.backFaceName)
      ),
    ];
    const gen = state.bumpGen(); // 标记本次导入，避免旧的后台任务污染新牌表
    Printing.loadPrintings(oracleIdList, backFaceNames, instances, gen).catch((e) =>
      console.warn("印刷版本加载异常：", e)
    );

    let msg = `导入成功：${totalCount} 张卡（${typeCount} 种）`;
    if (backCompanions.length) msg += ` · 含 ${backCompanions.length} 张双面牌背面`;
    if (tokens.length) msg += ` · ${tokens.length} 个指示物`;
    if (missing > 0) msg += `；${missing} 张卡未找到，已用占位。`;
    else if (warned) msg += "；部分无法识别的行已跳过。";
    if (tokenMissing > 0) msg += `；${tokenMissing} 个指示物获取失败已跳过。`;
    state.lastMsg = msg;
    dom.importBtn.disabled = false;
    // 卡图已就绪，印刷版本在后台继续加载
    dom.setStatus(msg + " · 正在加载印刷版本…", missing > 0 || tokenMissing > 0 ? "error" : "");
  }

  // =========================================================
  // 8. 辅助 & 事件绑定
  // =========================================================
  function updateInputCount() {
    const text = dom.deckInput.value;
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    dom.inputCount.textContent = `${lines} 行 · ${text.length} 字`;
  }

  function updateInputCountAndClear() {
    updateInputCount();
  }

  function bindEvents() {
    dom.deckInput.addEventListener("input", updateInputCount);

    dom.importBtn.addEventListener("click", importDeck);
    dom.exportBtn.addEventListener("click", Exporter.exportJson);
    dom.printBtn.addEventListener("click", Printer.printCards);

    dom.clearBtn.addEventListener("click", () => {
      dom.deckInput.value = "";
      updateInputCount();
      dom.cardGrid.innerHTML = "";
      dom.cardCount.textContent = "显示 0 / 0 张";
      dom.statTotal.textContent = "0";
      dom.statTypes.textContent = "0";
      dom.statTokens.textContent = "0";
      state.preview = [];
      state.page = 0;
      dom.pageInd.textContent = "第 1 / 1 页";
      dom.prevPage.disabled = true;
      dom.nextPage.disabled = true;
      dom.exportBtn.disabled = true;
      dom.printBtn.disabled = true;
      state.deckData = null;
      state.bumpGen(); // 取消可能仍在后台运行的印刷版本加载
      dom.setStatus("", "");
    });

    // 翻页控件
    dom.prevPage.addEventListener("click", () => {
      if (state.page > 0) {
        state.page--;
        Preview.renderPage();
      }
    });
    dom.nextPage.addEventListener("click", () => {
      const pageCount = state.pageCount();
      if (state.page < pageCount - 1) {
        state.page++;
        Preview.renderPage();
      }
    });

    // URL 导入标签（本期未实现）
    dom.tabUrl.addEventListener("click", () => {
      dom.setStatus("URL 导入功能即将推出，请暂时使用「牌表输入」粘贴文本。", "");
    });

    updateInputCount();
  }

  bindEvents();

  // 测试钩子（仅供自动化验证使用，不影响正常功能）
  if (typeof window !== "undefined") {
    window.__TTSTOOL__ = {
      importDeck,
      lookupCard: CardService.lookupCard,
      fetchAllPrintings: CardService.fetchAllPrintings,
      resolveFaceUrl: CardService.resolveFaceUrl,
      resolveBackFaceUrl: CardService.resolveBackFaceUrl,
      buildTTSJson: Exporter.buildTTSJson,
      buildPrintingSelect: Printing.buildPrintingSelect,
      renderPage: Preview.renderPage,
      parseDeck,
      state,
    };
  }
})();
