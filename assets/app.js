/* ── ADR 괴리 트래커 — 멀티 종목 렌더 ─────────────────────────────────
 * data/summary.json(전 종목 요약) + data/{id}.json(종목별 시계열)을 읽어
 * 상단 비교뷰(카드 + 오버레이 차트)와 종목별 2패널 상세를 렌더한다.
 */

const ZONE_META = {
  premium_hi:  { label: "강한 프리미엄", color: "#ef4444" },
  premium:     { label: "프리미엄",     color: "#f59e0b" },
  fair:        { label: "적정",         color: "#22c55e" },
  discount:    { label: "디스카운트",   color: "#3b82f6" },
  discount_hi: { label: "강한 디스카운트", color: "#8b5cf6" },
};

// 종목 대표색 (본주 라인 + 비교 라인). ADR 환산가는 전 종목 공통 amber.
const ASSET_COLOR = { skhy: "#14b8a6", tsm: "#a78bfa" };
const FALLBACK_COLORS = ["#14b8a6", "#a78bfa", "#f472b6", "#38bdf8", "#4ade80"];
const ADR_COLOR = "#f59e0b";
const FX_COLOR = "#6b7280";

const RANGES = [
  { key: "2W", days: 14 },
  { key: "1M", days: 22 },
  { key: "3M", days: 66 },
  { key: "6M", days: 132 },
  { key: "1Y", days: 264 },
  { key: "전체", days: 100000 },
];

const state = { charts: {}, assets: [], full: {}, range: 264 };

function colorOf(a, i) { return ASSET_COLOR[a.id] || FALLBACK_COLORS[i % FALLBACK_COLORS.length]; }

function zoneOf(gap, z) {
  if (gap >= z.premium_hi) return "premium_hi";
  if (gap >= z.premium) return "premium";
  if (gap > z.discount) return "fair";
  if (gap > z.discount_hi) return "discount";
  return "discount_hi";
}

function fmt(v, d = 2) {
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function usd(v) { return "$" + fmt(v, 2); }
function signPct(v) { return (v >= 0 ? "+" : "") + fmt(v, 2) + "%"; }
function moneyLocal(v, a) {
  const d = a.ccy_decimals ?? 0;
  return a.ccy_symbol + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function axisLocal(v, a) {
  const av = Math.abs(v);
  if (av >= 1e6) return a.ccy_symbol + (v / 1e6).toFixed(2) + "M";
  if (av >= 1e4) return a.ccy_symbol + (v / 1e3).toFixed(0) + "K";
  return a.ccy_symbol + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtDateTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} KST`;
  } catch { return iso; }
}
async function loadJSON(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`);
  return res.json();
}

const GRID = "rgba(255,255,255,0.05)";
const TICK = "#6b7280";

/* ── 상태 바 ─────────────────────────────────────────── */
function renderStatus(summary) {
  document.getElementById("status-bar").innerHTML = `
    <span class="status-pill">기준일 <strong>${summary.as_of_date}</strong></span>
    <span class="status-pill">갱신 <strong>${fmtDateTime(summary.updated_at)}</strong></span>
    <span class="status-pill">추적 종목 <strong>${summary.assets.length}</strong></span>
  `;
}

/* ── 비교 카드 ───────────────────────────────────────── */
function renderCompareCards(summary) {
  document.getElementById("compare-cards").innerHTML = summary.assets.map((a, i) => {
    const c = a.current, s = a.stats, zone = c.zone, zm = ZONE_META[zone];
    const dir = c.gap_pct >= 0 ? "프리미엄" : "디스카운트";
    return `
      <div class="cmp-card" style="border-top:3px solid ${colorOf(a, i)}">
        <div class="cmp-top">
          <span class="cmp-name">${a.name_ko}</span>
          <span class="cmp-syms">${a.adr_symbol} / ${a.stock_symbol}</span>
        </div>
        <div class="cmp-gap z-${zone}">${signPct(c.gap_pct)}</div>
        <div class="cmp-state"><span class="badge z-${zone} bg-${zone}" style="padding:4px 12px;border-radius:999px;font-size:13px">${zm.label}</span><span class="cmp-dir">${dir}</span></div>
        <div class="cmp-sub">
          <span>본주 ${moneyLocal(c.stock_local, a)}</span>
          <span>ADR ${usd(c.adr_usd)}</span>
          <span>적정 ${usd(c.adr_fair_usd)}</span>
        </div>
        <div class="cmp-stats">최근 ${s.window}일 평균 ${signPct(s.mean)} · 백분위 ${fmt(s.percentile, 0)}% · z ${fmt(s.zscore, 2)}</div>
      </div>`;
  }).join("");
}

/* ── 비교 차트 (괴리율 오버레이) ─────────────────────── */
function renderCompareChart(rangeDays) {
  const assets = state.assets;
  const dateSet = new Set();
  assets.forEach((a) => state.full[a.id].series.forEach((p) => dateSet.add(p.date)));
  let dates = [...dateSet].sort();
  if (rangeDays < dates.length) dates = dates.slice(-rangeDays);

  const datasets = assets.map((a, i) => {
    const map = new Map(state.full[a.id].series.map((p) => [p.date, p.gap_pct]));
    const col = colorOf(a, i);
    return {
      label: a.name_ko, data: dates.map((d) => (map.has(d) ? map.get(d) : null)),
      borderColor: col, backgroundColor: col, borderWidth: 2.2, pointRadius: 0, tension: 0.15, spanGaps: true,
    };
  });

  if (state.charts.compare) state.charts.compare.destroy();
  state.charts.compare = new Chart(document.getElementById("compareChart"), {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#9aa0ac", boxWidth: 14, font: { size: 12 } } },
        tooltip: { mode: "index", intersect: false, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "-" : signPct(ctx.parsed.y)}` } },
        annotation: { annotations: { zero: { type: "line", yMin: 0, yMax: 0, borderColor: "#9aa0ac", borderWidth: 1.3 } } },
      },
      scales: {
        x: { ticks: { color: TICK, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: GRID } },
        y: { ticks: { color: TICK, font: { size: 11 }, callback: (v) => v + "%" }, grid: { color: GRID }, title: { display: true, text: "괴리율(%)", color: TICK, font: { size: 10 } } },
      },
    },
  });
}

/* ── 종목별 상세 섹션 스켈레톤 ───────────────────────── */
function buildAssetSections() {
  const wrap = document.getElementById("asset-sections");
  wrap.innerHTML = state.assets.map((a, i) => {
    const c = a.current, s = a.stats, zone = c.zone;
    return `
    <section class="card asset-card">
      <div class="asset-head" style="border-left:4px solid ${colorOf(a, i)}">
        <div>
          <span class="asset-name">${a.name_ko}</span>
          <span class="asset-syms">ADR ${a.adr_symbol} · 본주 ${a.stock_symbol} · ${a.market}</span>
        </div>
        <span class="badge z-${zone} bg-${zone}" style="padding:5px 14px;border-radius:999px;font-size:14px">${signPct(c.gap_pct)} ${ZONE_META[zone].label}</span>
      </div>
      <div class="hero-sub" style="margin-top:14px">
        <div class="cell"><div class="k">본주 실제가 (${a.stock_symbol})</div><div class="v">${moneyLocal(c.stock_local, a)}</div></div>
        <div class="cell"><div class="k">ADR 실제가 (${a.adr_symbol})</div><div class="v">${usd(c.adr_usd)}</div></div>
        <div class="cell"><div class="k">ADR 이론가 (적정)</div><div class="v">${usd(c.adr_fair_usd)}</div><div class="vsub">본주 기준 적정 ADR</div></div>
        <div class="cell"><div class="k">환율 (${a.ccy}/USD)</div><div class="v">${fmt(c.fx, a.ccy === "TWD" ? 2 : 1)}</div></div>
      </div>
      <div class="stat-strip" style="justify-content:flex-start">
        <span class="stat-chip">최근 ${s.window}일 평균 <strong>${signPct(s.mean)}</strong></span>
        <span class="stat-chip">백분위 <strong>${fmt(s.percentile, 0)}%</strong></span>
        <span class="stat-chip">z-score <strong>${fmt(s.zscore, 2)}</strong></span>
        <span class="stat-chip">범위 <strong>${signPct(s.min)} ~ ${signPct(s.max)}</strong></span>
      </div>
      <p class="chart-note" style="margin-top:16px">위: <strong>본주 실제가</strong> vs <strong>ADR 환산가</strong>(현지통화, 본주 1주 기준) · 환율은 우축. 아래: 괴리율(%) 오실레이터.</p>
      <div class="chart-box"><canvas id="price-${a.id}"></canvas></div>
      <div class="chart-box osc" style="margin-top:10px"><canvas id="gap-${a.id}"></canvas></div>
      <table class="rec-table" id="recent-${a.id}" style="margin-top:14px"></table>
    </section>`;
  }).join("");

  // 최근 기록 표(정적)
  state.assets.forEach((a) => renderRecent(a));
}

function renderRecent(a) {
  const full = state.full[a.id];
  const zones = full.zones;
  const recent = full.series.slice(-10).reverse();
  document.getElementById(`recent-${a.id}`).innerHTML = `
    <thead><tr>
      <th class="left">날짜</th>
      <th>본주 (${a.ccy_symbol})</th>
      <th class="hide-sm">ADR ($)</th>
      <th class="hide-sm">환율</th>
      <th>ADR 환산가</th>
      <th>괴리율</th>
    </tr></thead>
    <tbody>${recent.map((x) => {
      const z = zoneOf(x.gap_pct, zones);
      return `<tr>
        <td class="left">${x.date}</td>
        <td>${moneyLocal(x.stock_local, a)}</td>
        <td class="hide-sm">${usd(x.adr_usd)}</td>
        <td class="hide-sm">${fmt(x.fx, a.ccy === "TWD" ? 2 : 1)}</td>
        <td>${moneyLocal(x.adr_local, a)}</td>
        <td><span class="gap z-${z}">${signPct(x.gap_pct)}</span></td>
      </tr>`;
    }).join("")}</tbody>`;
}

/* ── 종목별 2패널 차트 ───────────────────────────────── */
function renderAssetCharts(a, i, rangeDays) {
  const all = state.full[a.id].series;
  const d = rangeDays >= all.length ? all : all.slice(-rangeDays);
  const labels = d.map((x) => x.date);
  const stock = d.map((x) => x.stock_local);
  const adr = d.map((x) => x.adr_local);
  const fx = d.map((x) => x.fx);
  const gap = d.map((x) => x.gap_pct);
  const col = colorOf(a, i);

  // 패널 1: 본주 vs ADR 환산가 (좌축) + 환율 (우축)
  const pid = `price-${a.id}`;
  if (state.charts[pid]) state.charts[pid].destroy();
  state.charts[pid] = new Chart(document.getElementById(pid), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "본주 실제가", data: stock, yAxisID: "y", borderColor: col, borderWidth: 2.4, pointRadius: 0, tension: 0.15, order: 2 },
        { label: "ADR 환산가", data: adr, yAxisID: "y", borderColor: ADR_COLOR, borderWidth: 2.4, pointRadius: 0, tension: 0.15, order: 1 },
        { label: `환율 (${a.ccy}/USD)`, data: fx, yAxisID: "y1", borderColor: FX_COLOR, borderWidth: 1.2, borderDash: [4, 4], pointRadius: 0, tension: 0.15, order: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#9aa0ac", boxWidth: 14, font: { size: 12 } } },
        tooltip: {
          mode: "index", intersect: false,
          callbacks: {
            label: (ctx) => ctx.dataset.yAxisID === "y1"
              ? `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 2)}`
              : `${ctx.dataset.label}: ${moneyLocal(ctx.parsed.y, a)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: TICK, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: GRID } },
        y: { position: "left", ticks: { color: TICK, font: { size: 11 }, callback: (v) => axisLocal(v, a) }, grid: { color: GRID }, title: { display: true, text: `본주 1주 (${a.ccy})`, color: TICK, font: { size: 10 } } },
        y1: { position: "right", ticks: { color: FX_COLOR, font: { size: 11 } }, grid: { drawOnChartArea: false }, title: { display: true, text: `${a.ccy}/USD`, color: FX_COLOR, font: { size: 10 } } },
      },
    },
  });

  // 패널 2: 괴리율 오실레이터 (0선 fill above/below + 평균·±1σ)
  const stats = state.full[a.id].stats;
  const anno = { zero: { type: "line", yMin: 0, yMax: 0, borderColor: "#9aa0ac", borderWidth: 1.3 } };
  if (stats && stats.std > 0) {
    anno.mean = { type: "line", yMin: stats.mean, yMax: stats.mean, borderColor: "#22c55e", borderWidth: 1, borderDash: [4, 4], label: { display: true, content: `평균 ${signPct(stats.mean)}`, position: "start", color: "#22c55e", backgroundColor: "transparent", font: { size: 10 } } };
    anno.up = { type: "line", yMin: stats.mean + stats.std, yMax: stats.mean + stats.std, borderColor: "#ef4444", borderWidth: 0.8, borderDash: [3, 5] };
    anno.dn = { type: "line", yMin: stats.mean - stats.std, yMax: stats.mean - stats.std, borderColor: "#3b82f6", borderWidth: 0.8, borderDash: [3, 5] };
  }
  const gid = `gap-${a.id}`;
  if (state.charts[gid]) state.charts[gid].destroy();
  state.charts[gid] = new Chart(document.getElementById(gid), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "괴리율 (%)", data: gap, borderColor: "#e5e7eb", borderWidth: 2, pointRadius: 0, tension: 0.15,
        fill: { target: { value: 0 }, above: "rgba(245,158,11,0.28)", below: "rgba(59,130,246,0.28)" },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#9aa0ac", boxWidth: 14, font: { size: 12 } } },
        tooltip: { mode: "index", intersect: false, callbacks: { label: (ctx) => `괴리율: ${signPct(ctx.parsed.y)}` } },
        annotation: { annotations: anno },
      },
      scales: {
        x: { ticks: { color: TICK, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: GRID } },
        y: { ticks: { color: TICK, font: { size: 11 }, callback: (v) => v + "%" }, grid: { color: GRID }, title: { display: true, text: "괴리율(%)", color: TICK, font: { size: 10 } } },
      },
    },
  });
}

/* ── 전체 재렌더(범위 변경 시) ───────────────────────── */
function renderAll(rangeDays) {
  state.range = rangeDays;
  renderCompareChart(rangeDays);
  state.assets.forEach((a, i) => renderAssetCharts(a, i, rangeDays));
}

/* ── 기간 토글 ───────────────────────────────────────── */
function setupToggle() {
  const el = document.getElementById("range-toggle");
  // 종목 중 가장 긴 시계열 기준으로 노출할 범위 결정
  const maxLen = Math.max(...state.assets.map((a) => state.full[a.id].series.length));
  const avail = RANGES.filter((r, i) => i === 0 || RANGES[i - 1].days < maxLen);
  let activeKey = avail.find((r) => r.key === "3M") ? "3M" : avail[avail.length - 1].key;

  function draw() {
    el.innerHTML = avail.map((r) => `<button data-key="${r.key}" data-days="${r.days}" class="${r.key === activeKey ? "active" : ""}">${r.key}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { activeKey = b.dataset.key; draw(); renderAll(Number(b.dataset.days)); };
    });
  }
  draw();
  renderAll(avail.find((r) => r.key === activeKey).days);
}

/* ── 초기화 ──────────────────────────────────────────── */
async function init() {
  let summary;
  try {
    summary = await loadJSON("data/summary.json");
    state.assets = summary.assets;
    await Promise.all(state.assets.map(async (a) => { state.full[a.id] = await loadJSON(`data/${a.id}.json`); }));
  } catch (e) {
    document.getElementById("compare-cards").innerHTML = `<div class="error-box">데이터를 불러오지 못했습니다.<br>${e.message}</div>`;
    return;
  }
  renderStatus(summary);
  renderCompareCards(summary);
  buildAssetSections();
  setupToggle();
}

init();
