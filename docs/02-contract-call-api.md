# 02. 컨트랙트 콜 API (Contract Call API)

## 개요

Besu 네트워크에 **ETH 전송 및 컨트랙트 콜** 부하를 유입하는 API.
ETH 직접 전송과 여러 컨트랙트의 다양한 함수 호출을 모두 지원한다.

| API | 방식 | 설명 |
|-----|------|------|
| `/tx/transfer` | `eth_sendRawTransaction` | EOA → EOA ETH 전송. txHash 즉시 반환. |
| `/tx/transfer-receipt` | `eth_sendRawTransaction` + 폴링 | EOA → EOA ETH 전송. receipt 대기 후 반환. |
| `/tx/call` | `eth_call` | 트랜잭션 없이 읽기 전용 함수 호출. 결과값 반환. |
| `/tx/send` | `eth_sendRawTransaction` | 컨트랙트 트랜잭션을 전송하고 txHash 즉시 반환. |
| `/tx/send-receipt` | `eth_sendRawTransaction` + 폴링 | 컨트랙트 트랜잭션을 전송하고 receipt 대기 후 반환. |
| `/tx/receipt/:txHash` | `eth_getTransactionReceipt` | txHash로 receipt 조회. |
| `/tx/deploy` | `eth_sendRawTransaction` + 폴링 | 컨트랙트 배포. receipt 확인 후 결과 반환. 실패 시 revert 메시지 포함. |

---

## ETH 전송 파이프라인 (`/tx/transfer`, `/tx/transfer-receipt`)

```
요청 수신 (walletAddress + privateKey + toAddress + value)
  → nonceService.allocateNonce(walletAddress) → nonce 원자 할당 (Redis)
      ├─ gap queue에 미사용 nonce 있으면 우선 재사용 (ZPOPMIN)
      ├─ 카운터 키 존재 시 INCR (체인 조회 없음)
      └─ 첫 사용 시 eth_getTransactionCount("pending") 로 초기화 후 INCR
  → unsigned tx 조립 (to=toAddress, value=parseEther(value), data='0x', gasLimit=21000)
  → ethers.Wallet(privateKey).signTransaction(unsignedTx) 로컬 서명
  → eth_sendRawTransaction
      ├─ 성공 → [/tx/transfer] txHash 즉시 반환
      │         [/tx/transfer-receipt] eth_getTransactionReceipt 폴링 → receipt 반환
      ├─ nonce too low → syncNonce 후 1회 재시도
      └─ 기타 오류 (네트워크 등) → releaseNonce(gap queue 반환) → 에러 반환
```

---

## 트랜잭션 전송 파이프라인 (`/tx/send`, `/tx/send-receipt`)

```
요청 수신 (walletAddress + privateKey + contractAddress + abi + functionName + params)
  → nonceService.allocateNonce(walletAddress) → nonce 원자 할당 (Redis)
      ├─ gap queue에 미사용 nonce 있으면 우선 재사용 (ZPOPMIN)
      ├─ 카운터 키 존재 시 INCR (체인 조회 없음)
      └─ 첫 사용 시 eth_getTransactionCount("pending") 로 초기화 후 INCR
  → ABI 인코딩 (ethers.Interface → encodeFunctionData)
  → unsigned tx 조립 (to=contractAddress, data=encodedData, value=0x0)
  → ethers.Wallet(privateKey).signTransaction(unsignedTx) 로컬 서명
  → eth_sendRawTransaction
      ├─ 성공 → [/tx/send] txHash 즉시 반환
      │         [/tx/send-receipt] eth_getTransactionReceipt 폴링 → receipt 반환
      ├─ nonce too low → syncNonce 후 1회 재시도
      └─ 기타 오류 (네트워크 등) → releaseNonce(gap queue 반환) → 에러 반환
```

---

## API 상세

### POST /tx/transfer

컨트랙트 없이 **EOA → EOA로 ETH를 전송**하고 txHash를 즉시 반환한다.
`data` 필드는 비어있고 gasLimit은 21000으로 고정된다.

**Request Body**
```json
{
  "walletAddress": "0xSenderAddress...",
  "privateKey": "0x...",
  "toAddress": "0xReceiverAddress...",
  "value": "1.5"
}
```

- `walletAddress`: 송신자 Ethereum 주소 (nonce 관리 키로 사용)
- `privateKey`: 서명에 사용할 private key
- `toAddress`: 수신자 Ethereum 주소
- `value`: 전송할 ETH 양. **ETH 단위** 문자열 (예: `"1.5"` = 1.5 ETH). 내부에서 Wei로 변환.

**Response 200**
```json
{
  "txHash": "0x...",
  "from": "0xSenderAddress...",
  "to": "0xReceiverAddress...",
  "value": "1.5",
  "nonce": 42
}
```

---

### POST /tx/transfer-receipt

컨트랙트 없이 **EOA → EOA로 ETH를 전송**하고 **receipt가 확인될 때까지 대기 후 반환**한다.

**Request Body**

`/tx/transfer`와 동일.

**Response 200**
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

- `status`: `1` = 성공, `0` = 실패

---

### POST /tx/call

트랜잭션을 생성하지 않고 **읽기 전용 함수를 호출**한다. `view` / `pure` 함수에 사용한다.
내부적으로 `eth_call`을 사용하므로 privateKey, nonce, 가스비 불필요.

**Request Body**
```json
{
  "walletAddress": "0xSenderAddress...",
  "contractAddress": "0x1234...abcd",
  "abi": ["function balanceOf(address account) view returns (uint256)"],
  "functionName": "balanceOf",
  "params": ["0xTargetAddress..."]
}
```

- `walletAddress`: `eth_call`의 `from` 주소 (선택). 결과값에는 영향 없음.
- `contractAddress`: 호출 대상 컨트랙트 주소
- `abi`: 컨트랙트 ABI 배열 (전체 ABI 또는 호출 함수의 human-readable fragment)
- `functionName`: 호출할 함수명 (`view` 또는 `pure`)
- `params`: 함수 파라미터 배열

**Response 200**
```json
{
  "contractAddress": "0x1234...abcd",
  "functionName": "balanceOf",
  "result": "1000000000000000000"
}
```

- `result`: ABI 디코딩된 반환값. 단일 값이면 문자열, 복수 값이면 배열.

---

### POST /tx/send

트랜잭션을 전송하고 **txHash만 반환**한다. receipt를 기다리지 않는다.

**Request Body**
```json
{
  "walletAddress": "0xSenderAddress...",
  "privateKey": "0x...",
  "contractAddress": "0x1234...abcd",
  "abi": ["function transfer(address to, uint256 amount) returns (bool)"],
  "functionName": "transfer",
  "params": ["0xReceiverAddress...", "100"]
}
```

- `walletAddress`: 서명 주체 Ethereum 주소 (nonce 관리 키로 사용)
- `privateKey`: 서명에 사용할 private key
- `contractAddress`: 호출 대상 컨트랙트 주소
- `abi`: 컨트랙트 ABI 배열 (전체 ABI 또는 호출 함수의 human-readable fragment)
- `functionName`: 호출할 함수명
- `params`: 함수 파라미터 배열. **토큰 amount는 토큰 단위** (예: "100" = 100 토큰)

**Response 200**
```json
{
  "txHash": "0x...",
  "from": "0x...",
  "contractAddress": "0x1234...abcd",
  "functionName": "transfer",
  "nonce": 42
}
```

---

### POST /tx/send-receipt

트랜잭션을 전송하고 **receipt가 확인될 때까지 대기 후 반환**한다.

**Request Body**

`/tx/send`와 동일.

**Response 200**
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

---

### GET /tx/receipt/:txHash

**txHash로 receipt를 조회**한다. 아직 채굴되지 않은 경우 404를 반환한다.

**Path Parameter**

- `txHash`: 조회할 트랜잭션 해시 (`0x`로 시작하는 64자리 hex)

**Response 200** (채굴 완료)
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

**Response 404** (아직 채굴되지 않음 또는 존재하지 않는 txHash)
```json
{
  "error": "receipt not found",
  "txHash": "0x..."
}
```

- `status`: `1` = 성공, `0` = revert
- `contractAddress`: 컨트랙트 배포 트랜잭션인 경우 배포된 주소, 일반 호출이면 `null`

---

### POST /tx/deploy

컨트랙트를 배포하고 **receipt가 확인될 때까지 대기 후 결과를 반환**한다.
배포 성공 여부와 실패 시 revert 메시지를 함께 제공한다.

**Request Body**
```json
{
  "walletAddress": "0xDeployerAddress...",
  "privateKey": "0x...",
  "bytecode": "0x608060405234801561001057...",
  "abi": ["constructor(address initialOwner, uint256 initialSupply)"],
  "constructorParams": ["0xOwnerAddress...", "1000000"],
  "tokenParamIndexes": [1]
}
```

- `walletAddress`: 배포자 Ethereum 주소
- `privateKey`: 서명에 사용할 private key
- `bytecode`: 배포할 컨트랙트의 컴파일된 bytecode (0x 접두)
- `abi`: *(선택)* 생성자 파라미터 인코딩용 ABI. 생성자가 없거나 인자가 없으면 생략 가능.
- `constructorParams`: *(선택)* 생성자 인자 배열. `abi` 없이 단독 사용 불가.
- `tokenParamIndexes`: *(선택)* `constructorParams` 중 토큰 단위로 변환할 인덱스 목록

**처리 흐름**
```
nonceService.allocateNonce(walletAddress) → nonce 원자 할당 (Redis)
  → [constructorParams 있는 경우] ABI 인코딩 후 bytecode 뒤에 append
  → unsigned tx 조립 (to: 없음, data: deployData, value: 0x0)
  → ethers.Wallet(privateKey).signTransaction(unsignedTx) 로컬 서명
  → eth_sendRawTransaction
      ├─ 성공 → eth_getTransactionReceipt 폴링 → receipt 확인
      │         [status=1] contractAddress + receipt 반환
      │         [status=0] eth_call 재실행으로 revert 메시지 추출 후 반환
      ├─ nonce too low → syncNonce 후 1회 재시도
      └─ 기타 오류 → releaseNonce(gap queue 반환) → 에러 반환
```

**Response 200 — 배포 성공**
```json
{
  "txHash": "0x...",
  "contractAddress": "0xDeployedAddress...",
  "from": "0x...",
  "nonce": 5,
  "receipt": {
    "blockNumber": 12345,
    "gasUsed": "500000",
    "status": 1
  }
}
```

**Response 200 — 배포 실패 (revert)**
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

- `contractAddress`: 배포 성공 시 실제 배포된 주소, 실패 시 `null`
- `receipt.status`: `1` = 성공, `0` = revert
- `receipt.revertReason`: revert 시에만 포함. 디코딩 형식:
  - `Error(string)` → 메시지 문자열 (예: `"Transfer amount exceeds balance"`)
  - `Panic(uint256)` → `"Panic(17)"` 형식 (예: `"Panic(1)"` = assert 실패)
  - Custom error → 원본 hex 데이터

---

## 파라미터 내 토큰 amount 처리

요청의 params에 포함된 토큰 amount는 **토큰 단위 문자열**로 전달한다.
내부에서 decimals 18 기준으로 변환한다.

```typescript
const tokenAmount = ethers.parseUnits("100", 18);
// → 100000000000000000000n (100 * 10^18)
```

요청 필드 `tokenParamIndexes`에 변환할 파라미터 인덱스를 명시하는 방식(방법 B)으로 구현되어 있다.
생략하거나 빈 배열이면 변환 없이 params를 그대로 사용한다.

## Unsigned TX 조립

```typescript
const iface = new ethers.Interface(abi);
const tokenAmount = ethers.parseUnits(amount, 18); // 토큰 단위 → 최소 단위 변환
const data = iface.encodeFunctionData(functionName, [receiverAddress, tokenAmount]);

interface UnsignedTx {
  to: string;           // contractAddress (컨트랙트 주소)
  value: '0x0';         // 컨트랙트 콜이므로 ETH 전송 없음
  nonce: number;        // 체인에서 조회한 pending nonce
  gasLimit: string;     // estimateGas 또는 고정값
  gasPrice: string;     // 설정값 또는 eth_gasPrice
  chainId: number;      // Besu 네트워크 chainId
  data: string;         // ABI 인코딩된 함수 호출 데이터
}
```

- `to`: **수신자가 아닌 컨트랙트 주소**
- `value`: `0x0` (컨트랙트 콜)
- `data`: ABI 인코딩된 함수 호출
- `gasLimit`: 함수에 따라 상이. 최초 estimateGas로 측정 후 여유분(20%) 포함한 고정값 사용 권장.

## 에러 처리

| 에러 상황 | 처리 방법 |
|-----------|-----------|
| ABI 인코딩 실패 | 즉시 400 에러 반환 (잘못된 ABI/params) |
| 서명 실패 | 500 에러 반환 |
| nonce too low / nonce already used | syncNonce로 Redis↔체인 재동기화 후 1회 재시도 |
| eth_sendRawTransaction 실패 (네트워크 등) | 채번된 nonce를 gap queue에 반환 후 500 에러 반환. 다음 요청 시 해당 nonce 재사용. |
| 컨트랙트 revert | receipt의 status=0으로 확인 (`/tx/send-receipt`, `/tx/deploy` 한정) |
| receipt 대기 타임아웃 | 설정된 시간 초과 시 504 에러 반환 (`/tx/send-receipt`, `/tx/deploy` 한정) |
| txHash 없음 / 미채굴 | 404 반환 (`/tx/receipt/:txHash`) |

## 설정값

| 항목 | 환경변수 | 기본값 |
|------|---------|--------|
| 가스 가격 | GAS_PRICE_WEI | 0 (free gas network) |
| 가스 한도 | GAS_LIMIT | 100000 |
| RPC 타임아웃 | RPC_TIMEOUT_MS | 5000 |
| Receipt 대기 타임아웃 | RECEIPT_TIMEOUT_MS | 30000 |
| Receipt 폴링 간격 | RECEIPT_POLL_MS | 500 |
| 토큰 decimals | TOKEN_DECIMALS | 18 |
