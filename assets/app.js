/* ── SK하이닉스 ADR 괴리 트래커 — 렌더 ────────────────────────────────
 * data/skhy.json (메타 + 현재값 + 통계 + 시계열) 하나만 읽어 렌더한다.
 */

const ZONE_META = {
  premium_hi:  { label: "강한 프리미엄", color: "#ef4444" },
  premium:     { label: "프리미엄",     color: "#f59e0b" },
  fair:        { label: "적정",         color: "#22c55e" },
  discount:    { label: "디스카운트",   color: "#3b82f6" },
  discount_hi: { label: "강한 디스카운트", color: "#8b5cf6" },
};

const DATA_URL = "data/skhy.json";

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
function won(v) { return "₩" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function usd(v) { return "$" + fmt(v, 2); }
function signPct(v) { return (v >= 0 ? "+" : "") + fmt(v, 2) + "%"; }

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

/* ── 히어로 블록 ─────────────────────────────────────── */
function renderHero(data) {
  const c = data.current;
  const s = data.stats;
  const zone = c.zone;
  const zm = ZONE_META[zone];
  const dir = c.gap_pct >= 0 ? "ADR이 본주보다 비쌈 (프리미엄)" : "ADR이 본주보다 쌈 (디스카운트)";

  document.getElementById("hero").innerHTML = `
    <div class="hero-label">현재 괴리율 (ADR vs 본주)</div>
    <div class="hero-gap z-${zone}">${signPct(c.gap_pct)}</div>
    <div class="hero-state">
      <span class="badge hero-badge z-${zone} bg-${zone}">${zm.label}</span>
      <span class="hero-dir">${dir}</span>
    </div>

    <div class="hero-sub">
      <div class="cell"><div class="k">본주 실제가 (000660)</div><div class="v">${won(c.stock_krw)}</div></div>
      <div class="cell"><div class="k">ADR 실제가 (SKHY)</div><div class="v">${usd(c.adr_usd)}</div></div>
      <div class="cell"><div class="k">ADR 이론가 (적정)</div><div class="v">${usd(c.adr_fair_usd)}</div><div class="vsub">본주 기준 적정 ADR</div></div>
      <div class="cell"><div class="k">원/달러 환율</div><div class="v">${fmt(c.usdkrw, 1)}</div></div>
    </div>

    <div class="stat-strip">
      <span class="stat-chip">최근 ${s.window}일 평균 <strong>${signPct(s.mean)}</strong></span>
      <span class="stat-chip">현재 백분위 <strong>${fmt(s.percentile, 0)}%</strong></span>
      <span class="stat-chip">z-score <strong>${fmt(s.zscore, 2)}</strong></span>
      <span class="stat-chip">범위 <strong>${signPct(s.min)} ~ ${signPct(s.max)}</strong></span>
    </div>
  `;
}

/* ── 상태 바 ─────────────────────────────────────────── */
function renderStatus(data) {
  const c = data.current;
  document.getElementById("status-bar").innerHTML = `
    <span class="status-pill">기준일 <strong>${data.as_of_date}</strong></span>
    <span class="status-pill">갱신 <strong>${fmtDateTime(data.updated_at)}</strong></span>
    <span class="status-pill">ADR 비율 <strong>${data.adr_per_share} : 1</strong> (ADR:본주)</span>
    <span class="status-pill">괴리 <strong class="z-${c.zone}">${signPct(c.gap_pct)}</strong></span>
  `;
}

/* ── 2패널 차트 ──────────────────────────────────────── */
let priceChart, gapChart;

function renderCharts(data, rangeDays) {
  const all = data.series;
  const d = rangeDays >= all.length ? all : all.slice(-rangeDays);
  const labels = d.map((x) => x.date);
  const stockKrw = d.map((x) => x.stock_krw);
  const adrKrw = d.map((x) => x.adr_krw);
  const usdkrw = d.map((x) => x.usdkrw);
  const gap = d.map((x) => x.gap_pct);

  const gridColor = "rgba(255,255,255,0.05)";
  const tickColor = "#6b7280";

  // ── 패널 1: 본주 vs ADR 환산가 (좌축, KRW) + 환율 (우축) ──
  if (priceChart) priceChart.destroy();
  priceChart = new Chart(document.getElementById("priceChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "본주 실제가 (₩)", data: stockKrw, yAxisID: "y", borderColor: "#14b8a6", backgroundColor: "rgba(20,184,166,0.06)", borderWidth: 2.4, pointRadius: 0, tension: 0.15, fill: false, order: 2 },
        { label: "ADR 환산가 (₩)", data: adrKrw, yAxisID: "y", borderColor: "#f59e0b", borderWidth: 2.4, pointRadius: 0, tension: 0.15, fill: false, order: 1 },
        { label: "원/달러 환율", data: usdkrw, yAxisID: "y1", borderColor: "#6b7280", borderWidth: 1.2, borderDash: [4, 4], pointRadius: 0, tension: 0.15, fill: false, order: 3 },
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
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (ctx.dataset.yAxisID === "y1") return `${ctx.dataset.label}: ${fmt(v, 1)}`;
              return `${ctx.dataset.label}: ₩${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: gridColor } },
        y: {
          position: "left", ticks: { color: tickColor, font: { size: 11 }, callback: (v) => "₩" + (v / 1e6).toFixed(2) + "M" },
          grid: { color: gridColor }, title: { display: true, text: "본주 1주 (원화)", color: tickColor, font: { size: 10 } },
        },
        y1: {
          position: "right", ticks: { color: "#6b7280", font: { size: 11 } }, grid: { drawOnChartArea: false },
          title: { display: true, text: "원/달러", color: "#6b7280", font: { size: 10 } },
        },
      },
    },
  });

  // ── 패널 2: 괴리율 오실레이터 (0선 기준 위=프리미엄 / 아래=디스카운트) ──
  const stats = data.stats;
  const anno = {
    zero: { type: "line", yMin: 0, yMax: 0, borderColor: "#9aa0ac", borderWidth: 1.4 },
  };
  if (stats && stats.std > 0) {
    const up = stats.mean + stats.std, dn = stats.mean - stats.std;
    anno.mean = { type: "line", yMin: stats.mean, yMax: stats.mean, borderColor: "#22c55e", borderWidth: 1, borderDash: [4, 4], label: { display: true, content: `평균 ${signPct(stats.mean)}`, position: "start", color: "#22c55e", backgroundColor: "transparent", font: { size: 10 } } };
    anno.up = { type: "line", yMin: up, yMax: up, borderColor: "#ef4444", borderWidth: 0.8, borderDash: [3, 5] };
    anno.dn = { type: "line", yMin: dn, yMax: dn, borderColor: "#3b82f6", borderWidth: 0.8, borderDash: [3, 5] };
  }

  if (gapChart) gapChart.destroy();
  gapChart = new Chart(document.getElementById("gapChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "괴리율 (%)", data: gap,
        borderColor: "#e5e7eb", borderWidth: 2, pointRadius: 0, tension: 0.15,
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
        x: { ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: gridColor } },
        y: { ticks: { color: tickColor, font: { size: 11 }, callback: (v) => v + "%" }, grid: { color: gridColor }, title: { display: true, text: "괴리율(%)", color: tickColor, font: { size: 10 } } },
      },
    },
  });
}

/* ── 최근 기록 표 ────────────────────────────────────── */
function renderRecent(data) {
  const zones = data.zones;
  const recent = data.series.slice(-14).reverse();
  document.getElementById("recent-table").innerHTML = `
    <thead><tr>
      <th class="left">날짜</th>
      <th>본주 (₩)</th>
      <th class="hide-sm">ADR ($)</th>
      <th class="hide-sm">환율</th>
      <th>ADR 환산가 (₩)</th>
      <th>괴리율</th>
    </tr></thead>
    <tbody>${recent.map((x) => {
      const z = zoneOf(x.gap_pct, zones);
      return `<tr>
        <td class="left">${x.date}</td>
        <td>${won(x.stock_krw)}</td>
        <td class="hide-sm">${usd(x.adr_usd)}</td>
        <td class="hide-sm">${fmt(x.usdkrw, 1)}</td>
        <td>${won(x.adr_krw)}</td>
        <td><span class="gap z-${z}">${signPct(x.gap_pct)}</span></td>
      </tr>`;
    }).join("")}</tbody>`;
}

/* ── 기간 토글 ───────────────────────────────────────── */
const RANGES = [
  { key: "2W", days: 14 },
  { key: "1M", days: 22 },
  { key: "3M", days: 66 },
  { key: "6M", days: 132 },
  { key: "전체", days: 100000 },
];

function setupToggle(data) {
  const el = document.getElementById("range-toggle");
  const maxDays = data.series.length;
  // 데이터가 있는 범위 + '전체'만 노출
  const avail = RANGES.filter((r, i) => i === 0 || RANGES[i - 1].days < maxDays);
  let activeKey = avail[avail.length - 1].key; // 초기엔 전체(데이터 적음)

  function draw() {
    el.innerHTML = avail.map((r) => `<button data-key="${r.key}" data-days="${r.days}" class="${r.key === activeKey ? "active" : ""}">${r.key}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { activeKey = b.dataset.key; draw(); renderCharts(data, Number(b.dataset.days)); };
    });
  }
  draw();
  renderCharts(data, avail.find((r) => r.key === activeKey).days);
}

/* ── 초기화 ──────────────────────────────────────────── */
async function init() {
  let data;
  try {
    data = await loadJSON(DATA_URL);
  } catch (e) {
    document.getElementById("hero").innerHTML = `<div class="error-box">데이터를 불러오지 못했습니다.<br>${e.message}</div>`;
    return;
  }
  renderStatus(data);
  renderHero(data);
  renderRecent(data);
  setupToggle(data);
}

init();
