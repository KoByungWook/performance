import { FastifyInstance } from 'fastify';
import { accountService } from '../services/account.service';

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const accountFileInfoSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', description: 'CSV 파일명 (account-{yymmddHHMMSS}.csv)' },
    rows:     { type: 'integer', description: '데이터 행 수 (헤더 제외)' },
    filePath: { type: 'string', description: '파일 절대 경로' },
  },
} as const;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // POST /accounts — 계정 데이터셋 생성 후 CSV 저장
  app.post<{ Body: { count: number } }>(
    '/',
    {
      schema: {
        tags: ['Accounts'],
        summary: '계정 데이터셋 생성',
        description: '지정한 수만큼 계정(walletAddress + privateKey)을 생성하고\n account-{yymmddHHMMSS}.csv 파일로 저장한다.',
        body: {
          type: 'object',
          required: ['count'],
          properties: {
            count: { type: 'integer', minimum: 1, description: '생성할 계정 수' },
          },
        },
        response: {
          200: {
            description: '생성 완료',
            type: 'object',
            properties: {
              filename: { type: 'string', description: '생성된 CSV 파일명' },
              count:    { type: 'integer', description: '생성된 계정 수' },
              filePath: { type: 'string', description: '파일 저장 경로' },
            },
          },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (request, reply) => {
      try {
        const { count } = request.body;
        const result = await accountService.createAccounts(count);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // GET /accounts — 저장된 CSV 파일 목록 및 행 수 조회
  app.get(
    '/',
    {
      schema: {
        tags: ['Accounts'],
        summary: '계정 파일 목록 조회',
        description: '데이터 디렉토리 내 account-*.csv 파일 목록과 각 파일의 행 수를 반환한다.',
        response: {
          200: {
            description: '파일 목록',
            type: 'object',
            properties: {
              totalFiles: { type: 'integer', description: '전체 파일 수' },
              files: {
                type: 'array',
                items: accountFileInfoSchema,
              },
            },
          },
          500: { description: '서버 오류', ...errorResponse },
        },
      },
    },
    async (_request, reply) => {
      try {
        const result = await accountService.listAccounts();
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // POST /accounts/create — 단건 계정 생성 (파일 저장 없음)
  app.post(
    '/create',
    {
      schema: {
        tags: ['Accounts'],
        summary: '단건 계정 생성',
        description: '계정 1건(walletAddress + privateKey)을 생성하여 반환한다.\n\n파일로 저장하지 않는다.',
        response: {
          200: {
            description: '생성된 계정',
            type: 'object',
            properties: {
              walletAddress: { type: 'string', description: 'Ethereum 주소' },
              privateKey:    { type: 'string', description: 'private key (0x 접두사 포함)' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const account = accountService.createSingle();
      return reply.status(200).send(account);
    },
  );
}
