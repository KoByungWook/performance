import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { nonceService } from './nonce.service';

const provider = new ethers.JsonRpcProvider(config.besuRpcUrl);

let cachedChainId: bigint | null = null;

async function getChainId(): Promise<bigint> {
  if (cachedChainId === null) {
    const network = await provider.getNetwork();
    cachedChainId = network.chainId;
    logger.info(`Chain ID: ${cachedChainId}`);
  }
  return cachedChainId;
}

/**
 * gasLimit 입력값을 실제 bigint 값으로 변환한다.
 *
 * - number    : 해당 값을 그대로 사용 (고정값)
 * - "auto"    : eth_estimateGas 호출로 자동 추정
 * - undefined : "auto"와 동일
 */
type GasLimitInput = number | 'auto' | undefined;

async function resolveGasLimit(
  input: GasLimitInput,
  txParams: { from?: string; to?: string; data?: string; value?: bigint },
): Promise<bigint> {
  if (typeof input === 'number') {
    return BigInt(input);
  }
  // "auto" 또는 생략 → estimateGas
  const estimated = await provider.estimateGas(txParams);
  logger.debug(`estimateGas: ${estimated}`);
  return estimated;
}

/**
 * nonce 불일치 에러 여부를 판단한다.
 * 해당 에러 발생 시 Redis nonce를 체인과 재동기화한 뒤 1회 재시도한다.
 */
function isNonceTooLowError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes('nonce too low') || msg.includes('nonce already used');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReceipt(txHash: string): Promise<ethers.TransactionReceipt> {
  const deadline = Date.now() + config.receiptTimeoutMs;

  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await sleep(config.receiptPollMs);
  }

  throw new Error(`Receipt timeout: ${txHash}`);
}

function processParams(params: unknown[], tokenParamIndexes?: number[]): unknown[] {
  if (!tokenParamIndexes || tokenParamIndexes.length === 0) return params;

  return params.map((p, i) => {
    if (tokenParamIndexes.includes(i) && typeof p === 'string') {
      return ethers.parseUnits(p, config.tokenDecimals);
    }
    return p;
  });
}

// ────────────────────────────────────────────────────────────
// POST /tx/transfer — ETH 단순 전송 (EOA → EOA)
// ────────────────────────────────────────────────────────────
export interface EthTransferRequest {
  walletAddress: string;
  privateKey: string;
  toAddress: string;
  value: string;              // ETH 단위 (예: "1.5", "0")
  gasLimit?: number | 'auto'; // integer = 고정값, "auto"/생략 = estimateGas
}

export interface EthTransferResult {
  txHash: string;
  from: string;
  to: string;
  value: string;
  nonce: number;
  gasLimit: string;
}

export interface EthTransferReceiptResult extends EthTransferResult {
  receipt: {
    blockNumber: number;
    gasUsed: string;
    status: number;
  };
}

export async function sendEthTransfer(req: EthTransferRequest): Promise<EthTransferResult> {
  const { walletAddress, privateKey, toAddress, value, gasLimit: gasLimitInput } = req;

  const chainId = await getChainId();
  const wallet = new ethers.Wallet(privateKey);
  const weiValue = ethers.parseEther(value);

  // nonce 낭비를 피하기 위해 estimateGas는 nonce 할당 전에 수행
  const gasLimit = await resolveGasLimit(gasLimitInput, {
    from: walletAddress,
    to: toAddress,
    value: weiValue,
    data: '0x',
  });

  const attempt = async (): Promise<EthTransferResult> => {
    const nonce = await nonceService.allocateNonce(walletAddress);

    const tx: ethers.TransactionRequest = {
      to: toAddress,
      value: weiValue,
      nonce,
      gasLimit,
      gasPrice: BigInt(config.gasPriceWei),
      chainId,
      data: '0x',
      type: 0,
    };
    
    const signedTx = await wallet.signTransaction(tx);

    try {
      const txHash = await provider.send('eth_sendRawTransaction', [signedTx]);
      logger.debug(`ETH transfer: ${txHash} from=${walletAddress} to=${toAddress} value=${value} ETH nonce=${nonce} gasLimit=${gasLimit}`);
      return { txHash, from: walletAddress, to: toAddress, value, nonce, gasLimit: gasLimit.toString() };
    } catch (err) {
      if (!isNonceTooLowError(err)) {
        await nonceService.releaseNonce(walletAddress, nonce);
      }
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (isNonceTooLowError(err)) {
      logger.warn(`Nonce error for ${walletAddress}, resyncing and retrying...`);
      await nonceService.syncNonce(walletAddress);
      return attempt();
    }
    throw err;
  }
}

export async function sendEthTransferAndWait(req: EthTransferRequest): Promise<EthTransferReceiptResult> {
  const result = await sendEthTransfer(req);
  const receipt = await waitForReceipt(result.txHash);

  return {
    ...result,
    receipt: {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status ?? 0,
    },
  };
}

// ────────────────────────────────────────────────────────────
// POST /tx/call — 읽기 전용 컨트랙트 콜 (eth_call)
// ────────────────────────────────────────────────────────────
export interface ContractCallRequest {
  walletAddress?: string;
  contractAddress: string;
  abi: string[] | object[];
  functionName: string;
  params: unknown[];
  tokenParamIndexes?: number[];
}

export interface ContractCallResult {
  contractAddress: string;
  functionName: string;
  result: unknown;
}

export async function contractCall(req: ContractCallRequest): Promise<ContractCallResult> {
  const { walletAddress, contractAddress, abi, functionName, params, tokenParamIndexes } = req;

  const iface = new ethers.Interface(abi);
  const processedParams = processParams(params, tokenParamIndexes);
  const data = iface.encodeFunctionData(functionName, processedParams);

  const callObj: { to: string; data: string; from?: string } = { to: contractAddress, data };
  if (walletAddress) callObj.from = walletAddress;

  const rawResult = await provider.send('eth_call', [callObj, 'latest']);
  const decoded = iface.decodeFunctionResult(functionName, rawResult);

  const result = decoded.length === 1
    ? decoded[0].toString()
    : Array.from(decoded).map((v) => String(v));

  logger.debug(`eth_call ${functionName} on ${contractAddress}: ${result}`);

  return { contractAddress, functionName, result };
}

// ────────────────────────────────────────────────────────────
// POST /tx/send — 트랜잭션 전송, txHash 즉시 반환
// ────────────────────────────────────────────────────────────
export interface ContractSendRequest {
  walletAddress: string;
  privateKey: string;
  contractAddress: string;
  abi: string[] | object[];
  functionName: string;
  params: unknown[];
  tokenParamIndexes?: number[];
  gasLimit?: number | 'auto'; // integer = 고정값, "auto"/생략 = estimateGas
}

export interface SendResult {
  txHash: string;
  from: string;
  contractAddress: string;
  functionName: string;
  nonce: number;
  gasLimit: string;
}

export async function sendContractTx(req: ContractSendRequest): Promise<SendResult> {
  const { walletAddress, privateKey, contractAddress, abi, functionName, params, tokenParamIndexes, gasLimit: gasLimitInput } = req;

  const iface = new ethers.Interface(abi);
  const processedParams = processParams(params, tokenParamIndexes);
  const data = iface.encodeFunctionData(functionName, processedParams);

  const chainId = await getChainId();
  const wallet = new ethers.Wallet(privateKey);

  // nonce 낭비를 피하기 위해 estimateGas는 nonce 할당 전에 수행
  const gasLimit = await resolveGasLimit(gasLimitInput, {
    from: walletAddress,
    to: contractAddress,
    data,
    value: 0n,
  });

  const attempt = async (): Promise<SendResult> => {
    const nonce = await nonceService.allocateNonce(walletAddress);

    const tx: ethers.TransactionRequest = {
      to: contractAddress,
      value: 0n,
      nonce,
      gasLimit,
      gasPrice: BigInt(config.gasPriceWei),
      chainId,
      data,
      type: 0,
    };

    const signedTx = await wallet.signTransaction(tx);

    try {
      const txHash = await provider.send('eth_sendRawTransaction', [signedTx]);
      logger.debug(`Sent tx: ${txHash} from=${walletAddress} nonce=${nonce} gasLimit=${gasLimit}`);
      return { txHash, from: walletAddress, contractAddress, functionName, nonce, gasLimit: gasLimit.toString() };
    } catch (err) {
      if (!isNonceTooLowError(err)) {
        await nonceService.releaseNonce(walletAddress, nonce);
      }
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (isNonceTooLowError(err)) {
      logger.warn(`Nonce error for ${walletAddress}, resyncing and retrying...`);
      await nonceService.syncNonce(walletAddress);
      return attempt();
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
// POST /tx/send-receipt — 트랜잭션 전송, receipt 대기 후 반환
// ────────────────────────────────────────────────────────────
export interface SendReceiptResult extends SendResult {
  receipt: {
    blockNumber: number;
    gasUsed: string;
    status: number;
  };
}

export async function sendContractTxAndWait(req: ContractSendRequest): Promise<SendReceiptResult> {
  const result = await sendContractTx(req);
  const receipt = await waitForReceipt(result.txHash);

  return {
    ...result,
    receipt: {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status ?? 0,
    },
  };
}

// ────────────────────────────────────────────────────────────
// GET /tx/receipt/:txHash — txHash로 receipt 조회
// ────────────────────────────────────────────────────────────
export interface ReceiptResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  status: number;
  contractAddress: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

export async function getReceipt(txHash: string): Promise<ReceiptResult | null> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return null;

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status ?? 0,
    contractAddress: receipt.contractAddress ?? null,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
    })),
  };
}

// ────────────────────────────────────────────────────────────
// POST /tx/send/batch — 서명만 수행, 큐 저장용
// ────────────────────────────────────────────────────────────
export interface SignedTxEntry {
  signedTx: string;
  txHash: string;
  walletAddress: string;
  contractAddress: string;
  functionName: string;
  nonce: number;
  gasLimit: string;
}

export async function signContractTx(req: ContractSendRequest): Promise<SignedTxEntry> {
  const { walletAddress, privateKey, contractAddress, abi, functionName, params, tokenParamIndexes, gasLimit: gasLimitInput } = req;

  const iface = new ethers.Interface(abi);
  const processedParams = processParams(params, tokenParamIndexes);
  const data = iface.encodeFunctionData(functionName, processedParams);

  const chainId = await getChainId();
  const wallet = new ethers.Wallet(privateKey);

  // nonce 낭비를 피하기 위해 estimateGas는 nonce 할당 전에 수행
  const gasLimit = await resolveGasLimit(gasLimitInput, {
    from: walletAddress,
    to: contractAddress,
    data,
    value: 0n,
  });

  const nonce = await nonceService.allocateNonce(walletAddress);

  try {
    const tx: ethers.TransactionRequest = {
      to: contractAddress,
      value: 0n,
      nonce,
      gasLimit,
      gasPrice: BigInt(config.gasPriceWei),
      chainId,
      data,
      type: 0,
    };

    const signedTx = await wallet.signTransaction(tx);
    const txHash = ethers.keccak256(signedTx);
    logger.debug(`Signed (queued): ${txHash} from=${walletAddress} nonce=${nonce} gasLimit=${gasLimit}`);

    return { signedTx, txHash, walletAddress, contractAddress, functionName, nonce, gasLimit: gasLimit.toString() };
  } catch (err) {
    await nonceService.releaseNonce(walletAddress, nonce);
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
// POST /tx/deploy — 컨트랙트 배포
// ────────────────────────────────────────────────────────────
export interface DeployRequest {
  walletAddress: string;
  privateKey: string;
  bytecode: string;
  abi?: string[] | object[];
  constructorParams?: unknown[];
  tokenParamIndexes?: number[];
  gasLimit?: number | 'auto'; // integer = 고정값, "auto"/생략 = estimateGas
}

export interface DeployResult {
  txHash: string;
  contractAddress: string | null;
  from: string;
  nonce: number;
  gasLimit: string;
  receipt: {
    blockNumber: number;
    gasUsed: string;
    status: number;
    revertReason?: string;
  };
}

/**
 * revert된 트랜잭션의 에러 메시지를 추출한다.
 * eth_call로 동일 bytecode를 재실행하여 revert 데이터를 디코딩한다.
 */
async function getRevertReason(
  from: string,
  bytecode: string,
  blockNumber: number,
): Promise<string | undefined> {
  try {
    await provider.call({ from, data: bytecode, blockTag: blockNumber });
    return undefined;
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    const data = typeof e['data'] === 'string' ? (e['data'] as string) : '';

    if (data.startsWith('0x08c379a0')) {
      try {
        const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10));
        return reason as string;
      } catch { return data; }
    }

    if (data.startsWith('0x4e487b71')) {
      try {
        const [code] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10));
        return `Panic(${(code as bigint).toString()})`;
      } catch { return data; }
    }

    if (data && data !== '0x') return data;
    if (typeof e['shortMessage'] === 'string') return e['shortMessage'] as string;
    if (typeof e['reason'] === 'string') return e['reason'] as string;
    return undefined;
  }
}

export async function deployContract(req: DeployRequest): Promise<DeployResult> {
  const { walletAddress, privateKey, bytecode, abi, constructorParams, tokenParamIndexes, gasLimit: gasLimitInput } = req;

  let deployData = bytecode;
  if (abi && constructorParams && constructorParams.length > 0) {
    const iface = new ethers.Interface(abi);
    const processedParams = processParams(constructorParams, tokenParamIndexes);
    const encodedParams = iface.encodeDeploy(processedParams);
    deployData = bytecode + encodedParams.slice(2);
    logger.debug(`Constructor params encoded: ${encodedParams}`);
  }

  const chainId = await getChainId();
  const wallet = new ethers.Wallet(privateKey);

  // nonce 낭비를 피하기 위해 estimateGas는 nonce 할당 전에 수행
  const gasLimit = await resolveGasLimit(gasLimitInput, {
    from: walletAddress,
    data: deployData,
  });

  const attempt = async (): Promise<{ txHash: string; nonce: number }> => {
    const nonce = await nonceService.allocateNonce(walletAddress);

    const tx: ethers.TransactionRequest = {
      value: 0n,
      nonce,
      gasLimit,
      gasPrice: BigInt(config.gasPriceWei),
      chainId,
      data: deployData,
      type: 0,
    };

    const signedTx = await wallet.signTransaction(tx);

    try {
      const txHash = await provider.send('eth_sendRawTransaction', [signedTx]);
      return { txHash, nonce };
    } catch (err) {
      if (!isNonceTooLowError(err)) {
        await nonceService.releaseNonce(walletAddress, nonce);
      }
      throw err;
    }
  };

  let txHash: string;
  let usedNonce: number;

  try {
    ({ txHash, nonce: usedNonce } = await attempt());
  } catch (err) {
    if (isNonceTooLowError(err)) {
      logger.warn(`Nonce error for ${walletAddress}, resyncing and retrying...`);
      await nonceService.syncNonce(walletAddress);
      ({ txHash, nonce: usedNonce } = await attempt());
    } else {
      throw err;
    }
  }

  logger.info(`Deploy tx sent: ${txHash} from=${walletAddress} nonce=${usedNonce} gasLimit=${gasLimit}`);

  const receipt = await waitForReceipt(txHash);

  const result: DeployResult = {
    txHash,
    contractAddress: receipt.contractAddress ?? null,
    from: walletAddress,
    nonce: usedNonce,
    gasLimit: gasLimit.toString(),
    receipt: {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status ?? 0,
    },
  };

  if ((receipt.status ?? 0) === 0) {
    const revertReason = await getRevertReason(walletAddress, deployData, receipt.blockNumber);
    if (revertReason) result.receipt.revertReason = revertReason;
    logger.warn(`Deploy reverted: ${txHash}, reason: ${revertReason ?? 'unknown'}`);
  } else {
    logger.info(`Deploy confirmed: ${txHash}, address: ${result.contractAddress}`);
  }

  return result;
}
