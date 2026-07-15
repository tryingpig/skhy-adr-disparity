#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SK하이닉스 ADR(SKHY) ↔ 본주(000660) 괴리 트래커 — 데이터 수집/계산 스크립트

세 시계열을 yfinance로 받아 ADR 프리미엄/디스카운트(괴리율)를 계산한다.
  · SKHY      : 나스닥 ADR 종가 (USD)
  · 000660.KS : SK하이닉스 본주 종가 (KRW)
  · KRW=X     : 원/달러 환율 (KRW per USD)

핵심 공식 (SEC Form 424B4: ADS 1개 = 보통주 1/10주 → 본주 1주 = ADR 10개)
  ADR 환산가(본주 1주, KRW) = SKHY(USD) × ADR_PER_SHARE × USDKRW
  괴리율(%)                 = (ADR 환산가 − 본주 실제가) ÷ 본주 실제가 × 100
  · 양수 = ADR이 본주보다 비쌈(프리미엄) / 음수 = ADR이 쌈(디스카운트)
  · 괴리율은 비율이라 원화·달러 어느 쪽으로 계산해도 동일하다.

산출물: data/skhy.json  (메타 + 현재값 + 통계 + 전체 시계열)
"""

import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

# ── 설정 (한 곳만 바꾸면 되도록 상수화) ────────────────────────────────
ADR_PER_SHARE = 10          # 본주 1주 = ADR 10개 (SEC 424B4: 1 ADS = 1/10 주)
HISTORY_PERIOD = "6mo"      # 수집 범위 (상장 2026-07-10 이후만 유효)
STAT_WINDOW = 60            # 통계(평균·표준편차·백분위) 계산 창 (거래일)

SYMBOLS = {
    "adr":   "SKHY",        # 나스닥 ADR (USD)
    "stock": "000660.KS",   # 코스피 본주 (KRW)
    "fx":    "KRW=X",        # USDKRW (원/달러)
}

# 괴리율 구간 임계값(%) — 초기 기준값, 데이터 쌓이면 조정 가능
ZONE_PREMIUM_HI = 3.0       # ≥ +3   : 강한 프리미엄
ZONE_PREMIUM = 1.0          # +1~+3  : 프리미엄
ZONE_DISCOUNT = -1.0        # -1~+1  : 적정 / -3~-1 : 디스카운트
ZONE_DISCOUNT_HI = -3.0     # ≤ -3   : 강한 디스카운트

KST = timezone(timedelta(hours=9))
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def classify_zone(gap: float) -> str:
    """괴리율(%)을 구간 코드로 변환한다."""
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
    """yfinance 일봉 종가 Series를 받는다(인덱스=날짜 date). 실패 시 재시도."""
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            df = yf.Ticker(ticker).history(
                period=HISTORY_PERIOD, interval="1d", auto_adjust=True
            )
            if df is not None and not df.empty and "Close" in df.columns:
                s = df["Close"].copy()
                # 거래소별 tz를 떼고 '달력 날짜'로 정규화해 세 시계열을 맞춘다
                s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                s = s[~s.index.duplicated(keep="last")]
                return s
            last_err = f"빈 데이터 (시도 {attempt})"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"{ticker} 수집 실패: {last_err}")


def build_series() -> pd.DataFrame:
    """세 종가를 날짜 기준으로 정렬·전진보간(ffill)해 괴리율 시계열을 만든다.

    한·미 시장은 거래일/시간이 달라 날짜별로 결측이 생긴다.
    → 각 시계열을 union 날짜축에 맞춰 ffill(최근 종가 유지)한 뒤,
      세 값이 모두 존재하는 날부터 괴리율을 계산한다.
    """
    adr = fetch_close(SYMBOLS["adr"]).rename("adr_usd")
    stock = fetch_close(SYMBOLS["stock"]).rename("stock_krw")
    fx = fetch_close(SYMBOLS["fx"]).rename("usdkrw")

    idx = adr.index.union(stock.index).union(fx.index).sort_values()
    df = pd.DataFrame(index=idx)
    df["adr_usd"] = adr.reindex(idx).ffill()
    df["stock_krw"] = stock.reindex(idx).ffill()
    df["usdkrw"] = fx.reindex(idx).ffill()
    df = df.dropna()  # 세 값이 다 채워지기 전(상장 이전 등) 구간 제거

    # 본주 1주 기준 ADR 환산가(KRW)와 괴리율(%)
    df["adr_krw"] = df["adr_usd"] * ADR_PER_SHARE * df["usdkrw"]
    df["gap_pct"] = (df["adr_krw"] / df["stock_krw"] - 1.0) * 100.0
    # ADR 이론가(USD) = 본주가 ÷ 환율 ÷ ADR당본주수(=×0.1) — 참고 표기용
    df["adr_fair_usd"] = df["stock_krw"] / df["usdkrw"] / ADR_PER_SHARE
    return df.round(4)


def compute_stats(gap_series: pd.Series) -> dict:
    """최근 STAT_WINDOW 구간의 평균·표준편차·z-score·백분위를 계산한다."""
    window = gap_series.tail(STAT_WINDOW)
    n = len(window)
    mean = float(window.mean())
    std = float(window.std(ddof=0)) if n > 1 else 0.0
    cur = float(gap_series.iloc[-1])
    z = (cur - mean) / std if std > 1e-9 else 0.0
    # 백분위: 현재값이 창 안에서 하위 몇 %인지 (100=가장 높은 프리미엄)
    pct = float((window <= cur).sum()) / n * 100.0 if n else 50.0
    return {
        "window": n,
        "mean": round(mean, 3),
        "std": round(std, 3),
        "zscore": round(z, 2),
        "percentile": round(pct, 1),
        "min": round(float(window.min()), 3),
        "max": round(float(window.max()), 3),
    }


def build():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(KST)

    df = build_series()
    if df.empty:
        print("계산 가능한 데이터가 없습니다(상장 직후 데이터 대기). 중단.", file=sys.stderr)
        sys.exit(1)

    last = df.iloc[-1]
    as_of = df.index[-1].strftime("%Y-%m-%d")
    gap = float(last["gap_pct"])
    stats = compute_stats(df["gap_pct"])

    series = [
        {
            "date": idx.strftime("%Y-%m-%d"),
            "stock_krw": float(row["stock_krw"]),   # 본주 실제가 (KRW)
            "adr_usd": float(row["adr_usd"]),        # ADR 종가 (USD)
            "usdkrw": float(row["usdkrw"]),          # 환율
            "adr_krw": float(row["adr_krw"]),        # ADR 환산가 (본주 1주, KRW)
            "gap_pct": float(row["gap_pct"]),        # 괴리율 (%)
        }
        for idx, row in df.iterrows()
    ]

    payload = {
        "updated_at": now.isoformat(timespec="seconds"),
        "as_of_date": as_of,
        "adr_per_share": ADR_PER_SHARE,
        "symbols": SYMBOLS,
        "zones": {
            "premium_hi": ZONE_PREMIUM_HI,
            "premium": ZONE_PREMIUM,
            "discount": ZONE_DISCOUNT,
            "discount_hi": ZONE_DISCOUNT_HI,
        },
        "current": {
            "stock_krw": float(last["stock_krw"]),
            "adr_usd": float(last["adr_usd"]),
            "usdkrw": float(last["usdkrw"]),
            "adr_krw": float(last["adr_krw"]),
            "adr_fair_usd": float(last["adr_fair_usd"]),
            "gap_pct": gap,
            "zone": classify_zone(gap),
        },
        "stats": stats,
        "series": series,
    }
    (DATA_DIR / "skhy.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        f"[OK] gap {gap:+.2f}% ({classify_zone(gap)})  "
        f"stock KRW {last['stock_krw']:,.0f}  ADR USD {last['adr_usd']:,.2f}  "
        f"usdkrw {last['usdkrw']:,.1f}  as_of {as_of}  (n={len(series)})"
    )


if __name__ == "__main__":
    build()
