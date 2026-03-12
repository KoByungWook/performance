# 05. pm2 기동 및 인스턴스 관리 (pm2 Deployment)

## ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'besu-loader',
    script: 'dist/app.js',
    instances: 4,
    exec_mode: 'cluster',
    instance_var: 'INSTANCE_ID',
    env: {
      PORT: 3000,
      BESU_RPC_URL: 'http://localhost:8545',
      ACCOUNT_DATA_DIR: './data',
      NODE_ENV: 'production'
    },
    env_development: {
      PORT: 3000,
      BESU_RPC_URL: 'http://localhost:8545',
      ACCOUNT_DATA_DIR: './data',
      NODE_ENV: 'development',
      instances: 1
    }
  }]
};
```

## 기동 명령어

```bash
# 빌드
npm run build

# 프로덕션 기동 (4 instances)
pm2 start ecosystem.config.js

# 개발 모드 (1 instance)
pm2 start ecosystem.config.js --env development

# 상태 확인
pm2 status

# 로그 확인
pm2 logs besu-loader

# 재기동
pm2 restart besu-loader

# 중지
pm2 stop besu-loader
```

## 포트 관리

pm2 cluster 모드에서는 모든 인스턴스가 동일 포트를 공유한다 (Node.js cluster 모듈 사용).

```
JMeter → :3000 → pm2 (round-robin) → instance 0~3
```

nonce는 Redis에서 원자적으로 할당하므로, 동일 `walletAddress` 요청이 서로 다른 인스턴스로 분산되어도 충돌이 없다.

## INSTANCE_ID

pm2의 `instance_var: 'INSTANCE_ID'` 설정에 의해 각 인스턴스에 0부터 시작하는 ID가 자동 주입된다. 로그 식별에 활용한다.

```typescript
// logger.ts
const instanceId = process.env.INSTANCE_ID || '0';
const prefix = `[instance-${instanceId}]`;
```

## 운영 시나리오

### 테스트 준비 (계정 생성)

계정 생성은 파일 쓰기가 필요하므로 단일 인스턴스로 수행하는 것을 권장한다.

```bash
# 1. 단일 인스턴스로 기동
pm2 start ecosystem.config.js --env development

# 2. sender / receiver 계정 생성
curl -X POST http://localhost:3000/accounts/senders \
  -H 'Content-Type: application/json' \
  -d '{"count": 20}'

curl -X POST http://localhost:3000/accounts/receivers \
  -H 'Content-Type: application/json' \
  -d '{"count": 200}'

# 3. 멀티 인스턴스로 재기동
pm2 stop besu-loader
pm2 start ecosystem.config.js
```

### 부하 유입

실제 부하 유입은 JMeter가 담당한다. JMeter는 `senders.csv`에서 계정 목록을 로드하여 `walletAddress`와 `privateKey`를 각 요청에 포함시킨다.

```bash
# 단건 컨트랙트 콜 (txHash 즉시 반환)
curl -X POST http://localhost:3000/tx/send \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xSenderAddress...",
    "privateKey": "0x...",
    "contractAddress": "0x1234...abcd",
    "abi": ["function transfer(address to, uint256 amount) returns (bool)"],
    "functionName": "transfer",
    "params": ["0xReceiverAddr...", "100"]
  }'

# 단건 컨트랙트 콜 (receipt 대기)
curl -X POST http://localhost:3000/tx/send-receipt \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xSenderAddress...",
    "privateKey": "0x...",
    "contractAddress": "0x1234...abcd",
    "abi": ["function transfer(address to, uint256 amount) returns (bool)"],
    "functionName": "transfer",
    "params": ["0xReceiverAddr...", "100"]
  }'

# 컨트랙트 배포
curl -X POST http://localhost:3000/tx/deploy \
  -H 'Content-Type: application/json' \
  -d '{
    "walletAddress": "0xDeployerAddress...",
    "privateKey": "0x...",
    "bytecode": "0x608060405234801561001057..."
  }'

# 상태 확인
curl http://localhost:3000/status
```

### 인스턴스 수 조정

```bash
# 8개로 스케일업
pm2 scale besu-loader 8

# 재기동
pm2 restart besu-loader
```

## 로그 설정

```javascript
// ecosystem.config.js에 추가 가능
{
  log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
  error_file: './logs/error.log',
  out_file: './logs/out.log',
  merge_logs: false   // 인스턴스별 로그 분리
}
```

## 모니터링

```bash
# 실시간 모니터링
pm2 monit

# 메트릭 확인
pm2 show besu-loader
```

`GET /status` 엔드포인트에서 인스턴스 상태를 반환한다:

```json
{
  "instanceId": 0,
  "uptime": "2h 15m",
  "txSent": 12500,
  "txFailed": 3
}
```
