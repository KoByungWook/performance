# Besu Load Injector

Hyperledger Besu 네트워크에 ETH 전송 및 스마트 컨트랙트 콜 부하를 유입하기 위한 API Gateway 애플리케이션.

JMeter 등 외부 부하 도구와 연동하여 트랜잭션을 생성·서명·전송하고, 테스트 완료 후 블록 구간의 성능 지표(TPS, Mgas/s 등)를 추출한다.

## 목차

- [특징](#특징)
- [기술 스택](#기술-스택)
- [사전 요건](#사전-요건)
- [설치 및 실행](#설치-및-실행)
- [환경변수 설정](#환경변수-설정)
- [API 레퍼런스](#api-레퍼런스)
  - [계정 관리](#계정-관리)
  - [트랜잭션 전송](#트랜잭션-전송)
  - [성능 지표 추출](#성능-지표-추출)
  - [운영 관리](#운영-관리)
- [사용 흐름](#사용-흐름)
- [Nonce 관리 전략](#nonce-관리-전략)
- [프로젝트 구조](#프로젝트-구조)

---

## 특징

- **로컬 서명**: ethers.js로 로컬에서 트랜잭션 서명. 외부 서명 서비스 불필요
- **Redis Nonce 관리**: pm2 다중 인스턴스 환경에서 Lua 스크립트 기반 원자적 nonce 할당으로 충돌 없음
- **다중 컨트랙트 지원**: 특정 컨트랙트에 고정하지 않음. 요청마다 컨트랙트 주소와 ABI를 지정
- **외부 Sender 주입**: Sender 선택은 JMeter 등 호출자가 담당. `walletAddress`와 `privateKey`를 요청에 포함
- **자동 Nonce 복구**: `nonce too low` 에러 발생 시 체인 재동기화 후 자동 재시도
- **블록 성능 리포트**: 특정 블록 구간의 TPS, Mgas/s, 가스 사용률을 JSON·HTML 파일로 저장

---

## 기술 스택

| 항목 | 기술 |
|------|------|
| Runtime | Node.js >= 18 + TypeScript |
| Framework | Fastify |
| Process Manager | pm2 (cluster mode) |
| Blockchain | ethers.js v6 |
| Nonce 관리 | Redis (ioredis) |
| 계정 저장 | JSON 파일 |

---

## 사전 요건

- Node.js >= 18
- Redis >= 6
- Hyperledger Besu 노드 (JSON-RPC 접근 가능)
- pm2 (`npm install -g pm2`)

---

## 설치 및 실행

```bash
# 의존성 설치
npm install

# TypeScript 빌드
npm run build

# 개발 모드 기동 (인스턴스 1개)
npm run dev

# 프로덕션 기동 (인스턴스 4개, cluster mode)
npm start

# 빌드 후 재기동 (설정 변경 반영)
npm run reload

# 중지
npm run stop
```

### pm2 명령어

```bash
pm2 status              # 인스턴스 상태 확인
pm2 logs besu-loader    # 로그 확인
pm2 monit               # 실시간 모니터링
pm2 scale besu-loader 8 # 인스턴스 수 조정
```

---

## 환경변수 설정

`ecosystem.config.js`의 `env` 블록 또는 OS 환경변수로 설정한다.

### 필수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `BESU_RPC_URL` | Besu JSON-RPC 엔드포인트 | `http://localhost:8545` |
| `REDIS_URL` | Redis 접속 URL | `redis://localhost:6379` |

### 선택

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `PORT` | 서버 포트 | `3000` |
| `ACCOUNT_DATA_DIR` | 계정 JSON 파일 저장 경로 | `./data` |
| `REDIS_USERNAME` | Redis ACL 사용자 이름 (Redis 6+) | (없음) |
| `REDIS_PASSWORD` | Redis 비밀번호 | (없음) |
| `NONCE_TTL_SECONDS` | nonce 키 TTL (초). `0`이면 만료 없음 | `86400` |
| `GAS_PRICE_WEI` | 가스 가격 (Wei) | `0` |
| `GAS_LIMIT` | 가스 한도 | `100000` |
| `RPC_TIMEOUT_MS` | RPC 호출 타임아웃 (ms) | `5000` |
| `RECEIPT_TIMEOUT_MS` | Receipt 대기 타임아웃 (ms) | `30000` |
| `RECEIPT_POLL_MS` | Receipt 폴링 간격 (ms) | `500` |
| `TOKEN_DECIMALS` | 토큰 decimals | `18` |
| `REPORT_DIR` | 성능 리포트 저장 경로 | `./reports` |
| `PERF_FETCH_CONCURRENCY` | 블록 수집 병렬 청크 크기 | `20` |
| `PERF_SYNC_MAX_BLOCK_RANGE` | `/perf/blocks` 최대 허용 블록 수 | `1000` |
| `PERF_ASYNC_MAX_BLOCK_RANGE` | `/perf/blocks/async` 최대 허용 블록 수 | `10000` |

---

## API 레퍼런스

### 계정 관리

#### `POST /accounts/senders` — 전송자 계정 생성

ethers.js로 로컬에서 키 쌍을 생성하여 `senders.json`에 저장한다.

```bash
curl -X POST http://localhost:3000/accounts/senders \
  -H 'Content-Type: application/json' \
  -d '{"count": 20}'
```

```json
{ "created": 20 }
```

#### `POST /accounts/receivers` — 수신자 계정 생성

랜덤 Ethereum 주소를 생성하여 `receivers.json`에 저장한다. (private key 미저장)

```bash
curl -X POST http://localhost:3000/accounts/receivers \
  -H 'Content-Type: application/json' \
  -d '{"count": 200}'
```

```json
{ "created": 200 }
```

#### `GET /accounts` — 계정 현황 조회

```bash
curl http://localhost:3000/accounts
```

```json
{
  "senders": { "total": 20 },
  "receivers": { "total": 200 }
}
```

> **주의**: `senders.json`에 private key가 평문으로 저장된다. 파일 접근 권한을 반드시 관리할 것.
> 계정 생성은 단일 인스턴스 모드(`npm run dev`)에서 수행하는 것을 권장한다.

---

### 트랜잭션 전송

모든 전송 API는 요청에 `walletAddress`와 `privateKey`를 포함한다. 앱은 전달받은 키로 로컬 서명 후 Besu에 전송한다.

#### `POST /tx/transfer` — ETH 직접 전송 (txHash 즉시 반환)

EOA → EOA ETH 전송. `gasLimit=21000` 고정.

```bash
curl -X POST http://localhost:3000/tx/transfer \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xSenderAddress...",
    "privateKey": "0x...",
    "toAddress": "0xReceiverAddress...",
    "value": "1.5"
  }'
```

- `value`: ETH 단위 문자열 (예: `"1.5"` = 1.5 ETH)

```json
{
  "txHash": "0x...",
  "from": "0xSenderAddress...",
  "to": "0xReceiverAddress...",
  "value": "1.5",
  "nonce": 42
}
```

#### `POST /tx/transfer-receipt` — ETH 직접 전송 (receipt 대기)

요청 본문은 `/tx/transfer`와 동일. receipt가 확인될 때까지 대기 후 반환한다.

```json
{
  "txHash": "0x...",
  "from": "0xSenderAddress...",
  "to": "0xReceiverAddress...",
  "value": "1.5",
  "nonce": 42,
  "receipt": {
    "blockNumber": 12345,
    "gasUsed": "21000",
    "status": 1
  }
}
```

#### `POST /tx/call` — 읽기 전용 컨트랙트 콜

트랜잭션 없이 `eth_call`로 `view`/`pure` 함수를 호출한다.

```bash
curl -X POST http://localhost:3000/tx/call \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xSenderAddress...",
    "contractAddress": "0x1234...abcd",
    "abi": ["function balanceOf(address account) view returns (uint256)"],
    "functionName": "balanceOf",
    "params": ["0xTargetAddress..."]
  }'
```

```json
{
  "contractAddress": "0x1234...abcd",
  "functionName": "balanceOf",
  "result": "1000000000000000000"
}
```

#### `POST /tx/send` — 컨트랙트 트랜잭션 전송 (txHash 즉시 반환)

```bash
curl -X POST http://localhost:3000/tx/send \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xSenderAddress...",
    "privateKey": "0x...",
    "contractAddress": "0x1234...abcd",
    "abi": ["function transfer(address to, uint256 amount) returns (bool)"],
    "functionName": "transfer",
    "params": ["0xReceiverAddress...", "100"],
    "tokenParamIndexes": [1]
  }'
```

- `params`: 함수 파라미터 배열
- `tokenParamIndexes`: *(선택)* 토큰 단위(decimals 18)로 변환할 파라미터 인덱스. 위 예시에서 `[1]`이면 `"100"` → `100 * 10^18`으로 변환

```json
{
  "txHash": "0x...",
  "from": "0x...",
  "contractAddress": "0x1234...abcd",
  "functionName": "transfer",
  "nonce": 42
}
```

#### `POST /tx/send-receipt` — 컨트랙트 트랜잭션 전송 (receipt 대기)

요청 본문은 `/tx/send`와 동일. receipt가 확인될 때까지 대기 후 반환한다.

```json
{
  "txHash": "0x...",
  "from": "0x...",
  "contractAddress": "0x1234...abcd",
  "functionName": "transfer",
  "nonce": 42,
  "receipt": {
    "blockNumber": 12345,
    "gasUsed": "21000",
    "status": 1
  }
}
```

- `status`: `1` = 성공, `0` = revert

#### `GET /tx/receipt/:txHash` — Receipt 조회

```bash
curl http://localhost:3000/tx/receipt/0x...
```

**200 (채굴 완료)**
```json
{
  "txHash": "0x...",
  "blockNumber": 12345,
  "gasUsed": "21000",
  "status": 1,
  "contractAddress": null,
  "logs": []
}
```

**404 (미채굴 또는 존재하지 않음)**
```json
{ "error": "receipt not found", "txHash": "0x..." }
```

#### `POST /tx/deploy` — 컨트랙트 배포

배포 후 receipt를 확인하고, 실패 시 revert 메시지를 포함하여 반환한다.

```bash
curl -X POST http://localhost:3000/tx/deploy \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xDeployerAddress...",
    "privateKey": "0x...",
    "bytecode": "0x608060405234801561001057...",
    "abi": ["constructor(address initialOwner, uint256 initialSupply)"],
    "constructorParams": ["0xOwnerAddress...", "1000000"],
    "tokenParamIndexes": [1]
  }'
```

**성공**
```json
{
  "txHash": "0x...",
  "contractAddress": "0xDeployedAddress...",
  "from": "0x...",
  "nonce": 5,
  "receipt": { "blockNumber": 12345, "gasUsed": "500000", "status": 1 }
}
```

**실패 (revert)**
```json
{
  "txHash": "0x...",
  "contractAddress": null,
  "from": "0x...",
  "nonce": 5,
  "receipt": {
    "blockNumber": 12345,
    "gasUsed": "500000",
    "status": 0,
    "revertReason": "Ownable: caller is not the owner"
  }
}
```

---

### 성능 지표 추출

부하 테스트 완료 후 블록 구간의 TPS, Mgas/s, 가스 사용률 등을 추출한다.
결과는 JSON 데이터 파일과 HTML 리포트 파일로 저장된다.

#### `POST /perf/blocks` — 동기 추출 (최대 1,000블록)

요청 완료까지 대기 후 결과를 반환한다.

```bash
curl -X POST http://localhost:3000/perf/blocks \
  -H 'Content-Type: application/json' \
  -d '{"startBlock": 1000, "endBlock": 1999}'
```

```json
{
  "jsonFile": "./reports/1000-1999.json",
  "htmlFile": "./reports/1000-1999.html",
  "result": {
    "performance": { "TPS": 5.005, "Mgas/s": 1.051, "avgBlockTimeSeconds": 10.0 },
    "transactions": { "total": 50000 },
    "blocks": { "count": 1000, "elapsedSeconds": 9990 }
  }
}
```

#### `POST /perf/blocks/async` — 비동기 추출 (최대 10,000블록)

요청 즉시 `jobId`를 반환하고 백그라운드에서 처리한다.

```bash
curl -X POST http://localhost:3000/perf/blocks/async \
  -H 'Content-Type: application/json' \
  -d '{"startBlock": 1000, "endBlock": 9999}'
```

```json
{
  "jobId": "a1b2c3d4-...",
  "status": "pending",
  "jsonFile": "./reports/1000-9999.json",
  "htmlFile": "./reports/1000-9999.html"
}
```

#### `GET /perf/jobs/:jobId` — 비동기 잡 상태 조회

```bash
curl http://localhost:3000/perf/jobs/a1b2c3d4-...
```

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

`status` 값: `pending` → `running` → `done` / `failed`

---

### 운영 관리

#### `GET /manage/status` — 인스턴스 상태 조회

```bash
curl http://localhost:3000/manage/status
```

```json
{
  "instanceId": 0,
  "uptime": "1h 23m 45s",
  "txSent": 1024,
  "txFailed": 3
}
```

pm2 다중 인스턴스 환경에서 각 인스턴스는 독립적인 카운터를 유지한다.

#### `DELETE /manage/nonce/:walletAddress` — 특정 주소 Nonce 초기화

```bash
curl -X DELETE http://localhost:3000/manage/nonce/0xfe3b557e8fb62b89f4916b721be55ceb828dbd73
```

```json
{ "walletAddress": "0xfe3b...", "deletedKeys": 2 }
```

#### `DELETE /manage/nonce` — 전체 Nonce 초기화

모든 주소의 Redis nonce 키를 삭제한다. 부하 유입을 중단한 뒤 실행할 것.

```bash
curl -X DELETE http://localhost:3000/manage/nonce
```

```json
{ "deletedKeys": 42 }
```

---

## 사용 흐름

### 1단계: 계정 생성 (단일 인스턴스에서 수행)

```bash
# 개발 모드로 기동 (단일 인스턴스)
npm run dev

# 전송자 계정 20개, 수신자 계정 200개 생성
curl -X POST http://localhost:3000/accounts/senders \
  -H 'Content-Type: application/json' -d '{"count": 20}'

curl -X POST http://localhost:3000/accounts/receivers \
  -H 'Content-Type: application/json' -d '{"count": 200}'

# 서버 중지
npm run stop
```

### 2단계: 프로덕션 모드로 재기동

```bash
npm start
# → 인스턴스 4개 기동, 모두 :3000 포트 공유 (cluster mode)
```

### 3단계: JMeter로 부하 유입

JMeter는 `data/senders.json`에서 계정 목록을 읽어 `walletAddress`와 `privateKey`를 각 요청에 포함시킨다.

```
JMeter → POST /tx/send (또는 /tx/transfer)
       → pm2 round-robin → instance 0~3
       → Redis nonce 원자 할당
       → ethers.js 로컬 서명
       → Besu eth_sendRawTransaction
```

### 4단계: 성능 지표 추출

```bash
# 테스트 중 사용한 블록 구간 확인 후 성능 추출
curl -X POST http://localhost:3000/perf/blocks/async \
  -H 'Content-Type: application/json' \
  -d '{"startBlock": 5000, "endBlock": 14999}'

# 잡 완료 확인
curl http://localhost:3000/perf/jobs/<jobId>

# HTML 리포트 열기
open ./reports/5000-14999.html
```

---

## Nonce 관리 전략

pm2 다중 인스턴스 환경에서 동일 계정으로 동시 요청이 들어와도 nonce 충돌이 발생하지 않도록 Redis를 사용한다.

```
요청 수신
  ├─ gap queue (nonce_gaps:{address}) 에 재활용 nonce 있으면 ZPOPMIN으로 우선 소비
  ├─ Redis 카운터 키 존재 시 → INCR (체인 조회 없음, ~0.1ms)
  └─ 첫 사용 시 → eth_getTransactionCount("pending") 조회 후 Redis 초기화 → INCR

전송 실패 시
  └─ releaseNonce() → ZADD(nonce_gaps:{address}) → 다음 요청에서 재사용

nonce too low 에러 시
  └─ syncNonce() → 체인 nonce 재조회 → Redis 덮어쓰기 → 1회 자동 재시도
```

Redis 키 구조:
- `nonce:{address}` — 다음 할당할 nonce 카운터 (String)
- `nonce_gaps:{address}` — 전송 실패로 반환된 nonce 재활용 큐 (Sorted Set)

---

## 프로젝트 구조

```
besu-load-injector/
├── src/
│   ├── app.ts                   # Fastify 앱 엔트리포인트
│   ├── config.ts                # 환경변수 및 설정
│   ├── routes/
│   │   ├── account.routes.ts    # 계정 관리 API
│   │   ├── contract.routes.ts   # 트랜잭션 전송 API
│   │   ├── manage.routes.ts     # 운영 관리 API
│   │   └── perf.routes.ts       # 성능 추출 API
│   ├── services/
│   │   ├── account.service.ts   # 계정 생성/조회 로직
│   │   ├── contract.service.ts  # 트랜잭션 조립/전송 로직
│   │   ├── nonce.service.ts     # Redis Nonce 관리
│   │   └── perf.service.ts      # 블록 수집 및 통계 산출
│   ├── models/
│   │   ├── sender.model.ts      # Sender 타입
│   │   └── receiver.model.ts    # Receiver 타입
│   └── utils/
│       ├── file-store.ts        # JSON 파일 읽기/쓰기
│       └── logger.ts            # 로깅 유틸
├── data/
│   ├── senders.json             # 전송자 계정 목록 (자동 생성)
│   └── receivers.json           # 수신자 계정 목록 (자동 생성)
├── reports/                     # 성능 리포트 저장 (자동 생성)
├── docs/                        # 상세 문서
├── ecosystem.config.js          # pm2 설정
├── package.json
└── tsconfig.json
```

상세 스펙은 `docs/` 하위 문서를 참조한다.

| 문서 | 내용 |
|------|------|
| `docs/01-account-management.md` | 계정 생성/관리 |
| `docs/02-contract-call-api.md` | 트랜잭션 전송 API 상세 |
| `docs/03-nonce-management.md` | Nonce 관리 전략 |
| `docs/04-block-performance.md` | 블록 성능 추출 |
| `docs/05-pm2-deployment.md` | pm2 기동 및 인스턴스 관리 |
| `docs/06-manage-api.md` | 운영 관리 API |
