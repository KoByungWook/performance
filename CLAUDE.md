# Besu Load Injector

Besu 네트워크에 컨트랙트 콜 부하를 유입하기 위한 API Gateway 애플리케이션.
벤치마크 기능 없이 순수 트랜잭션 생성/전송만 수행한다.

## 기술 스택

- **Runtime**: Node.js + TypeScript
- **Framework**: Fastify
- **Process Manager**: pm2 (multi-instance)
- **Blockchain**: ethers.js (Besu JSON-RPC 통신, ABI 인코딩, 로컬 서명)
- **Nonce 관리**: Redis (ioredis) — 분산 원자 카운터
- **Storage**: CSV 파일 기반 (계정 데이터)

## 프로젝트 구조

```
besu-load-injector/
├── CLAUDE.md                    # 이 파일
├── docs/
│   ├── 01-account-management.md  # 계정 생성/관리 상세
│   ├── 02-contract-call-api.md   # 컨트랙트 콜 유입 API 상세
│   ├── 03-nonce-management.md    # Nonce 관리 전략
│   ├── 04-block-performance.md   # 블록 구간 성능 추출
│   ├── 05-manage-api.md          # 운영 관리 API (상태 조회, nonce 초기화)
│   └── 06-pm2-deployment.md      # pm2 기동 및 인스턴스 관리
├── ecosystem.config.js
├── package.json
├── tsconfig.json
├── src/
│   ├── app.ts                   # Fastify 앱 엔트리포인트
│   ├── config.ts                # 환경변수 및 설정
│   ├── routes/
│   │   ├── account.routes.ts    # 계정 관리 API
│   │   ├── contract.routes.ts   # 컨트랙트 콜 유입 API
│   │   ├── manage.routes.ts     # 운영 관리 API (상태 조회, nonce 초기화)
│   │   └── perf.routes.ts       # 블록 성능 추출 API
│   ├── services/
│   │   ├── account.service.ts   # 계정 생성/조회 로직
│   │   ├── contract.service.ts  # 컨트랙트 콜 조립/전송 로직
│   │   ├── nonce.service.ts     # Nonce 관리
│   │   └── perf.service.ts      # 블록 수집 및 성능 통계 산출
│   ├── models/
│   │   ├── sender.model.ts      # 전송자 타입 (walletAddress + privateKey)
│   │   └── receiver.model.ts    # 수신자 타입 (address only)
│   └── utils/
│       ├── file-store.ts        # CSV 파일 읽기/쓰기/추가
│       └── logger.ts            # 로깅 유틸
├── contracts/                   # 컨트랙트 ABI 파일
│   └── ERC20.json               # ERC20 ABI (예시)
└── data/
    ├── senders.csv              # 전송자 계정 목록
    └── receivers.csv            # 수신자 계정 목록
```

## 핵심 아키텍처

### 전체 흐름

```
                    ┌─ Redis (nonce 원자 할당)
                    │
Client → Fastify (pm2 N instances) → Besu JSON-RPC
                    │
                    └─ 로컬 서명 (ethers.js)
```

### 계정 모델

**전송자 (Sender)**
```typescript
interface Sender {
  walletAddress: string;   // Ethereum 주소
  privateKey: string;      // 로컬 서명용 private key
}
```

**수신자 (Receiver)**
```typescript
interface Receiver {
  address: string;         // Ethereum 주소만 보유
}
```

### ETH 전송 모델

컨트랙트 없이 EOA → EOA 직접 ETH를 전송한다. `data` 필드는 비어있고 가스는 21000으로 고정된다.

```typescript
interface EthTransferRequest {
  walletAddress: string;   // 송신자 Ethereum 주소 (nonce 관리 키로 사용)
  privateKey: string;      // 서명에 사용할 private key
  toAddress: string;       // 수신자 Ethereum 주소
  value: string;           // 전송할 ETH 양 (ETH 단위, 예: "1.5")
}
```

`value`는 **ETH 단위** 문자열로 입력받고, 내부에서 Wei로 변환한다.
`ethers.parseEther("1.5")` → `1500000000000000000`

### 컨트랙트 콜 모델

여러 컨트랙트의 다양한 함수를 호출할 수 있다. 요청에 `walletAddress`와 `privateKey`를 포함하며, 앱은 전달받은 키로 로컬 서명한다.

```typescript
interface ContractCallRequest {
  walletAddress: string;             // 서명 주체 Ethereum 주소 (nonce 관리 키로 사용)
  privateKey: string;                // 서명에 사용할 private key
  contractAddress: string;           // 대상 컨트랙트 주소
  abi: object[];                     // 컨트랙트 ABI (또는 함수 fragment)
  functionName: string;              // 호출할 함수명
  params: any[];                     // 함수 파라미터
}
```

토큰 관련 amount는 **토큰 단위** (예: "100.5")로 입력받고, 내부에서 **decimals 18 기준으로 변환**한다.
`ethers.parseUnits("100.5", 18)` → `100500000000000000000`

### API 개요

| 구분 | Method | Path | 설명 |
|------|--------|------|------|
| 계정 | POST | /accounts/senders | 전송자 계정 생성 (로컬 키 생성) |
| 계정 | POST | /accounts/receivers | 수신자 계정 생성 |
| 계정 | GET | /accounts | 계정 현황 조회 |
| ETH 전송 | POST | /tx/transfer | ETH 단순 전송 (txHash 즉시 반환) |
| ETH 전송 | POST | /tx/transfer-receipt | ETH 단순 전송 (receipt 대기 후 반환) |
| 컨트랙트 | POST | /tx/deploy | 컨트랙트 배포 (receipt 확인 후 결과 반환, 실패 시 revert 메시지 포함) |
| 컨트랙트 | POST | /tx/call | 읽기 전용 컨트랙트 콜 (eth_call, 결과값 반환) |
| 컨트랙트 | POST | /tx/send | 단건 트랜잭션 전송 (txHash 즉시 반환) |
| 컨트랙트 | POST | /tx/send-receipt | 단건 트랜잭션 전송 (receipt 대기 후 반환) |
| 트랜잭션 | GET | /tx/receipt/:txHash | txHash로 receipt 조회 |
| 성능 | POST | /perf/blocks | 블록 구간 성능 지표 추출 — 동기 (소규모, 결과 즉시 반환) |
| 성능 | POST | /perf/blocks/async | 블록 구간 성능 지표 추출 — 비동기 (대규모, jobId 즉시 반환) |
| 성능 | GET | /perf/jobs/:jobId | 비동기 잡 상태 조회 |
| 상태 | GET | /status | 인스턴스 처리 현황 |

상세 스펙은 `docs/` 하위 문서 참조.

### 트랜잭션 처리 흐름

```
1. 요청에서 walletAddress + privateKey 수신
2. nonceService.allocateNonce(walletAddress) → nonce 원자적 할당
   ├─ gap queue에 미사용 nonce 있으면 우선 재사용 (ZPOPMIN)
   ├─ 카운터 키 존재 시 Redis INCR (체인 조회 없음)
   └─ 첫 사용 시 체인 pending nonce 조회 → Redis 초기화 후 INCR
3. ABI 인코딩 (contractAddress + functionName + params)
4. unsigned tx 조립 (to=contractAddress, data=encodedData, value=0x0)
5. ethers.Wallet(privateKey).signTransaction(unsignedTx) 로컬 서명
6. eth_sendRawTransaction 호출
   ├─ 성공 → txHash 반환
   ├─ nonce too low → Redis 재동기화 후 1회 자동 재시도
   └─ 기타 오류 → 채번된 nonce를 gap queue에 반환 후 에러 반환
```

### 설정 (환경변수)

| 변수 | 설명 | 기본값 |
|------|------|--------|
| PORT | 서버 포트 | 3000 |
| BESU_RPC_URL | Besu JSON-RPC 엔드포인트 | http://localhost:8545 |
| ACCOUNT_DATA_DIR | 계정 CSV 파일 경로 | ./data |
| INSTANCE_ID | pm2 자동 주입 인스턴스 ID | 0 |
| REDIS_URL | Redis 접속 URL | redis://localhost:6379 |
| REDIS_USERNAME | Redis ACL 사용자 이름 (Redis 6+). 비어있으면 인증 생략 | (없음) |
| REDIS_PASSWORD | Redis 비밀번호. 비어있으면 인증 생략 | (없음) |
| NONCE_TTL_SECONDS | nonce 키 TTL (초). 0이면 만료 없음 | 86400 |
| REPORT_DIR | 블록 성능 추출 결과 JSON 및 잡 상태 파일 저장 경로 | ./reports |
| PERF_FETCH_CONCURRENCY | 블록 수집 병렬 청크 크기 | 20 |
| PERF_SYNC_MAX_BLOCK_RANGE | /perf/blocks (동기) 최대 허용 블록 수 | 1000 |
| PERF_ASYNC_MAX_BLOCK_RANGE | /perf/blocks/async (비동기) 최대 허용 블록 수 | 10000 |

## 구현 원칙

1. **벤치마크 없음**: 성능 측정/보고 기능 포함하지 않음. 순수 API Gateway.
2. **다중 컨트랙트 지원**: 특정 ERC20에 고정하지 않음. 요청 시 컨트랙트 주소와 ABI를 지정.
3. **토큰 단위 사용**: amount는 사람이 읽는 토큰 단위로 입력, 내부에서 decimals 18 변환.
4. **파일 기반 저장**: 계정 데이터는 CSV 파일. DB 의존성 없음.
5. **외부 sender 주입**: sender 선택은 호출자(JMeter 등)가 담당. walletAddress와 privateKey를 요청에 포함하면 앱이 로컬 서명하여 전송.
6. **로컬 서명**: ethers.js로 로컬에서 트랜잭션 서명. 외부 서명 서비스 의존성 없음.
7. **Redis nonce 전략**: Redis INCR로 원자적 nonce 할당. pm2 다중 인스턴스 nonce 충돌 없음. 전송 실패 시 nonce를 gap queue에 반환해 다음 요청이 재사용(pending 방지). nonce 불일치 시 체인 재동기화 후 자동 재시도.
