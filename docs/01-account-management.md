# 01. 계정 관리 (Account Management)

## 개요

전송자(Sender)와 수신자(Receiver) 샘플 계정을 생성하고 관리한다.
계정 데이터는 `data/senders.json`, `data/receivers.json`에 저장된다.

## 데이터 모델

### Sender

```typescript
interface Sender {
  walletAddress: string;   // 0x 접두 Ethereum 주소 (체크섬)
  privateKey: string;      // 로컬 서명용 private key (0x 접두)
}
```

### Receiver

```typescript
interface Receiver {
  address: string;         // 0x 접두 Ethereum 주소
}
```

## API 상세

### POST /accounts/senders

전송자 계정을 N개 생성한다. ethers.js로 로컬에서 키 쌍을 생성하고, `walletAddress`와 `privateKey`를 저장한다.

**Request Body**
```json
{
  "count": 10
}
```

**처리 흐름**
1. `count`만큼 `ethers.Wallet.createRandom()` 호출
2. `wallet.address`, `wallet.privateKey` 추출
3. Sender 객체 생성 → `senders.json`에 append
4. 결과 반환

**Response 200**
```json
{
  "created": 10
}
```

**에러 처리**
- 중복 방지: walletAddress 기준 dedup

### POST /accounts/receivers

수신자 계정을 N개 생성한다. 랜덤 주소를 로컬에서 생성한다.

**Request Body**
```json
{
  "count": 100
}
```

**처리 흐름**
1. `count`만큼 랜덤 Ethereum 주소 생성 (ethers.Wallet.createRandom)
2. address만 추출하여 Receiver 객체 생성
3. `receivers.json`에 append
4. private key는 저장하지 않음 (수신 전용이므로 불필요)

**Response 200**
```json
{
  "created": 100
}
```

### GET /accounts

현재 저장된 계정 현황을 조회한다. **privateKey는 응답에 포함하지 않는다.**

**Response 200**
```json
{
  "senders": {
    "total": 10
  },
  "receivers": {
    "total": 100
  }
}
```

## 파일 저장소

- 경로: `${ACCOUNT_DATA_DIR}/senders.json`, `${ACCOUNT_DATA_DIR}/receivers.json`
- 형식: JSON 배열
- 동시 쓰기 보호: 계정 생성은 단일 인스턴스에서만 수행
- 앱 기동 시 파일 로드 → 메모리 캐시

## 주의사항

- 계정 생성 API는 부하 테스트 전 준비 단계에서 호출한다.
- pm2 multi-instance 상태에서 계정 생성 시 파일 충돌 가능 → **계정 생성은 단일 인스턴스(instance 0)에서만 처리**하거나, pm2 단일 모드로 기동 후 생성 권장.
- `senders.json`에 private key가 평문으로 저장된다. 파일 접근 권한 관리에 주의할 것.
- 수신자의 private key는 저장하지 않는다. 수신 전용이므로 주소만 있으면 충분하다.
