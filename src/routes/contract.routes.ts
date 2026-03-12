import { FastifyInstance } from 'fastify';
import {
  contractCall,
  sendContractTx,
  sendContractTxAndWait,
  deployContract,
  getReceipt,
  sendEthTransfer,
  sendEthTransferAndWait,
  ContractCallRequest,
  ContractSendRequest,
  DeployRequest,
  EthTransferRequest,
} from '../services/contract.service';
import { logger } from '../utils/logger';

// ── 공통 스키마 ──────────────────────────────────────────────────

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

/**
 * gasLimit 필드 스키마 (재사용)
 *
 * - integer : 해당 값을 그대로 gasLimit으로 사용 (고정값)
 * - "auto"  : eth_estimateGas 호출로 자동 추정
 * - 생략    : "auto"와 동일하게 동작
 */
const gasLimitField = {
  description: '가스 한도. integer = 고정값 사용, "auto" 또는 생략 = estimateGas 자동 추정',
  oneOf: [
    { type: 'integer', minimum: 1 },
    { type: 'string', enum: ['auto'] },
  ],
} as const;

const txReceiptSchema = {
  type: 'object',
  properties: {
    blockNumber: { type: 'integer' },
    gasUsed:     { type: 'string' },
    status:      { type: 'integer', enum: [0, 1], description: '1=성공, 0=revert' },
  },
} as const;

// ── 요청 Body 스키마 ─────────────────────────────────────────────

const ethTransferBodySchema = {
  type: 'object',
  required: ['walletAddress', 'privateKey', 'toAddress', 'value'],
  properties: {
    walletAddress: { type: 'string', description: '송신자 Ethereum 주소 (nonce 관리 키)' },
    privateKey:    { type: 'string', description: '서명에 사용할 private key (0x 접두사 포함)' },
    toAddress:     { type: 'string', description: '수신자 Ethereum 주소' },
    value:         { type: 'string', description: '전송할 ETH 양 (ETH 단위 문자열, 예: "1.5")' },
    gasLimit:      gasLimitField,
  },
} as const;

const contractCallBodySchema = {
  type: 'object',
  required: ['contractAddress', 'abi', 'functionName', 'params'],
  properties: {
    walletAddress:    { type: 'string', description: '(선택) eth_call의 from 필드에 사용할 주소' },
    contractAddress:  { type: 'string', description: '대상 컨트랙트 주소' },
    abi:              { type: 'array',  description: '컨트랙트 ABI 배열 (전체 또는 함수 fragment 문자열)', items: {} },
    functionName:     { type: 'string', description: '호출할 함수명' },
    params:           { type: 'array',  description: '함수 파라미터 배열', items: {} },
    tokenParamIndexes: {
      type: 'array',
      items: { type: 'integer' },
      description: '토큰 amount로 취급할 파라미터 인덱스. 해당 위치의 값을 decimals 18 기준으로 변환한다.',
    },
  },
} as const;

const contractSendBodySchema = {
  type: 'object',
  required: ['walletAddress', 'privateKey', 'contractAddress', 'abi', 'functionName', 'params'],
  properties: {
    walletAddress:   { type: 'string', description: '서명 주체 Ethereum 주소 (nonce 관리 키)' },
    privateKey:      { type: 'string', description: '서명에 사용할 private key (0x 접두사 포함)' },
    contractAddress: { type: 'string', description: '대상 컨트랙트 주소' },
    abi:             { type: 'array',  description: '컨트랙트 ABI 배열 (전체 또는 함수 fragment 문자열)', items: {} },
    functionName:    { type: 'string', description: '호출할 함수명' },
    params:          { type: 'array',  description: '함수 파라미터 배열', items: {} },
    tokenParamIndexes: {
      type: 'array',
      items: { type: 'integer' },
      description: '토큰 amount로 취급할 파라미터 인덱스. 해당 위치의 값(예: "100.5")을 decimals 18 기준 Wei로 변환한다.',
    },
    gasLimit: gasLimitField,
  },
} as const;

const deployBodySchema = {
  type: 'object',
  required: ['walletAddress', 'privateKey', 'bytecode'],
  properties: {
    walletAddress:    { type: 'string', description: '서명 주체 Ethereum 주소' },
    privateKey:       { type: 'string', description: '서명에 사용할 private key' },
    bytecode:         { type: 'string', description: '배포할 컨트랙트 bytecode (0x 접두사 포함)' },
    abi:              { type: 'array',  description: '(선택) 생성자 파라미터 인코딩에 필요한 ABI', items: {} },
    constructorParams: { type: 'array', description: '(선택) 생성자 파라미터 배열', items: {} },
    tokenParamIndexes: {
      type: 'array',
      items: { type: 'integer' },
      description: '토큰 amount로 취급할 생성자 파라미터 인덱스',
    },
    gasLimit: gasLimitField,
  },
} as const;

// ── 응답 스키마 ──────────────────────────────────────────────────

const ethTransferResultSchema = {
  type: 'object',
  properties: {
    txHash:   { type: 'string',  description: '전송된 트랜잭션 해시' },
    from:     { type: 'string' },
    to:       { type: 'string' },
    value:    { type: 'string',  description: '입력한 ETH 양 그대로' },
    nonce:    { type: 'integer' },
    gasLimit: { type: 'string',  description: '실제 사용된 gasLimit (추정 또는 고정값)' },
  },
} as const;

const sendResultSchema = {
  type: 'object',
  properties: {
    txHash:          { type: 'string',  description: '전송된 트랜잭션 해시' },
    from:            { type: 'string' },
    contractAddress: { type: 'string' },
    functionName:    { type: 'string' },
    nonce:           { type: 'integer' },
    gasLimit:        { type: 'string',  description: '실제 사용된 gasLimit (추정 또는 고정값)' },
  },
} as const;

export async function contractRoutes(app: FastifyInstance): Promise<void> {
  // POST /tx/transfer — ETH 단순 전송, txHash 즉시 반환
  app.post<{ Body: EthTransferRequest }>(
    '/transfer',
    {
      schema: {
        tags: ['Transaction'],
        summary: 'ETH 단순 전송 (txHash 즉시 반환)',
        description: 'EOA → EOA 직접 ETH 전송. data 필드 없음.\n\ngasLimit: integer(고정값) / "auto" 또는 생략(estimateGas 자동 추정).\n\n트랜잭션을 전송하고 txHash를 즉시 반환한다 (receipt 미대기).',
        body: ethTransferBodySchema,
        response: {
          200: { description: '전송 성공', ...ethTransferResultSchema },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await sendEthTransfer(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('sendEthTransfer failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /tx/transfer-receipt — ETH 단순 전송, receipt 대기 후 반환
  app.post<{ Body: EthTransferRequest }>(
    '/transfer-receipt',
    {
      schema: {
        tags: ['Transaction'],
        summary: 'ETH 단순 전송 (receipt 대기 후 반환)',
        description: 'EOA → EOA 직접 ETH 전송. \n\n트랜잭션이 블록에 포함될 때까지 대기한 후 receipt를 포함해 반환한다.',
        body: ethTransferBodySchema,
        response: {
          200: {
            description: '전송 및 채굴 완료',
            type: 'object',
            properties: {
              ...ethTransferResultSchema.properties,
              receipt: { description: '트랜잭션 영수증', ...txReceiptSchema },
            },
          },
          504: { description: 'Receipt 대기 타임아웃', ...errorResponse },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await sendEthTransferAndWait(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('sendEthTransferAndWait failed', err);
        const message = String(err);
        const status = message.includes('timeout') ? 504 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // POST /tx/call — 읽기 전용 컨트랙트 콜 (eth_call)
  app.post<{ Body: ContractCallRequest }>(
    '/call',
    {
      schema: {
        tags: ['Transaction'],
        summary: '읽기 전용 컨트랙트 콜 (eth_call)',
        description: 'view/pure 함수를 호출한다. \n\n트랜잭션을 생성하지 않으며 결과값을 즉시 반환한다.',
        body: contractCallBodySchema,
        response: {
          200: {
            description: '콜 결과',
            type: 'object',
            properties: {
              contractAddress: { type: 'string' },
              functionName:    { type: 'string' },
              result:          { description: '단일 반환값은 string, 복수 반환값은 string 배열' },
            },
          },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await contractCall(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('contractCall failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /tx/send — 트랜잭션 전송, txHash 즉시 반환
  app.post<{ Body: ContractSendRequest }>(
    '/send',
    {
      schema: {
        tags: ['Transaction'],
        summary: '컨트랙트 트랜잭션 전송 (txHash 즉시 반환)',
        description: '상태를 변경하는 컨트랙트 함수를 호출하는 트랜잭션을 전송한다.\n\ntxHash를 즉시 반환하며 receipt를 기다리지 않는다.\n\n- Redis INCR으로 nonce를 원자적으로 할당한다.\n\n- nonce too low 에러 발생 시 체인과 재동기화 후 1회 자동 재시도한다.\n\n- 전송 실패 시 할당된 nonce를 gap queue에 반환한다.',
        body: contractSendBodySchema,
        response: {
          200: { description: '전송 성공', ...sendResultSchema },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await sendContractTx(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('sendContractTx failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /tx/send-receipt — 트랜잭션 전송, receipt 대기 후 반환
  app.post<{ Body: ContractSendRequest }>(
    '/send-receipt',
    {
      schema: {
        tags: ['Transaction'],
        summary: '컨트랙트 트랜잭션 전송 (receipt 대기 후 반환)',
        description: '상태를 변경하는 컨트랙트 함수를 호출하는 트랜잭션을 전송하고,\n\n블록에 포함될 때까지 대기한 후 receipt를 포함해 반환한다.',
        body: contractSendBodySchema,
        response: {
          200: {
            description: '전송 및 채굴 완료',
            type: 'object',
            properties: {
              ...sendResultSchema.properties,
              receipt: { description: '트랜잭션 영수증', ...txReceiptSchema },
            },
          },
          504: { description: 'Receipt 대기 타임아웃', ...errorResponse },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await sendContractTxAndWait(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('sendContractTxAndWait failed', err);
        const message = String(err);
        const status = message.includes('timeout') ? 504 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // GET /tx/receipt/:txHash — txHash로 receipt 조회
  app.get<{ Params: { txHash: string } }>(
    '/receipt/:txHash',
    {
      schema: {
        tags: ['Transaction'],
        summary: 'txHash로 receipt 조회',
        description: '전송된 트랜잭션의 receipt를 조회한다. \n\n아직 채굴되지 않은 경우 404를 반환한다.',
        params: {
          type: 'object',
          properties: {
            txHash: { type: 'string', description: '조회할 트랜잭션 해시 (0x 접두사 포함)' },
          },
        },
        response: {
          200: {
            description: 'Receipt 조회 성공',
            type: 'object',
            properties: {
              txHash:          { type: 'string' },
              blockNumber:     { type: 'integer' },
              gasUsed:         { type: 'string' },
              status:          { type: 'integer', enum: [0, 1] },
              contractAddress: { type: 'string', nullable: true, description: '컨트랙트 배포 tx인 경우 배포 주소, 그 외 null' },
              logs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    topics:  { type: 'array', items: { type: 'string' } },
                    data:    { type: 'string' },
                  },
                },
              },
            },
          },
          404: {
            description: '아직 채굴되지 않았거나 존재하지 않는 txHash',
            type: 'object',
            properties: {
              error:  { type: 'string' },
              txHash: { type: 'string' },
            },
          },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      const { txHash } = request.params;
      try {
        const result = await getReceipt(txHash);
        if (!result) {
          return reply.status(404).send({ error: 'receipt not found', txHash });
        }
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('getReceipt failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /tx/deploy — 컨트랙트 배포 (receipt 확인 후 반환)
  app.post<{ Body: DeployRequest }>(
    '/deploy',
    {
      schema: {
        tags: ['Transaction'],
        summary: '컨트랙트 배포',
        description: '컨트랙트 bytecode를 배포하고 receipt를 대기한 후 결과를 반환한다.\n\n배포가 revert된 경우 revertReason을 포함해 반환한다.',
        body: deployBodySchema,
        response: {
          200: {
            description: '배포 완료 (revert 포함)',
            type: 'object',
            properties: {
              txHash:          { type: 'string' },
              contractAddress: { type: 'string', nullable: true, description: '배포된 컨트랙트 주소 (revert 시 null)' },
              from:            { type: 'string' },
              nonce:           { type: 'integer' },
              gasLimit:        { type: 'string', description: '실제 사용된 gasLimit (추정 또는 고정값)' },
              receipt: {
                type: 'object',
                properties: {
                  blockNumber:  { type: 'integer' },
                  gasUsed:      { type: 'string' },
                  status:       { type: 'integer', enum: [0, 1] },
                  revertReason: { type: 'string', nullable: true, description: 'revert된 경우 에러 메시지' },
                },
              },
            },
          },
          504: { description: 'Receipt 대기 타임아웃', ...errorResponse },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await deployContract(request.body);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('deployContract failed', err);
        const message = String(err);
        const status = message.includes('timeout') ? 504 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );
}
