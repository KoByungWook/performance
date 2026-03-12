import { FastifyInstance } from 'fastify';
import { config } from '../config';

const startedAt = Date.now();

let txSent = 0;
let txFailed = 0;

export function incrementTxSent(): void {
  txSent++;
}

export function incrementTxFailed(): void {
  txFailed++;
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/status',
    {
      schema: {
        tags: ['Status'],
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
}
