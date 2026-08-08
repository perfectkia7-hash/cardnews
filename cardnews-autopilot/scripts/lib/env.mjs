import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, exists } from './util.mjs';

/** .env.example 을 복사만 하고 값을 안 바꾼 경우를 잡아낸다. */
const PLACEHOLDERS = new Set(['123456789', '17841400000000000', 'sk-ant-...']);

export function isPlaceholder(value) {
  if (!value) return true;
  return value.includes('...') || PLACEHOLDERS.has(value.trim());
}

/**
 * .env 의 특정 키만 바꿔 쓴다.
 * 주석과 나머지 줄은 그대로 두고, 주석 처리된 줄이면 살려서 덮어쓴다.
 * 키가 아예 없으면 끝에 덧붙인다.
 */
export async function setEnvValue(key, value) {
  const file = path.join(ROOT, '.env');
  if (!(await exists(file))) {
    throw new Error('.env 파일이 없습니다.  먼저 만드세요:  copy .env.example .env');
  }

  const original = await fs.readFile(file, 'utf8');
  const lines = original.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=`);

  let replaced = false;
  const updated = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) updated.push(`${key}=${value}`);
  await fs.writeFile(file, updated.join('\n'), 'utf8');
}
