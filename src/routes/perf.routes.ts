import { FastifyInstance } from 'fastify';
import {
  extractSync,
  extractAsync,
  getJob,
  validateRange,
} from '../services/perf.service';
import { config } from '../config';
import { logger } from '../utils/logger';

const blockRangeBodySchema = {
  type: 'object',
  required: ['startBlock', 'endBlock'],
  properties: {
    startBlock: { type: 'integer', minimum: 0, description: '시작 블록 번호 (포함)' },
    endBlock:   { type: 'integer', minimum: 0, description: '종료 블록 번호 (포함)' },
  },
} as const;

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const perfResultSchema = {
  type: 'object',
  properties: {
    meta: {
      type: 'object',
      properties: {
        startBlock:  { type: 'integer' },
        endBlock:    { type: 'integer' },
        generatedAt: { type: 'string', format: 'date-time' },
      },
    },
    blocks: {
      type: 'object',
      properties: {
        count:               { type: 'integer' },
        firstTimestamp:      { type: 'integer', description: 'Unix timestamp (초)' },
        lastTimestamp:       { type: 'integer' },
        elapsedSeconds:      { type: 'integer' },
        avgBlockTimeSeconds: { type: 'number',  nullable: true },
      },
    },
    transactions: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        perBlock: {
          type: 'object',
          properties: {
            avg:    { type: 'number' },
            min:    { type: 'integer' },
            max:    { type: 'integer' },
            stddev: { type: 'number' },
          },
        },
      },
    },
    gas: {
      type: 'object',
      properties: {
        totalUsed: { type: 'string', description: '전체 소비 가스 (big int 문자열)' },
        limit:     { type: 'string', description: '평균 블록 가스 한도' },
        perBlock: {
          type: 'object',
          properties: {
            avg: { type: 'string' },
            min: { type: 'string' },
            max: { type: 'string' },
          },
        },
        perTx: {
          type: 'object',
          properties: {
            avg: { type: 'string', nullable: true },
          },
        },
        utilization: {
          type: 'object',
          properties: {
            avg: { type: 'number', description: '평균 가스 사용률 (%)' },
            min: { type: 'number' },
            max: { type: 'number' },
          },
        },
      },
    },
    performance: {
      type: 'object',
      properties: {
        TPS:                 { type: 'number', nullable: true, description: '초당 트랜잭션 수' },
        'Mgas/s':            { type: 'number', nullable: true, description: '초당 처리 가스량 (Mega gas)' },
        avgBlockTimeSeconds: { type: 'number', nullable: true },
      },
    },
  },
} as const;

const jobStateSchema = {
  type: 'object',
  properties: {
    jobId:       { type: 'string', format: 'uuid' },
    status:      { type: 'string', enum: ['pending', 'running', 'done', 'failed'], description: 'pending→running→done|failed' },
    startBlock:  { type: 'integer' },
    endBlock:    { type: 'integer' },
    jsonFile:    { type: 'string' },
    htmlFile:    { type: 'string' },
    startedAt:   { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', nullable: true, format: 'date-time' },
    error:       { type: 'string', nullable: true, description: '실패 시 에러 메시지' },
  },
} as const;

export async function perfRoutes(app: FastifyInstance): Promise<void> {
  // POST /perf/blocks — 동기 추출 (소규모 구간)
  app.post<{ Body: { startBlock: number; endBlock: number } }>(
    '/blocks',
    {
      schema: {
        tags: ['Performance'],
        summary: '블록 구간 성능 추출 (동기)',
        description: `지정한 블록 구간의 TPS, Mgas/s, 블록 통계 등을 즉시 계산해 반환한다.\n\n- 최대 허용 블록 수: PERF_SYNC_MAX_BLOCK_RANGE (기본 ${config.perfSyncMaxBlockRange})\n- 결과는 JSON 및 HTML 파일로 REPORT_DIR에 저장된다.`,
        body: blockRangeBodySchema,
        response: {
          200: {
            description: '성능 지표 추출 완료',
            type: 'object',
            properties: {
              jsonFile: { type: 'string', description: '저장된 JSON 리포트 파일 경로' },
              htmlFile: { type: 'string', description: '저장된 HTML 리포트 파일 경로' },
              result:   perfResultSchema,
            },
          },
          400: { description: '잘못된 블록 범위 (startBlock > endBlock, 최대 범위 초과, 미래 블록 등)', ...errorResponse },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      const { startBlock, endBlock } = request.body;

      const validation = await validateRange(startBlock, endBlock, config.perfSyncMaxBlockRange);
      if (!validation.valid) {
        return reply.status(validation.status).send({ error: validation.message });
      }

      try {
        const result = await extractSync(startBlock, endBlock);
        return reply.status(200).send(result);
      } catch (err) {
        logger.error('extractSync failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /perf/blocks/async — 비동기 추출 (대규모 구간)
  app.post<{ Body: { startBlock: number; endBlock: number } }>(
    '/blocks/async',
    {
      schema: {
        tags: ['Performance'],
        summary: '블록 구간 성능 추출 (비동기)',
        description: `지정한 블록 구간의 성능 지표를 백그라운드에서 추출한다.\n\njobId를 즉시 반환하며 /perf/jobs/{jobId} 로 진행 상황을 조회한다.\n\n- 최대 허용 블록 수: PERF_ASYNC_MAX_BLOCK_RANGE (기본 ${config.perfAsyncMaxBlockRange})`,
        body: blockRangeBodySchema,
        response: {
          202: {
            description: '잡 생성 완료 (백그라운드 처리 시작)',
            type: 'object',
            properties: {
              jobId:   { type: 'string', format: 'uuid', description: '잡 추적에 사용할 UUID' },
              status:  { type: 'string', enum: ['pending'] },
              jsonFile: { type: 'string' },
              htmlFile: { type: 'string' },
            },
          },
          400: { description: '잘못된 블록 범위', ...errorResponse },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      const { startBlock, endBlock } = request.body;

      const validation = await validateRange(startBlock, endBlock, config.perfAsyncMaxBlockRange);
      if (!validation.valid) {
        return reply.status(validation.status).send({ error: validation.message });
      }

      try {
        const { jobId, jsonFile, htmlFile } = await extractAsync(startBlock, endBlock);
        return reply.status(202).send({ jobId, status: 'pending', jsonFile, htmlFile });
      } catch (err) {
        logger.error('extractAsync failed', err);
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // GET /perf/jobs/:jobId — 비동기 잡 상태 조회
  app.get<{ Params: { jobId: string } }>(
    '/jobs/:jobId',
    {
      schema: {
        tags: ['Performance'],
        summary: '비동기 잡 상태 조회',
        description: '/perf/blocks/async 로 생성된 잡의 현재 상태를 조회한다.\n\nstatus가 done이면 jsonFile/htmlFile을 사용할 수 있다.',
        params: {
          type: 'object',
          properties: {
            jobId: { type: 'string', format: 'uuid', description: '잡 UUID' },
          },
        },
        response: {
          200: { description: '잡 상태', ...jobStateSchema },
          404: {
            description: '잡을 찾을 수 없음',
            type: 'object',
            properties: {
              error: { type: 'string' },
              jobId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { jobId } = request.params;
      const job = await getJob(jobId);
      if (!job) {
        return reply.status(404).send({ error: 'job not found', jobId });
      }
      return reply.status(200).send(job);
    },
  );
}
