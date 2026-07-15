#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ADR ↔ 본주 괴리 트래커 — 데이터 수집/계산 스크립트 (멀티 종목)

각 종목마다 세 시계열을 yfinance로 받아 ADR 프리미엄/디스카운트(괴리율)를 계산한다.
  · ADR 종가 (USD)      : 미국 상장 ADR
  · 본주 종가 (현지통화)  : 원 상장 시장
  · 환율 (현지통화/USD)   : USD 대비 현지통화

핵심 공식 (종목별 ADR 비율은 adr_per_share = '본주 1주당 ADR 개수'로 일반화)
  ADR 환산가(본주 1주, 현지통화) = ADR(USD) × adr_per_share × 환율
  괴리율(%)                     = (ADR 환산가 − 본주 실제가) ÷ 본주 실제가 × 100
  ADR 이론가(USD)               = 본주가 ÷ 환율 ÷ adr_per_share  (본주 기준 적정 ADR)

  · SK하이닉스: 1 ADS = 본주 1/10주 → 본주 1주 = ADR 10개 → adr_per_share = 10
  · TSMC:       1 ADR = 본주 5주   → 본주 1주 = ADR 1/5개 → adr_per_share = 0.2
  · 괴리율은 비율이라 통화와 무관하게 종목 간 직접 비교가 가능하다.

산출물:
  data/{id}.json      종목별 (메타 + 현재값 + 통계 + 시계열)
  data/summary.json   비교/상태바용 (전 종목 현재 괴리 요약)
"""

import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

# ── 추적 종목 정의 (한 곳만 바꾸면 종목 추가/수정) ─────────────────────
ASSETS = [
    {
        "id": "skhy", "name_ko": "SK하이닉스",
        "adr_symbol": "SKHY", "stock_symbol": "000660.KS", "fx_symbol": "KRW=X",
        "adr_per_share": 10,             # 본주 1주 = ADR 10개
        "ccy": "KRW", "ccy_symbol": "₩", "ccy_decimals": 0,
        "market": "KOSPI", "note": "1 ADS = 보통주 1/10주 (SEC Form 424B4)",
    },
    {
        "id": "tsm", "name_ko": "TSMC",
        "adr_symbol": "TSM", "stock_symbol": "2330.TW", "fx_symbol": "TWD=X",
        "adr_per_share": 0.2,            # 본주 1주 = ADR 1/5개 (1 ADR = 5주)
        "ccy": "TWD", "ccy_symbol": "NT$", "ccy_decimals": 1,
        "market": "TWSE", "note": "1 ADR = 보통주 5주",
    },
]

HISTORY_PERIOD = "1y"       # 수집 범위
STAT_WINDOW = 60            # 통계 계산 창 (거래일)

# 괴리율 구간 임계값(%) — 전 종목 공통
ZONE_PREMIUM_HI = 3.0       # ≥ +3   : 강한 프리미엄
ZONE_PREMIUM = 1.0          # +1~+3  : 프리미엄
ZONE_DISCOUNT = -1.0        # -1~+1  : 적정 / -3~-1 : 디스카운트
ZONE_DISCOUNT_HI = -3.0     # ≤ -3   : 강한 디스카운트
ZONES = {
    "premium_hi": ZONE_PREMIUM_HI, "premium": ZONE_PREMIUM,
    "discount": ZONE_DISCOUNT, "discount_hi": ZONE_DISCOUNT_HI,
}

KST = timezone(timedelta(hours=9))
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def classify_zone(gap: float) -> str:
    if gap >= ZONE_PREMIUM_HI:
        return "premium_hi"
    if gap >= ZONE_PREMIUM:
        return "premium"
    if gap > ZONE_DISCOUNT:
        return "fair"
    if gap > ZONE_DISCOUNT_HI:
        return "discount"
    return "discount_hi"


def fetch_close(ticker: str, retries: int = 3) -> pd.Series:
    """yfinance 일봉 종가 Series(인덱스=날짜)를 받는다. 실패 시 재시도."""
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            df = yf.Ticker(ticker).history(
                period=HISTORY_PERIOD, interval="1d", auto_adjust=True
            )
            if df is not None and not df.empty and "Close" in df.columns:
                s = df["Close"].copy()
                s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                s = s[~s.index.duplicated(keep="last")]
                return s
            last_err = f"빈 데이터 (시도 {attempt})"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"{ticker} 수집 실패: {last_err}")


def build_frame(asset: dict) -> pd.DataFrame:
    """세 종가를 날짜 union + 전진보간(ffill)으로 맞춰 괴리율 시계열을 만든다."""
    aps = asset["adr_per_share"]
    adr = fetch_close(asset["adr_symbol"]).rename("adr_usd")
    stock = fetch_close(asset["stock_symbol"]).rename("stock_local")
    fx = fetch_close(asset["fx_symbol"]).rename("fx")

    idx = adr.index.union(stock.index).union(fx.index).sort_values()
    df = pd.DataFrame(index=idx)
    df["adr_usd"] = adr.reindex(idx).ffill()
    df["stock_local"] = stock.reindex(idx).ffill()
    df["fx"] = fx.reindex(idx).ffill()
    df = df.dropna()

    df["adr_local"] = df["adr_usd"] * aps * df["fx"]          # ADR 환산가(본주 1주)
    df["gap_pct"] = (df["adr_local"] / df["stock_local"] - 1.0) * 100.0
    df["adr_fair_usd"] = df["stock_local"] / df["fx"] / aps    # 본주 기준 적정 ADR
    return df.round(4)


def compute_stats(gap_series: pd.Series) -> dict:
    window = gap_series.tail(STAT_WINDOW)
    n = len(window)
    mean = float(window.mean())
    std = float(window.std(ddof=0)) if n > 1 else 0.0
    cur = float(gap_series.iloc[-1])
    z = (cur - mean) / std if std > 1e-9 else 0.0
    pct = float((window <= cur).sum()) / n * 100.0 if n else 50.0
    return {
        "window": n, "mean": round(mean, 3), "std": round(std, 3),
        "zscore": round(z, 2), "percentile": round(pct, 1),
        "min": round(float(window.min()), 3), "max": round(float(window.max()), 3),
    }


def process_asset(asset: dict, now: datetime) -> dict:
    """종목 하나를 수집·계산하고 data/{id}.json을 쓴 뒤 summary 스냅샷을 반환."""
    df = build_frame(asset)
    if df.empty:
        raise RuntimeError("계산 가능한 데이터 없음")

    last = df.iloc[-1]
    as_of = df.index[-1].strftime("%Y-%m-%d")
    gap = float(last["gap_pct"])
    stats = compute_stats(df["gap_pct"])

    current = {
        "stock_local": float(last["stock_local"]),
        "adr_usd": float(last["adr_usd"]),
        "fx": float(last["fx"]),
        "adr_local": float(last["adr_local"]),
        "adr_fair_usd": float(last["adr_fair_usd"]),
        "gap_pct": gap,
        "zone": classify_zone(gap),
    }
    series = [
        {
            "date": idx.strftime("%Y-%m-%d"),
            "stock_local": float(row["stock_local"]),
            "adr_usd": float(row["adr_usd"]),
            "fx": float(row["fx"]),
            "adr_local": float(row["adr_local"]),
            "gap_pct": float(row["gap_pct"]),
        }
        for idx, row in df.iterrows()
    ]

    meta = {k: asset[k] for k in
            ("id", "name_ko", "adr_symbol", "stock_symbol", "fx_symbol",
             "adr_per_share", "ccy", "ccy_symbol", "ccy_decimals", "market", "note")}
    payload = {
        **meta,
        "updated_at": now.isoformat(timespec="seconds"),
        "as_of_date": as_of,
        "zones": ZONES,
        "current": current,
        "stats": stats,
        "series": series,
    }
    (DATA_DIR / f"{asset['id']}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"[OK] {asset['name_ko']:8s} gap {gap:+6.2f}% ({current['zone']})  "
          f"stock {last['stock_local']:>12,.1f} {asset['ccy']}  "
          f"ADR ${last['adr_usd']:>7,.2f}  fx {last['fx']:>8,.2f}  as_of {as_of}  n={len(series)}")

    return {**meta, "as_of_date": as_of, "current": current, "stats": stats}


def build():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(KST)

    summaries, errors = [], []
    for asset in ASSETS:
        try:
            summaries.append(process_asset(asset, now))
        except Exception as e:  # noqa: BLE001
            errors.append(asset["id"])
            print(f"  [FAIL] {asset['id']}: {e}", file=sys.stderr)

    if not summaries:
        print("수집된 종목이 하나도 없습니다. 중단.", file=sys.stderr)
        sys.exit(1)

    as_of = max(s["as_of_date"] for s in summaries)
    summary = {
        "updated_at": now.isoformat(timespec="seconds"),
        "as_of_date": as_of,
        "zones": ZONES,
        "assets": summaries,
    }
    (DATA_DIR / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n완료: {len(summaries)}/{len(ASSETS)} 종목, as_of {as_of}")
    if errors:
        print(f"실패: {', '.join(errors)}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    build()
