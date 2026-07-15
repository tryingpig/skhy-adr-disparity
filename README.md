# SK하이닉스 ADR 괴리 트래커 (skhy-adr-disparity)

SK하이닉스 나스닥 ADR **[SKHY]** 와 코스피 본주 **[000660]** 의
프리미엄/디스카운트(**괴리율**)를 매일 자동 추적하는 정적 대시보드입니다.

🔗 **웹사이트**: https://tryingpig.github.io/skhy-adr-disparity/

## 괴리율 계산

SEC Form 424B4 기준 **ADS 1개 = 보통주 1/10주** (본주 1주 = ADR 10개):

```
ADR 환산가(본주 1주, KRW) = SKHY(USD) × 10 × 원달러환율
괴리율(%)                 = (ADR 환산가 − 본주 실제가) ÷ 본주 실제가 × 100
```

- **양수** = 미국 ADR이 본주보다 비싸게(프리미엄) 거래
- **음수** = 더 싸게(디스카운트) 거래
- 괴리율은 비율이라 원화·달러 어느 쪽으로 계산해도 같으며, **환율이 움직이면 주가가 그대로여도 괴리가 변한다.**

## 구조

| 파일 | 역할 |
|------|------|
| `scripts/update_data.py` | SKHY·000660.KS·KRW=X를 yfinance로 수집 → 괴리율/통계 계산 → `data/skhy.json` |
| `index.html` + `assets/` | 상단 괴리율 대형 표기 + 2패널 차트(본주 vs ADR환산가 / 괴리 오실레이터) |
| `.github/workflows/update.yml` | 평일 22:00 UTC(미 증시 마감 후) 자동 수집·커밋 |

## 데이터 소스

- **SKHY** — 나스닥 ADR 종가 (USD), Yahoo Finance
- **000660.KS** — 코스피 본주 종가 (KRW), Yahoo Finance
- **KRW=X** — 원/달러 환율, Yahoo Finance

한·미 시장 거래시간 차이로 각 종가는 최대 하루의 시차가 있을 수 있으며,
날짜 기준으로 정렬 후 전진보간(ffill)해 세 값이 모두 존재하는 날부터 계산합니다.

## 로컬 실행

```bash
pip install -r requirements.txt
python scripts/update_data.py   # data/skhy.json 생성
```

> 본 사이트는 정보 제공용이며 투자 권유가 아닙니다.
