import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { nonceService } from '../services/nonce.service';

const startedAt = Date.now();

let txSent = 0;
let txFailed = 0;

export function incrementTxSent(): void {
  txSent++;
}

export function incrementTxFailed(): void {
  txFailed++;
}

export async function manageRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────
  // GET /manage/status
  // ────────────────────────────────────────────────────────────
  app.get(
    '/status',
    {
      schema: {
        tags: ['Management'],
        summary: '인스턴스 처리 현황 조회',
        description: 'pm2 인스턴스별 uptime, 전송 성공/실패 카운터를 반환한다.',
        response: {
          200: {
            description: '인스턴스 상태',
            type: 'object',
            properties: {
              instanceId: { type: 'integer', description: 'pm2 인스턴스 ID' },
              uptime:     { type: 'string',  description: '서버 가동 시간 (예: "1h 23m 45s")' },
              txSent:     { type: 'integer', description: '이 인스턴스에서 처리한 전송 성공 건수' },
              txFailed:   { type: 'integer', description: '이 인스턴스에서 처리한 전송 실패 건수' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const uptimeMs = Date.now() - startedAt;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = uptimeSec % 60;
      const uptime = `${h}h ${m}m ${s}s`;

      return reply.status(200).send({
        instanceId: config.instanceId,
        uptime,
        txSent,
        txFailed,
      });
    },
  );

  // ────────────────────────────────────────────────────────────
  // DELETE /manage/nonce/:walletAddress
  // ────────────────────────────────────────────────────────────
  app.delete(
    '/nonce/:walletAddress',
    {
      schema: {
        tags: ['Management'],
        summary: '특정 주소의 nonce 초기화',
        description:
          'Redis에서 해당 주소의 nonce 카운터(`nonce:{address}`)와 gap 큐(`nonce_gaps:{address}`)를 삭제한다.\n' +
          '다음 트랜잭션 전송 시 체인에서 pending nonce를 재조회하여 자동 재초기화된다.',
        params: {
          type: 'object',
          required: ['walletAddress'],
          properties: {
            walletAddress: {
              type: 'string',
              description: '초기화할 지갑 주소 (0x로 시작하는 Ethereum 주소)',
            },
          },
        },
        response: {
          200: {
            description: '초기화 결과',
            type: 'object',
            properties: {
              walletAddress: { type: 'string', description: '초기화된 지갑 주소' },
              deletedKeys:   { type: 'integer', description: '삭제된 Redis 키 수 (0이면 해당 주소의 키가 없었음)' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { walletAddress } = request.params as { walletAddress: string };
      const deletedKeys = await nonceService.resetNonce(walletAddress);
      return reply.status(200).send({ walletAddress, deletedKeys });
    },
  );

  // ────────────────────────────────────────────────────────────
  // DELETE /manage/nonce
  // ────────────────────────────────────────────────────────────
  app.delete(
    '/nonce',
    {
      schema: {
        tags: ['Management'],
        summary: '전체 nonce 초기화',
        description:
          'Redis에서 모든 주소의 nonce 카운터(`nonce:*`)와 gap 큐(`nonce_gaps:*`)를 삭제한다.\n' +
          'SCAN으로 전수 조회 후 삭제하므로 키 수에 비례하여 시간이 걸릴 수 있다.\n' +
          '다음 트랜잭션 전송 시 각 주소별로 체인에서 pending nonce를 재조회하여 자동 재초기화된다.',
        response: {
          200: {
            description: '초기화 결과',
            type: 'object',
            properties: {
              deletedKeys: { type: 'integer', description: '삭제된 Redis 키 총 수' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const deletedKeys = await nonceService.resetAllNonces();
      return reply.status(200).send({ deletedKeys });
    },
  );
}
