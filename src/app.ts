import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { logger } from './utils/logger';
import { nonceService } from './services/nonce.service';
import { accountRoutes } from './routes/account.routes';
import { contractRoutes } from './routes/contract.routes';
import { manageRoutes } from './routes/manage.routes';
import { perfRoutes } from './routes/perf.routes';

const app = Fastify({
  logger: false,
  ajv: {
    customOptions: {
      coerceTypes: false,
      allErrors: true,
    },
  },
});

// Content-Type 파싱
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

// Swagger — 라우트 등록 전에 먼저 등록해야 스키마 수집이 가능하다
app.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Besu Load Injector API',
      description: 'Besu 네트워크에 컨트랙트 콜 부하를 유입하기 위한 API Gateway.\n트랜잭션 생성/전송, 계정 관리, 블록 성능 추출 기능을 제공한다.',
      version: '1.0.0',
    },
    tags: [
      { name: 'Accounts',    description: '계정 생성 및 조회' },
      { name: 'Transaction', description: 'ETH 전송 및 컨트랙트 트랜잭션 전송' },
      { name: 'Performance', description: '블록 구간 성능 지표 추출' },
      { name: 'Management',  description: '인스턴스 상태 조회 및 운영 관리 (nonce 초기화 등)' },
    ],
  },
});

app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
  },
});

// 라우트 등록
app.register(accountRoutes, { prefix: '/accounts' });
app.register(contractRoutes, { prefix: '/tx' });
app.register(perfRoutes, { prefix: '/perf' });
app.register(manageRoutes, { prefix: '/manage' });

// 전역 에러 핸들러
app.setErrorHandler((error, _request, reply) => {
  logger.error(`Unhandled error: ${error.message}`);
  reply.status(error.statusCode ?? 500).send({
    error: error.message,
  });
});

// 서버 시작
const start = async () => {
  try {
    nonceService.initialize();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${config.port}`);
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

// Graceful shutdown: Redis 연결 종료
const shutdown = async () => {
  logger.info('Shutting down...');
  await nonceService.close();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
