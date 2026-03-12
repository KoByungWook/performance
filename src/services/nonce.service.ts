import Redis from 'ioredis';
import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';

// ────────────────────────────────────────────────────────────
// Lua 스크립트
// ────────────────────────────────────────────────────────────

/**
 * 키가 존재하면 현재 nonce를 반환하고 +1 증가시킨다.
 * 키가 없으면 false(→ null)를 반환한다. (호출자가 체인에서 초기화해야 함)
 */
const TRY_ALLOC_SCRIPT = `
local key  = KEYS[1]
local ttl  = tonumber(ARGV[1])
if redis.call('EXISTS', key) == 0 then
  return false
end
if ttl > 0 then redis.call('EXPIRE', key, ttl) end
return redis.call('INCR', key) - 1
`;

/**
 * 키가 없으면 chainNonce로 초기화한 뒤, 현재 nonce를 반환하고 +1 증가시킨다.
 * 키가 이미 존재하면 (다른 인스턴스가 먼저 초기화) 그냥 INCR한다.
 */
const INIT_AND_ALLOC_SCRIPT = `
local key        = KEYS[1]
local chainNonce = tonumber(ARGV[1])
local ttl        = tonumber(ARGV[2])
if redis.call('EXISTS', key) == 0 then
  redis.call('SET', key, chainNonce)
end
if ttl > 0 then redis.call('EXPIRE', key, ttl) end
return redis.call('INCR', key) - 1
`;

// ────────────────────────────────────────────────────────────
// Redis 클라이언트 (싱글톤)
// ────────────────────────────────────────────────────────────
let redis: Redis;
const provider = new ethers.JsonRpcProvider(config.besuRpcUrl);

// ────────────────────────────────────────────────────────────
// 공개 인터페이스
// ────────────────────────────────────────────────────────────
export const nonceService = {
  /**
   * Redis 연결을 시작한다. app.ts 부팅 시 호출.
   */
  initialize(): void {
    redis = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      ...(config.redisUsername && { username: config.redisUsername }),
      ...(config.redisPassword && { password: config.redisPassword }),
    });
    redis.on('connect', () => logger.info('Redis connected'));
    redis.on('error', (err) => logger.error('Redis error', err));
  },

  /**
   * Redis 연결을 종료한다. graceful shutdown 시 호출.
   */
  async close(): Promise<void> {
    await redis.quit();
    logger.info('Redis disconnected');
  },

  /**
   * walletAddress에 대한 다음 nonce를 원자적으로 할당한다.
   *
   * - 재활용 경로: gap 큐에 미사용 nonce 존재 → 먼저 소비 (전송 실패로 반환된 nonce 재사용)
   * - 빠른 경로: Redis 키 존재 → Lua INCR, 체인 조회 없음
   * - 초기화 경로: 키 없음 → 체인에서 pending nonce 조회 → Redis 초기화 → Lua INCR
   *
   * @returns 이번 트랜잭션에 사용할 nonce
   */
  async allocateNonce(walletAddress: string): Promise<number> {
    const nonceKey = `nonce:${walletAddress.toLowerCase()}`;
    const gapKey   = `nonce_gaps:${walletAddress.toLowerCase()}`;
    const ttl      = config.nonceTtlSeconds;

    // 재활용 경로: 전송 실패로 gap 큐에 반환된 nonce가 있으면 먼저 소비
    // zpopmin: 스코어(= nonce 값) 오름차순으로 꺼내므로 항상 가장 낮은 nonce부터 재사용
    const popped = await redis.zpopmin(gapKey, 1);
    if (popped.length > 0) {
      const recycled = Number(popped[0]); // [member, score, ...] 형식
      logger.debug(`Recycled nonce from gap queue: ${walletAddress} nonce=${recycled}`);
      return recycled;
    }

    // 빠른 경로: 키가 이미 존재하면 체인 조회 없이 즉시 반환
    const fast = await redis.eval(TRY_ALLOC_SCRIPT, 1, nonceKey, String(ttl));
    if (fast !== null) {
      return Number(fast);
    }

    // 초기화 경로: 체인에서 pending nonce 조회 후 Redis 초기화
    const chainNonce = await provider.getTransactionCount(walletAddress, 'pending');
    const allocated = await redis.eval(
      INIT_AND_ALLOC_SCRIPT,
      1,
      nonceKey,
      String(chainNonce),
      String(ttl),
    );
    logger.debug(`Nonce initialized for ${walletAddress}: chain=${chainNonce}`);
    return Number(allocated);
  },

  /**
   * 할당됐지만 전송에 실패한 nonce를 gap 큐에 반환한다.
   * 다음 allocateNonce 호출 시 이 nonce를 우선 재사용하여 논스 스킵을 방지한다.
   *
   * Redis sorted set(nonce_gaps:{address})에 score=nonce로 저장하여
   * 여러 nonce가 쌓여도 항상 오름차순으로 소비된다.
   *
   * @param walletAddress 대상 지갑 주소
   * @param nonce        반환할 nonce 값
   */
  async releaseNonce(walletAddress: string, nonce: number): Promise<void> {
    const gapKey = `nonce_gaps:${walletAddress.toLowerCase()}`;
    await redis.zadd(gapKey, nonce, String(nonce));
    logger.warn(`Nonce released to gap queue: ${walletAddress} nonce=${nonce}`);
  },

  /**
   * 특정 주소의 nonce 카운터와 gap 큐를 Redis에서 삭제한다.
   * 다음 allocateNonce 호출 시 체인에서 재초기화된다.
   *
   * @param walletAddress 대상 지갑 주소
   * @returns 삭제된 키 수 (0이면 해당 주소의 키가 없었음)
   */
  async resetNonce(walletAddress: string): Promise<number> {
    const nonceKey = `nonce:${walletAddress.toLowerCase()}`;
    const gapKey   = `nonce_gaps:${walletAddress.toLowerCase()}`;
    const deleted = await redis.del(nonceKey, gapKey);
    logger.warn(`Nonce reset for ${walletAddress}: deleted ${deleted} keys`);
    return deleted;
  },

  /**
   * 모든 주소의 nonce 카운터와 gap 큐를 Redis에서 삭제한다.
   * SCAN으로 nonce:* / nonce_gaps:* 패턴의 키를 전수 조회하여 삭제한다.
   *
   * @returns 삭제된 총 키 수
   */
  async resetAllNonces(): Promise<number> {
    const patterns = ['nonce:*', 'nonce_gaps:*'];
    let totalDeleted = 0;

    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          const count = await redis.del(...keys);
          totalDeleted += count;
        }
      } while (cursor !== '0');
    }

    logger.warn(`All nonces reset: deleted ${totalDeleted} keys`);
    return totalDeleted;
  },

  /**
   * Redis의 nonce를 체인 pending nonce 기준으로 재동기화한다.
   * nonce 불일치 에러(nonce too low 등) 발생 시 자동으로 호출된다.
   *
   * 체인 nonce보다 낮은 stale gap nonce도 함께 정리한다.
   *
   * @returns 재동기화된 chain nonce
   */
  async syncNonce(walletAddress: string): Promise<number> {
    const nonceKey = `nonce:${walletAddress.toLowerCase()}`;
    const gapKey   = `nonce_gaps:${walletAddress.toLowerCase()}`;
    const chainNonce = await provider.getTransactionCount(walletAddress, 'pending');

    if (config.nonceTtlSeconds > 0) {
      await redis.set(nonceKey, String(chainNonce), 'EX', config.nonceTtlSeconds);
    } else {
      await redis.set(nonceKey, String(chainNonce));
    }

    // 체인이 이미 처리한 nonce(chainNonce 미만)는 gap 큐에서 제거
    // 이보다 낮은 값은 재전송해도 nonce too low가 발생하므로 정리
    if (chainNonce > 0) {
      await redis.zremrangebyscore(gapKey, '-inf', String(chainNonce - 1));
    }

    logger.warn(`Nonce resynced for ${walletAddress}: chain=${chainNonce}`);
    return chainNonce;
  },
};
