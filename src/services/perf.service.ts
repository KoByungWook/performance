import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../utils/logger';

const provider = new ethers.JsonRpcProvider(config.besuRpcUrl);

// ────────────────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────────────────

export interface PerfResult {
  meta: {
    startBlock: number;
    endBlock: number;
    generatedAt: string;
  };
  blocks: {
    count: number;
    firstTimestamp: number;
    lastTimestamp: number;
    elapsedSeconds: number;
    avgBlockTimeSeconds: number | null;
  };
  transactions: {
    total: number;
    perBlock: {
      avg: number;
      min: number;
      max: number;
      stddev: number;
    };
  };
  gas: {
    totalUsed: string;
    limit: string;
    perBlock: {
      avg: string;
      min: string;
      max: string;
    };
    perTx: {
      avg: string | null;
    };
    utilization: {
      avg: number;
      min: number;
      max: number;
    };
  };
  performance: {
    TPS: number | null;
    'Mgas/s': number | null;
    avgBlockTimeSeconds: number | null;
  };
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobState {
  jobId: string;
  status: JobStatus;
  startBlock: number;
  endBlock: number;
  jsonFile: string;
  htmlFile: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

// ────────────────────────────────────────────────────────────
// 유효성 검사
// ────────────────────────────────────────────────────────────

export async function validateRange(
  startBlock: number,
  endBlock: number,
  maxRange: number,
): Promise<{ valid: true } | { valid: false; status: 400; message: string }> {
  if (startBlock > endBlock) {
    return { valid: false, status: 400, message: 'startBlock must be ≤ endBlock' };
  }

  const range = endBlock - startBlock + 1;
  if (range > maxRange) {
    return {
      valid: false,
      status: 400,
      message: `Range ${range} exceeds limit ${maxRange}`,
    };
  }

  const latestHex: string = await provider.send('eth_blockNumber', []);
  const latestBlock = parseInt(latestHex, 16);
  if (endBlock > latestBlock) {
    return {
      valid: false,
      status: 400,
      message: `endBlock ${endBlock} exceeds latest block ${latestBlock}`,
    };
  }

  return { valid: true };
}

// ────────────────────────────────────────────────────────────
// 블록 수집
// ────────────────────────────────────────────────────────────

interface RawBlock {
  number: number;
  timestamp: number;
  txCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
}

async function fetchBlocks(startBlock: number, endBlock: number): Promise<RawBlock[]> {
  const blockNumbers = Array.from(
    { length: endBlock - startBlock + 1 },
    (_, i) => startBlock + i,
  );

  const results: RawBlock[] = [];

  for (let i = 0; i < blockNumbers.length; i += config.perfFetchConcurrency) {
    const chunk = blockNumbers.slice(i, i + config.perfFetchConcurrency);
    const blocks = await Promise.all(
      chunk.map(async (n) => {
        const block = await provider.getBlock(n);
        if (!block) throw new Error(`Block ${n} not found`);
        return {
          number: block.number,
          timestamp: block.timestamp,
          txCount: block.transactions.length,
          gasUsed: block.gasUsed,
          gasLimit: block.gasLimit,
        };
      }),
    );
    results.push(...blocks);
  }

  return results;
}

// ────────────────────────────────────────────────────────────
// 통계 산출
// ────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function computeStats(blocks: RawBlock[], startBlock: number, endBlock: number): PerfResult {
  const count = blocks.length;
  const firstTimestamp = blocks[0].timestamp;
  const lastTimestamp = blocks[count - 1].timestamp;
  const elapsedSeconds = lastTimestamp - firstTimestamp;
  const avgBlockTimeSeconds = count > 1 ? round3(elapsedSeconds / (count - 1)) : null;

  // 트랜잭션
  const txCounts = blocks.map((b) => b.txCount);
  const totalTx = txCounts.reduce((a, b) => a + b, 0);
  const avgTxExact = totalTx / count;
  const avgTx = round3(avgTxExact);
  const minTx = Math.min(...txCounts);
  const maxTx = Math.max(...txCounts);
  const stddevTx = round3(
    Math.sqrt(txCounts.reduce((a, b) => a + Math.pow(b - avgTxExact, 2), 0) / count),
  );

  // 가스
  const totalGasUsed = blocks.reduce((a, b) => a + b.gasUsed, 0n);
  const avgGasPerBlock = totalGasUsed / BigInt(count);
  const avgGasLimit = blocks.reduce((a, b) => a + b.gasLimit, 0n) / BigInt(count);
  const minGas = blocks.reduce((a, b) => (b.gasUsed < a ? b.gasUsed : a), blocks[0].gasUsed);
  const maxGas = blocks.reduce((a, b) => (b.gasUsed > a ? b.gasUsed : a), blocks[0].gasUsed);
  const avgGasPerTx = totalTx > 0 ? totalGasUsed / BigInt(totalTx) : null;

  // 가스 사용률 (%)
  const utilizations = blocks.map((b) =>
    b.gasLimit > 0n ? Number((b.gasUsed * 10000n) / b.gasLimit) / 100 : 0,
  );
  const avgUtil = round3(utilizations.reduce((a, b) => a + b, 0) / count);
  const minUtil = round3(Math.min(...utilizations));
  const maxUtil = round3(Math.max(...utilizations));

  // 성능
  const TPS = elapsedSeconds > 0 ? round3(totalTx / elapsedSeconds) : null;
  const mgasPerSec =
    elapsedSeconds > 0 ? round3(Number(totalGasUsed) / 1_000_000 / elapsedSeconds) : null;

  return {
    meta: { startBlock, endBlock, generatedAt: new Date().toISOString() },
    blocks: { count, firstTimestamp, lastTimestamp, elapsedSeconds, avgBlockTimeSeconds },
    transactions: {
      total: totalTx,
      perBlock: { avg: avgTx, min: minTx, max: maxTx, stddev: stddevTx },
    },
    gas: {
      totalUsed: totalGasUsed.toString(),
      limit: avgGasLimit.toString(),
      perBlock: {
        avg: avgGasPerBlock.toString(),
        min: minGas.toString(),
        max: maxGas.toString(),
      },
      perTx: { avg: avgGasPerTx !== null ? avgGasPerTx.toString() : null },
      utilization: { avg: avgUtil, min: minUtil, max: maxUtil },
    },
    performance: {
      TPS,
      'Mgas/s': mgasPerSec,
      avgBlockTimeSeconds,
    },
  };
}

// ────────────────────────────────────────────────────────────
// 파일 저장
// ────────────────────────────────────────────────────────────

function resolveFiles(startBlock: number, endBlock: number): { jsonFile: string; htmlFile: string } {
  return {
    jsonFile: path.join(config.reportDir, `${startBlock}-${endBlock}.json`),
    htmlFile: path.join(config.reportDir, `${startBlock}-${endBlock}.html`),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonFile(result: PerfResult, jsonFile: string): Promise<void> {
  await ensureDir(path.dirname(jsonFile));
  await fs.writeFile(jsonFile, JSON.stringify(result, null, 2), 'utf-8');
}

function formatGas(wei: bigint): string {
  if (wei >= 1_000_000_000n) return (Number(wei) / 1e9).toFixed(3) + ' Ggas';
  if (wei >= 1_000_000n) return (Number(wei) / 1e6).toFixed(3) + ' Mgas';
  return wei.toLocaleString() + ' gas';
}

function buildHtml(result: PerfResult): string {
  const { meta, blocks, transactions, gas, performance } = result;

  const tps = performance.TPS !== null ? performance.TPS.toFixed(3) : '—';
  const mgas = performance['Mgas/s'] !== null ? performance['Mgas/s'].toFixed(3) : '—';
  const avgBlockTime =
    blocks.avgBlockTimeSeconds !== null ? `${blocks.avgBlockTimeSeconds.toFixed(1)} s` : '—';

  const avgGasPerTx =
    gas.perTx.avg !== null ? Number(BigInt(gas.perTx.avg)).toLocaleString() : '—';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Block Performance Report: ${meta.startBlock} ~ ${meta.endBlock}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f7fa; color: #222; padding: 28px; }
  header { margin-bottom: 24px; }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header p { color: #666; font-size: 0.875rem; margin-top: 6px; }
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .kpi { background: #fff; border-radius: 10px; padding: 20px 24px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .kpi .label { font-size: 0.75rem; color: #888; letter-spacing: .06em; }
  .kpi .value { font-size: 2rem; font-weight: 700; color: #1a56db; margin-top: 8px; }
  .two-col-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .two-col-row .card { margin-bottom: 0; }
  .card { background: #fff; border-radius: 10px; padding: 20px 24px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 16px; }
  .card h2 { font-size: 0.9rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #555; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #eee; }
  .gas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #eee; }
  .card-header h2 { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
  .unit-btns { display: flex; gap: 4px; }
  .unit-btn { font-size: 0.75rem; padding: 3px 10px; border: 1px solid #ddd; border-radius: 6px; background: #f5f7fa; color: #555; cursor: pointer; transition: background .15s, color .15s; }
  .unit-btn.active { background: #1a56db; color: #fff; border-color: #1a56db; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; color: #888; font-weight: 500; padding: 5px 0; width: 45%; }
  td { padding: 5px 0; font-variant-numeric: tabular-nums; }
  .footer { font-size: 0.75rem; color: #bbb; margin-top: 20px; text-align: right; }
</style>
</head>
<body>

<header>
  <h1>Block Performance Report</h1>
  <p>Blocks ${meta.startBlock.toLocaleString()} ~ ${meta.endBlock.toLocaleString()}&nbsp;&nbsp;|&nbsp;&nbsp;${meta.generatedAt}</p>
</header>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">TPS</div>
    <div class="value">${tps}</div>
  </div>
  <div class="kpi">
    <div class="label">Mgas/s</div>
    <div class="value">${mgas}</div>
  </div>
  <div class="kpi">
    <div class="label">Avg Block Time</div>
    <div class="value">${avgBlockTime}</div>
  </div>
</div>

<div class="two-col-row">
  <div class="card">
    <h2>Blocks</h2>
    <table>
      <tr><th>Count</th><td>${blocks.count.toLocaleString()}</td></tr>
      <tr><th>Elapsed</th><td>${blocks.elapsedSeconds.toLocaleString()} s</td></tr>
      <tr><th>First Timestamp</th><td>${new Date(blocks.firstTimestamp * 1000).toISOString()}</td></tr>
      <tr><th>Last Timestamp</th><td>${new Date(blocks.lastTimestamp * 1000).toISOString()}</td></tr>
      <tr><th>Avg Block Time</th><td>${avgBlockTime}</td></tr>
    </table>
  </div>
  <div class="card">
    <h2>Transactions</h2>
    <table>
      <tr><th>Total</th><td>${transactions.total.toLocaleString()}</td></tr>
      <tr><th>Avg / Block</th><td>${transactions.perBlock.avg}</td></tr>
      <tr><th>Min / Block</th><td>${transactions.perBlock.min}</td></tr>
      <tr><th>Max / Block</th><td>${transactions.perBlock.max}</td></tr>
      <tr><th>Stddev</th><td>${transactions.perBlock.stddev}</td></tr>
    </table>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <h2>Gas</h2>
    <div class="unit-btns">
      <h4>단위: </h4>
      <button class="unit-btn active" data-unit="gas" onclick="setGasUnit('gas')">gas</button>
      <button class="unit-btn" data-unit="Mgas" onclick="setGasUnit('Mgas')">Mgas</button>
      <button class="unit-btn" data-unit="Ggas" onclick="setGasUnit('Ggas')">Ggas</button>
    </div>
  </div>
  <div class="gas-grid">
    <table>
      <tr><th>Total Used</th><td data-gas-wei="${gas.totalUsed}">${Number(BigInt(gas.totalUsed)).toLocaleString()} gas</td></tr>
      <tr><th>Avg / Block</th><td data-gas-wei="${gas.perBlock.avg}">${Number(BigInt(gas.perBlock.avg)).toLocaleString()} gas</td></tr>
      <tr><th>Min / Block</th><td data-gas-wei="${gas.perBlock.min}">${Number(BigInt(gas.perBlock.min)).toLocaleString()} gas</td></tr>
      <tr><th>Max / Block</th><td data-gas-wei="${gas.perBlock.max}">${Number(BigInt(gas.perBlock.max)).toLocaleString()} gas</td></tr>
      <tr><th>Avg / Tx</th><td ${gas.perTx.avg !== null ? `data-gas-wei="${gas.perTx.avg}"` : ''}>${gas.perTx.avg !== null ? `${Number(BigInt(gas.perTx.avg)).toLocaleString()} gas` : '—'}</td></tr>
    </table>
    <table>
      <tr><th>Gas Limit</th><td data-gas-wei="${gas.limit}">${Number(BigInt(gas.limit)).toLocaleString()} gas</td></tr>
      <tr><th>Utilization Avg</th><td>${gas.utilization.avg} %</td></tr>
      <tr><th>Utilization Min</th><td>${gas.utilization.min} %</td></tr>
      <tr><th>Utilization Max</th><td>${gas.utilization.max} %</td></tr>
    </table>
  </div>
</div>

<p class="footer">Generated by besu-load-injector</p>

<script>
function setGasUnit(unit) {
  document.querySelectorAll('.unit-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.unit === unit);
  });
  document.querySelectorAll('[data-gas-wei]').forEach(function(td) {
    var n = Number(td.dataset.gasWei);
    var text;
    if (unit === 'gas') text = n.toLocaleString() + ' gas';
    else if (unit === 'Mgas') text = (n / 1e6).toFixed(3) + ' Mgas';
    else text = (n / 1e9).toFixed(3) + ' Ggas';
    td.textContent = text;
  });
}
</script>
</body>
</html>`;
}

async function writeHtmlFile(result: PerfResult, htmlFile: string): Promise<void> {
  await ensureDir(path.dirname(htmlFile));
  await fs.writeFile(htmlFile, buildHtml(result), 'utf-8');
}

// ────────────────────────────────────────────────────────────
// 공개 API — 코어
// ────────────────────────────────────────────────────────────

export async function extractBlockRange(startBlock: number, endBlock: number): Promise<PerfResult> {
  const blocks = await fetchBlocks(startBlock, endBlock);
  return computeStats(blocks, startBlock, endBlock);
}

// ────────────────────────────────────────────────────────────
// 공개 API — 동기
// ────────────────────────────────────────────────────────────

export async function extractSync(
  startBlock: number,
  endBlock: number,
): Promise<{ jsonFile: string; htmlFile: string; result: PerfResult }> {
  const result = await extractBlockRange(startBlock, endBlock);
  const { jsonFile, htmlFile } = resolveFiles(startBlock, endBlock);

  await Promise.all([writeJsonFile(result, jsonFile), writeHtmlFile(result, htmlFile)]);

  logger.info(`Perf sync done: ${jsonFile}`);
  return { jsonFile, htmlFile, result };
}

// ────────────────────────────────────────────────────────────
// 공개 API — 비동기 (잡)
// ────────────────────────────────────────────────────────────

function jobsDir(): string {
  return path.join(config.reportDir, '.jobs');
}

async function writeJobState(state: JobState): Promise<void> {
  await ensureDir(jobsDir());
  await fs.writeFile(
    path.join(jobsDir(), `${state.jobId}.json`),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

export async function getJob(jobId: string): Promise<JobState | null> {
  try {
    const content = await fs.readFile(path.join(jobsDir(), `${jobId}.json`), 'utf-8');
    return JSON.parse(content) as JobState;
  } catch {
    return null;
  }
}

export async function extractAsync(
  startBlock: number,
  endBlock: number,
): Promise<{ jobId: string; jsonFile: string; htmlFile: string }> {
  const jobId = uuidv4();
  const { jsonFile, htmlFile } = resolveFiles(startBlock, endBlock);

  const initialState: JobState = {
    jobId,
    status: 'pending',
    startBlock,
    endBlock,
    jsonFile,
    htmlFile,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  await writeJobState(initialState);

  // 백그라운드 처리 (fire-and-forget)
  setImmediate(async () => {
    try {
      await writeJobState({ ...initialState, status: 'running' });

      const result = await extractBlockRange(startBlock, endBlock);
      await Promise.all([writeJsonFile(result, jsonFile), writeHtmlFile(result, htmlFile)]);

      await writeJobState({
        ...initialState,
        status: 'done',
        completedAt: new Date().toISOString(),
      });
      logger.info(`Perf async job done: ${jobId}`);
    } catch (err) {
      await writeJobState({
        ...initialState,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: String(err),
      });
      logger.error(`Perf async job failed: ${jobId}`, err);
    }
  });

  return { jobId, jsonFile, htmlFile };
}
