import { config } from '../config';
import { logger } from '../utils/logger';
import { nonceService } from './nonce.service';
import { signContractTx, ContractSendRequest } from './contract.service';

interface QueueEntry {
  signedTx: string;
  txHash: string;
  walletAddress: string;
  nonce: number;
}

const queue: QueueEntry[] = [];
let isFlushing = false;
let flushTimer: NodeJS.Timeout | null = null;

export function enqueue(entry: QueueEntry): boolean {
  if (queue.length >= config.batchQueueMax) {
    return false;
  }
  queue.push(entry);
  return true;
}

export function queueDepth(): number {
  return queue.length;
}

/**
 * JSON-RPC 배치 요청으로 signedTx 묶음을 전송한다.
 * 개별 tx 실패 시 해당 nonce를 gap queue에 반환한다.
 */
async function sendBatch(batch: QueueEntry[]): Promise<void> {
  const rpcBatch = batch.map((entry, i) => ({
    jsonrpc: '2.0',
    method: 'eth_sendRawTransaction',
    params: [entry.signedTx],
    id: i,
  }));

  let results: Array<{ id: number; result?: string; error?: { code: number; message: string } }>;

  try {
    const res = await fetch(config.besuRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcBatch),
    });
    results = (await res.json()) as typeof results;
  } catch (err) {
    // 네트워크 오류 — 배치 전체 nonce 반환
    logger.error(`Batch network error, releasing ${batch.length} nonces`, err);
    await Promise.all(batch.map((e) => nonceService.releaseNonce(e.walletAddress, e.nonce)));
    return;
  }

  let successCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const entry = batch[i];
    if (r.result) {
      successCount++;
    } else if (r.error) {
      logger.warn(`Batch tx failed nonce=${entry.nonce} from=${entry.walletAddress}: ${r.error.message}`);
      await nonceService.releaseNonce(entry.walletAddress, entry.nonce);
    }
  }

  if (successCount < batch.length) {
    logger.info(`Batch flush: ${successCount}/${batch.length} succeeded`);
  } else {
    logger.info(`Batch flush: ${batch.length} succeeded`);
  }
}

async function flush(): Promise<void> {
  if (isFlushing || queue.length === 0) return;
  isFlushing = true;

  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, config.batchSize);
      await sendBatch(batch);
    }
  } finally {
    isFlushing = false;
  }
}

export function startBatchWorker(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch((err) => logger.error('Batch flush error', err));
  }, config.batchFlushIntervalMs);
  logger.info(`Batch worker started: interval=${config.batchFlushIntervalMs}ms batchSize=${config.batchSize} queueMax=${config.batchQueueMax}`);
}

export function stopBatchWorker(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
    logger.info(`Batch worker stopped (queue depth at stop: ${queue.length})`);
  }
}

/**
 * 트랜잭션을 서명하고 큐에 적재한다.
 * 큐가 가득 찬 경우 nonce를 반환하고 queued=false를 반환한다.
 */
export async function signAndEnqueue(
  req: ContractSendRequest,
): Promise<{ txHash: string; queued: boolean; queueDepth: number }> {
  const entry = await signContractTx(req);

  const queued = enqueue({
    signedTx: entry.signedTx,
    txHash: entry.txHash,
    walletAddress: entry.walletAddress,
    nonce: entry.nonce,
  });

  if (!queued) {
    await nonceService.releaseNonce(entry.walletAddress, entry.nonce);
    return { txHash: entry.txHash, queued: false, queueDepth: queue.length };
  }

  return { txHash: entry.txHash, queued: true, queueDepth: queue.length };
}
