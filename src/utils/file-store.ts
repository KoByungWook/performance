import fs from 'fs/promises';
import path from 'path';

/**
 * CSV 파일을 읽어 객체 배열로 반환한다.
 * 첫 번째 줄은 헤더로 간주하고 건너뛴다.
 * 파일이 없거나 비어있으면 빈 배열을 반환한다.
 *
 * @param filePath - 읽을 CSV 파일 경로
 * @param headers  - CSV 컬럼 순서와 매핑할 객체 키 목록
 */
export async function readCsvFile<T>(filePath: string, headers: (keyof T)[]): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    if (lines.length <= 1) return []; // 헤더만 있거나 빈 파일

    return lines.slice(1).map((line) => {
      const values = line.split(',');
      const obj = {} as T;
      headers.forEach((key, i) => {
        (obj as Record<string, unknown>)[key as string] = values[i]?.trim() ?? '';
      });
      return obj;
    });
  } catch {
    return [];
  }
}

/**
 * 객체 배열을 CSV 파일로 저장한다.
 * 첫 번째 줄에 헤더를 쓴다.
 * 디렉토리가 없으면 자동 생성한다.
 *
 * @param filePath - 저장할 CSV 파일 경로
 * @param data     - 저장할 객체 배열
 * @param headers  - CSV 컬럼 순서와 매핑할 객체 키 목록
 */
export async function writeCsvFile<T>(
  filePath: string,
  data: T[],
  headers: (keyof T)[],
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const headerLine = headers.join(',');
  const rows = data.map((item) =>
    headers.map((key) => String((item as Record<string, unknown>)[key as string] ?? '')).join(','),
  );

  await fs.writeFile(filePath, [headerLine, ...rows].join('\n'), 'utf-8');
}

/**
 * 새 항목만 CSV 파일에 추가(append)한다.
 * 파일이 없으면 헤더와 함께 새로 생성한다.
 * 기존 데이터를 전체 재작성하지 않으므로 대량 누적 시에도 빠르다.
 *
 * @param filePath - 저장할 CSV 파일 경로
 * @param newData  - 새로 추가할 객체 배열
 * @param headers  - CSV 컬럼 순서와 매핑할 객체 키 목록
 */
export async function appendCsvFile<T>(
  filePath: string,
  newData: T[],
  headers: (keyof T)[],
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const rows = newData
    .map((item) =>
      headers.map((key) => String((item as Record<string, unknown>)[key as string] ?? '')).join(','),
    )
    .join('\n');

  try {
    await fs.access(filePath);
    // 파일 존재: 줄바꿈 후 새 행 추가
    await fs.appendFile(filePath, '\n' + rows, 'utf-8');
  } catch {
    // 파일 없음: 헤더와 함께 새로 생성
    await fs.writeFile(filePath, headers.join(',') + '\n' + rows, 'utf-8');
  }
}
