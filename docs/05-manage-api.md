# 06. 관리 API (Management API)

## 개요

`/manage` 경로 하위에 인스턴스 운영에 필요한 관리 API를 제공한다.
현재 인스턴스 상태 조회, Redis nonce 초기화 기능이 포함된다.

---

## API 목록

| Method | Path | 설명 |
|--------|------|------|
| GET | /manage/status | 인스턴스 처리 현황 조회 |
| DELETE | /manage/nonce/:walletAddress | 특정 주소 nonce 초기화 |
| DELETE | /manage/nonce | 전체 nonce 초기화 |

---

## GET /manage/status

pm2 인스턴스별 가동 시간과 트랜잭션 처리 카운터를 반환한다.

### 응답

```json
{
  "instanceId": 0,
  "uptime": "1h 23m 45s",
  "txSent": 1024,
  "txFailed": 3
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| instanceId | integer | pm2 인스턴스 ID (`INSTANCE_ID` 환경변수) |
| uptime | string | 서버 가동 시간 |
| txSent | integer | 이 인스턴스에서 처리한 전송 성공 건수 |
| txFailed | integer | 이 인스턴스에서 처리한 전송 실패 건수 |

> pm2 다중 인스턴스 환경에서 각 인스턴스는 독립적인 카운터를 유지한다.
> 전체 처리량은 모든 인스턴스의 카운터를 합산해야 한다.

---

## DELETE /manage/nonce/:walletAddress

특정 지갑 주소의 Redis nonce 상태를 초기화한다.

삭제되는 키:
- `nonce:{walletAddress}` — nonce 카운터
- `nonce_gaps:{walletAddress}` — 전송 실패로 반환된 gap nonce 큐

초기화 후 해당 주소로 트랜잭션을 전송하면, 체인의 pending nonce를 재조회하여 Redis를 자동으로 재초기화한다.

### 파라미터

| 위치 | 이름 | 필수 | 설명 |
|------|------|------|------|
| path | walletAddress | ✓ | 초기화할 지갑 주소 (0x로 시작하는 Ethereum 주소) |

### 요청 예시

```
DELETE /manage/nonce/0xfe3b557e8fb62b89f4916b721be55ceb828dbd73
```

### 응답

```json
{
  "walletAddress": "0xfe3b557e8fb62b89f4916b721be55ceb828dbd73",
  "deletedKeys": 2
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| walletAddress | string | 초기화된 지갑 주소 |
| deletedKeys | integer | 삭제된 Redis 키 수. 0이면 해당 주소의 키가 없었음 |

### 사용 시나리오

- 외부 지갑(MetaMask 등)으로 직접 트랜잭션을 전송하여 체인 nonce가 Redis보다 앞서 나간 경우
- Redis 장애 후 재시작하여 카운터가 틀어진 경우
- 테스트 후 특정 계정의 nonce를 리셋하고 싶은 경우

> `nonce too low` 에러가 발생하면 자동으로 체인 재동기화(`syncNonce`)가 이뤄지므로,
> 대부분의 경우 수동 초기화 없이 자동 복구된다.
> 이 API는 강제 초기화가 필요한 경우에만 사용한다.

---

## DELETE /manage/nonce

Redis에 저장된 모든 주소의 nonce 상태를 초기화한다.

내부적으로 SCAN 명령으로 `nonce:*` 및 `nonce_gaps:*` 패턴의 키를 전수 조회하여 삭제한다.
키 수에 비례하여 처리 시간이 걸릴 수 있으나, SCAN은 블로킹 없이 점진적으로 실행된다.

### 요청 예시

```
DELETE /manage/nonce
```

### 응답

```json
{
  "deletedKeys": 42
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| deletedKeys | integer | 삭제된 Redis 키 총 수 |

### 사용 시나리오

- 부하 테스트를 새로 시작하기 전 모든 계정의 nonce를 초기화하는 경우
- Redis를 완전히 리셋하지 않고 nonce 관련 키만 정리하고 싶은 경우

> **주의**: 실행 중인 트랜잭션 전송 요청이 있는 상태에서 전체 초기화를 수행하면
> nonce 불일치가 발생할 수 있다. 부하 유입을 중단한 뒤 실행하는 것을 권장한다.
