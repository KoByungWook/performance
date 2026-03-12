# 04. 블록 구간 성능 추출 (Block Performance Extraction)

## 개요

특정 블록 구간(`startBlock` ~ `endBlock`)의 온체인 데이터를 수집하여 TPS, Mgas/s 등 성능 지표를 산출한다.
결과는 **JSON 파일**(데이터)과 **HTML 파일**(브라우저에서 바로 열 수 있는 리포트)로 함께 저장한다.
부하 테스트 종료 후 결과 분석 단계에서 사용한다.

구간 크기에 따라 두 가지 API를 제공한다.

| API | 엔드포인트 | 처리 방식 | 최대 구간 |
|-----|-----------|----------|----------|
| 동기 추출 | `POST /perf/blocks` | 완료까지 대기 후 결과 반환 | `PERF_SYNC_MAX_BLOCK_RANGE` (기본 1,000) |
| 비동기 추출 | `POST /perf/blocks/async` | 즉시 jobId 반환, 백그라운드 처리 | `PERF_ASYNC_MAX_BLOCK_RANGE` (기본 10,000) |

---

## API

### POST /perf/blocks — 동기 추출 (소규모 구간)

요청이 완료될 때까지 대기하다가 결과를 Response Body로 반환한다.
동일 네트워크 기준 1,000블록 ≈ 1~2초이므로 HTTP 타임아웃 내에 처리 가능하다.

**Request Body**

```json
{
  "startBlock": 1000,
  "endBlock": 1999
}
```

**처리 흐름**

```
1. 범위 검증 (startBlock ≤ endBlock, 구간 ≤ PERF_SYNC_MAX_BLOCK_RANGE)
2. 블록 헤더 수집 (eth_getBlockByNumber, fullTransactions: false)
3. 통계 산출
4. {REPORT_DIR}/{startBlock}-{endBlock}.json 저장
5. {REPORT_DIR}/{startBlock}-{endBlock}.html 저장
6. 결과를 Response Body로 반환
```

**Response 200**

```json
{
  "jsonFile": "./reports/1000-1999.json",
  "htmlFile": "./reports/1000-1999.html",
  "result": { /* 결과 구조 참고 */ }
}
```

**에러**

| 상황 | 코드 | 설명 |
|------|------|------|
| `startBlock > endBlock` | 400 | 범위 오류 |
| 구간이 `PERF_SYNC_MAX_BLOCK_RANGE` 초과 | 400 | 동기 허용 범위 초과. `/perf/blocks/async` 사용 권장 |
| `endBlock`이 체인 최신 블록 초과 | 400 | 아직 생성되지 않은 블록 |
| 블록 수집 중 RPC 오류 | 500 | — |

---

### POST /perf/blocks/async — 비동기 추출 (대규모 구간)

요청 즉시 `jobId`를 반환하고, 블록 수집 및 통계 산출은 백그라운드에서 진행한다.
완료 여부는 `GET /perf/jobs/:jobId`로 폴링한다.

**Request Body**

```json
{
  "startBlock": 1000,
  "endBlock": 9999
}
```

**처리 흐름**

```
[요청 시]
1. 범위 검증 (startBlock ≤ endBlock, 구간 ≤ PERF_ASYNC_MAX_BLOCK_RANGE)
2. jobId 생성 (UUID v4)
3. 잡 상태 파일 초기화 → {REPORT_DIR}/.jobs/{jobId}.json (status: "pending")
4. 백그라운드 처리 시작 (fire-and-forget)
5. 즉시 202 반환

[백그라운드]
6. 잡 상태 → "running"
7. 블록 헤더 수집 (eth_getBlockByNumber, fullTransactions: false)
8. 통계 산출
9. {REPORT_DIR}/{startBlock}-{endBlock}.json 저장
10. {REPORT_DIR}/{startBlock}-{endBlock}.html 저장
11. 잡 상태 → "done" (또는 오류 시 "failed")
```

**Response 202**

```json
{
  "jobId": "a1b2c3d4-...",
  "status": "pending",
  "jsonFile": "./reports/1000-9999.json",
  "htmlFile": "./reports/1000-9999.html"
}
```

**에러 (즉시 반환)**

| 상황 | 코드 | 설명 |
|------|------|------|
| `startBlock > endBlock` | 400 | 범위 오류 |
| 구간이 `PERF_ASYNC_MAX_BLOCK_RANGE` 초과 | 400 | 비동기 최대 허용 범위 초과 |
| `endBlock`이 체인 최신 블록 초과 | 400 | 아직 생성되지 않은 블록 |

---

### GET /perf/jobs/:jobId — 잡 상태 조회

비동기 잡의 현재 상태를 반환한다.

**Path Parameter**

| 파라미터 | 설명 |
|---------|------|
| `jobId` | `POST /perf/blocks/async` 응답의 `jobId` |

**Response 200**

```json
{
  "jobId": "a1b2c3d4-...",
  "status": "done",
  "startBlock": 1000,
  "endBlock": 9999,
  "jsonFile": "./reports/1000-9999.json",
  "htmlFile": "./reports/1000-9999.html",
  "startedAt": "2026-02-26T12:00:00.000Z",
  "completedAt": "2026-02-26T12:00:18.000Z"
}
```

오류 시:

```json
{
  "jobId": "a1b2c3d4-...",
  "status": "failed",
  "startBlock": 1000,
  "endBlock": 9999,
  "startedAt": "2026-02-26T12:00:00.000Z",
  "error": "eth_getBlockByNumber: connection refused"
}
```

**`status` 값**

| 값 | 설명 |
|----|------|
| `pending` | 잡이 등록됐으나 아직 시작 전 |
| `running` | 블록 수집 진행 중 |
| `done` | 완료. `jsonFile`, `htmlFile` 경로에 결과 파일 저장됨 |
| `failed` | 실패. `error` 필드에 원인 포함 |

**에러**

| 상황 | 코드 | 설명 |
|------|------|------|
| jobId 없음 | 404 | 잡이 존재하지 않거나 다른 인스턴스에서 생성된 잡 |

---

## 잡 상태 파일

비동기 잡의 상태는 파일로 관리한다. pm2 멀티 인스턴스 환경에서 어느 인스턴스에서도 조회 가능하고, 프로세스 재시작 후에도 유지된다.

- 경로: `{REPORT_DIR}/.jobs/{jobId}.json`
- 잡 시작 시 생성, 완료/실패 시 갱신

```json
{
  "jobId": "a1b2c3d4-...",
  "status": "running",
  "startBlock": 1000,
  "endBlock": 9999,
  "jsonFile": "./reports/1000-9999.json",
  "htmlFile": "./reports/1000-9999.html",
  "startedAt": "2026-02-26T12:00:00.000Z",
  "completedAt": null,
  "error": null
}
```

---

## 결과 파일 구조

동기/비동기 모두 동일한 파일 쌍을 생성한다. 저장 경로는 `REPORT_DIR` 환경변수 (기본값: `./reports`).

| 파일 | 용도 |
|------|------|
| `{startBlock}-{endBlock}.json` | 원시 데이터. 자동화 파이프라인, 추가 분석용 |
| `{startBlock}-{endBlock}.html` | 브라우저에서 바로 열 수 있는 시각적 리포트 |

### JSON 파일

파일명: `{startBlock}-{endBlock}.json`

```json
{
  "meta": {
    "startBlock": 1000,
    "endBlock": 1999,
    "generatedAt": "2026-02-26T12:00:00.000Z"
  },
  "blocks": {
    "count": 1000,
    "firstTimestamp": 1700000000,
    "lastTimestamp": 1700009990,
    "elapsedSeconds": 9990,
    "avgBlockTimeSeconds": 10.0
  },
  "transactions": {
    "total": 50000,
    "perBlock": {
      "avg": 50.0,
      "min": 0,
      "max": 100,
      "stddev": 8.21
    }
  },
  "gas": {
    "totalUsed": "10500000000",
    "perBlock": {
      "avg": "10500000",
      "min": "0",
      "max": "30000000"
    },
    "perTx": {
      "avg": "210000"
    },
    "utilization": {
      "avg": 35.0,
      "min": 0.0,
      "max": 100.0
    }
  },
  "performance": {
    "TPS": 5.005,
    "Mgas/s": 1.051,
    "avgBlockTimeSeconds": 10.0
  }
}
```

### 필드 상세

#### `meta`

| 필드 | 설명 |
|------|------|
| `startBlock` | 요청한 시작 블록 번호 |
| `endBlock` | 요청한 종료 블록 번호 |
| `generatedAt` | 결과 생성 시각 (ISO 8601) |

#### `blocks`

| 필드 | 설명 |
|------|------|
| `count` | 수집한 블록 수 (`endBlock - startBlock + 1`) |
| `firstTimestamp` | 시작 블록의 타임스탬프 (Unix초) |
| `lastTimestamp` | 종료 블록의 타임스탬프 (Unix초) |
| `elapsedSeconds` | `lastTimestamp - firstTimestamp` |
| `avgBlockTimeSeconds` | `elapsedSeconds / (count - 1)`. `count = 1`이면 `null` |

#### `transactions`

| 필드 | 설명 |
|------|------|
| `total` | 구간 내 전체 트랜잭션 수 |
| `perBlock.avg` | 블록당 평균 트랜잭션 수 |
| `perBlock.min` | 블록당 최소 트랜잭션 수 |
| `perBlock.max` | 블록당 최대 트랜잭션 수 |
| `perBlock.stddev` | 블록당 트랜잭션 수 표준편차 |

#### `gas`

| 필드 | 설명 |
|------|------|
| `totalUsed` | 구간 내 전체 gasUsed 합계 (문자열) |
| `perBlock.avg` | 블록당 평균 gasUsed (문자열) |
| `perBlock.min` | 블록당 최소 gasUsed (문자열) |
| `perBlock.max` | 블록당 최대 gasUsed (문자열) |
| `perTx.avg` | 트랜잭션당 평균 gasUsed (문자열). `total = 0`이면 `null` |
| `utilization.avg` | 블록 gasUsed/gasLimit 평균 (%) |
| `utilization.min` | 블록 가스 사용률 최솟값 (%) |
| `utilization.max` | 블록 가스 사용률 최댓값 (%) |

#### `performance`

| 필드 | 설명 |
|------|------|
| `TPS` | `total tx / elapsedSeconds`. `elapsedSeconds = 0`이면 `null` |
| `Mgas/s` | `totalGasUsed / 1_000_000 / elapsedSeconds`. `elapsedSeconds = 0`이면 `null` |
| `avgBlockTimeSeconds` | `blocks.avgBlockTimeSeconds`와 동일 |

### HTML 파일

파일명: `{startBlock}-{endBlock}.html`

외부 의존성 없이 단일 파일로 완결된다 (CDN·인터넷 접속 불필요). JSON 데이터를 인라인으로 포함하며, 아래 섹션으로 구성된다.

```
┌─────────────────────────────────────────────┐
│  Block Performance Report                   │
│  Blocks 1000 ~ 1999  |  2026-02-26 12:00   │
├──────────────┬──────────────┬───────────────┤
│  TPS         │  Mgas/s      │  Avg BlkTime  │
│  5.005       │  1.051       │  10.0 s       │
├──────────────┴──────────────┴───────────────┤
│  Blocks                                     │
│  Count | Elapsed | Avg Block Time           │
│  1000  | 9990 s  | 10.0 s                  │
├─────────────────────────────────────────────┤
│  Transactions                               │
│  Total  | Avg/Block | Min | Max | Stddev    │
│  50,000 | 50.0      |  0  | 100 | 8.21     │
├─────────────────────────────────────────────┤
│  Gas                                        │
│  Total Used | Avg/Block | Avg/Tx            │
│  10.5 Ggas  | 10.5 Mgas | 210,000          │
│                                             │
│  Utilization  avg 35.0% | min 0% | max 100% │
└─────────────────────────────────────────────┘
```

---

## 통계 산출 공식

```
elapsedSeconds    = block[endBlock].timestamp - block[startBlock].timestamp
avgBlockTime      = elapsedSeconds / (blockCount - 1)

totalTx           = Σ block[i].transactions.length
avgTxPerBlock     = totalTx / blockCount
stddevTxPerBlock  = sqrt( Σ(txCount[i] - avg)² / blockCount )

totalGasUsed      = Σ block[i].gasUsed
avgGasPerBlock    = totalGasUsed / blockCount
avgGasPerTx       = totalGasUsed / totalTx        (totalTx > 0 일 때)
utilization[i]    = block[i].gasUsed / block[i].gasLimit × 100

TPS               = totalTx / elapsedSeconds       (elapsedSeconds > 0 일 때)
Mgas/s            = totalGasUsed / 1_000_000 / elapsedSeconds
```

---

## 구현 상세

### 파일 위치

```
src/
├── routes/
│   └── perf.routes.ts      # POST /perf/blocks, POST /perf/blocks/async, GET /perf/jobs/:jobId
└── services/
    └── perf.service.ts     # 블록 수집·통계 산출 (공통 코어), 잡 관리
```

### 공통 코어 함수

동기/비동기 모두 동일한 블록 수집·통계 산출 함수를 공유한다.

```
extractBlockRange(startBlock, endBlock) → PerfResult
  ├─ 블록 번호 목록 생성
  ├─ PERF_FETCH_CONCURRENCY 크기 청크로 분할
  ├─ 청크별 Promise.all(eth_getBlockByNumber) 병렬 수집
  ├─ 결과 병합 및 통계 산출
  └─ PerfResult 반환
```

### 응답 방식별 래퍼

```
[동기]  extractSync(startBlock, endBlock)
          → extractBlockRange() 호출
          → JSON 파일 저장 ({startBlock}-{endBlock}.json)
          → HTML 파일 저장 ({startBlock}-{endBlock}.html)
          → 반환

[비동기] extractAsync(startBlock, endBlock) → jobId 즉시 반환
          → 백그라운드: extractBlockRange() 호출
                        → JSON 파일 저장
                        → HTML 파일 저장
                        → 잡 상태 파일 갱신 (done / failed)
```

### 블록 수집 병렬 처리

```
전체 블록 → PERF_FETCH_CONCURRENCY 크기 청크 분할 → 청크별 Promise.all → 결과 병합
```

> ethers.js `JsonRpcProvider`는 Node.js `http.globalAgent`(`maxSockets = 5`)를 사용한다.
> 실제 동시 HTTP 연결 수는 `min(PERF_FETCH_CONCURRENCY, maxSockets)` ≈ 5로 제한된다.
> 필요 시 provider 생성 시 전용 `http.Agent({ maxSockets: PERF_FETCH_CONCURRENCY })`를 주입하면
> 설정값만큼 병렬도를 높일 수 있다.

**예상 소요 시간**

| 환경 | RPC 레이턴시 | 1,000블록 | 5,000블록 | 10,000블록 |
|------|------------|----------|----------|-----------|
| localhost | ~2ms | ~0.4초 | ~2초 | ~4초 |
| 동일 네트워크 | ~10ms | ~2초 | ~10초 | ~20초 |
| 원격 (WAN) | ~50ms | ~10초 | ~50초 | ~100초 |

### 수 표현

- `gasUsed`, `gasLimit` 등 큰 정수값은 JSON 직렬화 시 **문자열**로 저장한다 (JavaScript Number 정밀도 한계 회피).
- 비율·평균값은 소수점 셋째 자리까지 반올림한다.

---

## 설정 (환경변수)

| 환경변수 | 설명 | 기본값 |
|---------|------|--------|
| `REPORT_DIR` | 결과 JSON 및 잡 상태 파일 저장 루트 경로 | `./reports` |
| `PERF_FETCH_CONCURRENCY` | 블록 수집 병렬 청크 크기 | `20` |
| `PERF_SYNC_MAX_BLOCK_RANGE` | `/perf/blocks` (동기) 최대 허용 블록 수 | `1000` |
| `PERF_ASYNC_MAX_BLOCK_RANGE` | `/perf/blocks/async` (비동기) 최대 허용 블록 수 | `10000` |

---

## 사용 예시

```bash
# 소규모 구간 — 동기 (결과 즉시 반환)
curl -X POST http://localhost:3000/perf/blocks \
  -H 'Content-Type: application/json' \
  -d '{"startBlock": 1000, "endBlock": 1999}'
# → ./reports/1000-1999.json, ./reports/1000-1999.html 생성

# 대규모 구간 — 비동기 (jobId 즉시 반환)
curl -X POST http://localhost:3000/perf/blocks/async \
  -H 'Content-Type: application/json' \
  -d '{"startBlock": 1000, "endBlock": 9999}'
# → {"jobId": "a1b2c3d4-...", "status": "pending", ...}

# 잡 상태 폴링
curl http://localhost:3000/perf/jobs/a1b2c3d4-...
# → status: "running" | "done" | "failed"

# 완료 후 결과 파일 확인
cat ./reports/1000-9999.json
open ./reports/1000-9999.html   # 브라우저에서 리포트 열기
```
