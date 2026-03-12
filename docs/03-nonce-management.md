# 03. Nonce 관리 전략 (Nonce Management)

## 개요

Ethereum 트랜잭션의 nonce는 계정별 순차 번호로, 중복이나 gap이 발생하면 트랜잭션이 실패한다.
Redis를 이용한 분산 카운터로 pm2 다중 인스턴스 환경에서도 nonce 충돌 없이 원자적으로 관리한다.

## Redis Key 설계

```
nonce:{walletAddress}
예) nonce:0xfe3b557e8fb62b89f4916b721be55ceb828dbd73

nonce_gaps:{walletAddress}
예) nonce_gaps:0xfe3b557e8fb62b89f4916b721be55ceb828dbd73
```

| 키 패턴 | 타입 | 역할 |
|---------|------|------|
| `nonce:{address}` | String | 다음 할당할 nonce 카운터 |
| `nonce_gaps:{address}` | Sorted Set | 채번됐으나 전송 실패한 nonce 재활용 큐 (score = nonce 값) |

- `walletAddress`는 소문자로 정규화
- TTL: `NONCE_TTL_SECONDS` 환경변수로 설정 (기본 86400초 = 24시간)
- 각 요청마다 TTL이 갱신되므로, 활성 계정의 키는 만료되지 않음

## 처리 흐름

### 재활용 경로 (gap queue에 미사용 nonce 존재 시)

```
요청 → ZPOPMIN(nonce_gaps:{address}) → 가장 낮은 nonce 꺼냄 → 트랜잭션 서명/전송
```

네트워크 오류 등으로 전송에 실패했다가 반환된 nonce를 우선 재사용한다.
Sorted Set 구조이므로 여러 nonce가 쌓여도 항상 오름차순으로 소비된다.

### 빠른 경로 (gap 없음, 카운터 키 존재 시)

```
요청 → Redis INCR(nonce:{address}) → 이전 값 반환 → 트랜잭션 서명/전송
```

체인 조회 없이 Redis 1회 왕복으로 nonce 할당. 약 0.1~0.3ms.

### 초기화 경로 (키 없을 시)

```
요청 → Redis KEY 없음 확인 → eth_getTransactionCount(address, "pending")
     → Redis SET(nonce:{address}, chainNonce) → INCR → 트랜잭션 서명/전송
```

계정 첫 사용 또는 Redis 재시작 후 1회만 발생.

### 원자성 보장 (Lua 스크립트)

```lua
-- 빠른 경로: 키 존재 시 INCR 후 이전 값 반환
if redis.call('EXISTS', key) == 0 then return false end
if ttl > 0 then redis.call('EXPIRE', key, ttl) end
return redis.call('INCR', key) - 1

-- 초기화 경로: 키 없으면 chainNonce로 초기화 후 INCR
if redis.call('EXISTS', key) == 0 then redis.call('SET', key, chainNonce) end
if ttl > 0 then redis.call('EXPIRE', key, ttl) end
return redis.call('INCR', key) - 1
```

Redis의 단일 스레드 특성과 Lua 스크립트의 원자성으로 pm2 N개 인스턴스가 동시에 같은 주소로 요청해도 nonce 중복이 발생하지 않는다.

## 전송 실패 시 Nonce 반환 (Gap 방지)

nonce를 채번한 뒤 `eth_sendRawTransaction`이 네트워크 오류 등으로 실패하면, 해당 nonce는 Redis 카운터에서 이미 소비됐지만 블록체인에는 존재하지 않는 상태가 된다. 이 상태에서 다음 요청이 오면 더 높은 nonce를 받아 pending(gap)이 발생한다.

이를 방지하기 위해, 전송 실패 시 해당 nonce를 gap queue(`nonce_gaps:{address}`)에 반환한다.

```
nonce 채번 (Redis INCR)
  → eth_sendRawTransaction 실패 (네트워크 오류 등)
    → nonce too low? No
      → releaseNonce(address, nonce) → ZADD(nonce_gaps:{address}, nonce, nonce)
      → 에러 반환

다음 요청
  → ZPOPMIN(nonce_gaps:{address}) → 반환된 nonce 재사용 → pending 없이 정상 전송
```

`nonce too low` 에러는 체인이 이미 처리한 nonce이므로 gap queue에 반환하지 않는다. 대신 `syncNonce`가 호출되며, 이 과정에서 체인 nonce보다 낮은 stale gap 항목도 함께 정리된다.

## Nonce 불일치 자동 복구

트랜잭션 전송 시 `nonce too low` / `nonce already used` 에러가 발생하면:

```
에러 감지 → syncNonce(address) 호출
         → eth_getTransactionCount(address, "pending") → Redis 덮어씀
         → 체인 nonce 미만의 stale gap 항목 정리 (ZREMRANGEBYSCORE)
         → 1회 재시도
```

Redis 장애 후 재시작, 외부 지갑 사용 등으로 체인과 불일치가 생긴 경우 자동으로 복구된다.

## 기존 전략과 비교

| 항목 | 기존 (체인 직접 조회) | Redis 카운터 |
|------|----------------------|-------------|
| nonce 조회 비용 | 매 요청마다 RPC 1회 | 첫 사용 시만 RPC, 이후 Redis만 |
| 동시 요청 nonce 충돌 | 발생 가능 (Known transaction) | 없음 (Lua 원자적 INCR) |
| 인스턴스 간 공유 | 불가 (각자 체인 조회) | 가능 (Redis 공유) |
| 장애 복구 | 자동 (체인이 정답) | 자동 (에러 시 체인 재동기화) |
| 의존성 | 없음 | Redis 필요 |

## 설정

| 환경변수 | 설명 | 기본값 |
|---------|------|--------|
| REDIS_URL | Redis 접속 URL | redis://localhost:6379 |
| REDIS_USERNAME | Redis ACL 사용자 이름 (Redis 6+). 비어있으면 인증 생략 | (없음) |
| REDIS_PASSWORD | Redis 비밀번호. 비어있으면 인증 생략 | (없음) |
| NONCE_TTL_SECONDS | nonce 키 TTL (초). 0이면 만료 없음 | 86400 |
