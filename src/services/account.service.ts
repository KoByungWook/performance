import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';
import { Account } from '../models/account.model';
import { writeCsvFile } from '../utils/file-store';
import { config } from '../config';
import { logger } from '../utils/logger';

const ACCOUNT_HEADERS: (keyof Account)[] = ['walletAddress', 'privateKey'];

/**
 * 랜덤 Ethereum 지갑을 생성한다.
 * ethers.Wallet.createRandom()은 BIP-39 니모닉 + PBKDF2(2048회) 유도로 느리므로,
 * 부하 테스트용 계정은 단순 random bytes 방식으로 생성한다. (~300x 빠름)
 */
function createRandomWallet(): ethers.Wallet {
  return new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
}

/**
 * 현재 시각을 yymmddHHMMSS 포맷 문자열로 반환한다.
 * 예: 2025-03-05 14:30:22 → "250305143022"
 */
function nowTimestamp(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const MM = String(now.getMinutes()).padStart(2, '0');
  const SS = String(now.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}${HH}${MM}${SS}`;
}

/**
 * CSV 파일의 데이터 행 수를 반환한다 (헤더 제외).
 */
async function countCsvRows(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    return Math.max(0, lines.length - 1); // 헤더 1줄 제외
  } catch {
    return 0;
  }
}

export interface CreateAccountsResult {
  filename: string;
  count: number;
  filePath: string;
}

export interface AccountFileInfo {
  filename: string;
  rows: number;
  filePath: string;
}

export interface ListAccountsResult {
  files: AccountFileInfo[];
  totalFiles: number;
}

export const accountService = {
  /**
   * POST /accounts
   * count 개의 계정(walletAddress + privateKey)을 생성하고
   * account-{yymmddHHMMSS}.csv 파일로 저장한다.
   */
  async createAccounts(count: number): Promise<CreateAccountsResult> {
    const accounts: Account[] = [];
    for (let i = 0; i < count; i++) {
      const wallet = createRandomWallet();
      accounts.push({ walletAddress: wallet.address, privateKey: wallet.privateKey });
    }

    const filename = `account-${nowTimestamp()}.csv`;
    const filePath = path.join(config.accountDataDir, filename);
    await writeCsvFile(filePath, accounts, ACCOUNT_HEADERS);

    logger.info(`Created ${count} accounts → ${filename}`);
    return { filename, count: accounts.length, filePath };
  },

  /**
   * GET /accounts
   * 데이터 디렉토리 내 account-*.csv 파일 목록과 각 파일의 행 수를 반환한다.
   */
  async listAccounts(): Promise<ListAccountsResult> {
    try {
      await fs.mkdir(config.accountDataDir, { recursive: true });
      const entries = await fs.readdir(config.accountDataDir);
      const csvFiles = entries
        .filter((f) => f.startsWith('account-') && f.endsWith('.csv'))
        .sort(); // 파일명이 타임스탬프 기반이므로 정렬 = 시간순

      const files = await Promise.all(
        csvFiles.map(async (filename) => {
          const filePath = path.join(config.accountDataDir, filename);
          const rows = await countCsvRows(filePath);
          return { filename, rows, filePath };
        }),
      );

      return { files, totalFiles: files.length };
    } catch {
      return { files: [], totalFiles: 0 };
    }
  },

  /**
   * POST /accounts/create
   * 단건 계정(walletAddress + privateKey)을 생성하여 반환한다.
   * 파일로 저장하지 않는다.
   */
  createSingle(): Account {
    const wallet = createRandomWallet();
    return { walletAddress: wallet.address, privateKey: wallet.privateKey };
  },
};
