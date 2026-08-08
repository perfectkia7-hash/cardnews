import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { log } from './util.mjs';

/**
 * Claude Code CLI 를 헤드리스로 불러 카피를 받는다.
 *
 * 구독(Pro/Max/Team/Enterprise) 계정으로 발급한 CLAUDE_CODE_OAUTH_TOKEN 이 있으면
 * Anthropic API 요금이 따로 나가지 않는다. 구독 사용량 한도만 쓴다.
 *
 * ⚠ --bare 를 쓰면 안 된다. 그 모드는 OAuth 자격증명을 아예 읽지 않고
 *   ANTHROPIC_API_KEY 만 본다 — 구독으로 돌리려는 목적과 정반대다.
 */

/**
 * 실행할 CLI 를 찾는다.
 *
 * 윈도우에서 PATH 의 `claude` 는 .cmd/.ps1 래퍼라 셸을 거쳐야 하는데,
 * 그러면 인자가 그냥 이어붙여져서 JSON 스키마 안의 따옴표가 깨진다.
 * npm 이 깔아둔 진짜 실행파일을 직접 찾아 셸 없이 띄운다.
 */
function cliCommand() {
  const override = process.env.CLAUDE_CLI_PATH;
  if (override && fsSync.existsSync(override)) return { command: override, shell: false };

  if (process.platform === 'win32') {
    const roots = [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.npm_config_prefix,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    ].filter(Boolean);

    for (const root of roots) {
      const exe = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fsSync.existsSync(exe)) return { command: exe, shell: false };
    }
    // 못 찾으면 셸로라도 시도한다. 인자가 깨질 수 있으니 최후의 수단이다.
    return { command: 'claude', shell: true };
  }

  return { command: 'claude', shell: false };
}

/**
 * 실패 이유를 사람이 읽을 수 있게 바꾼다.
 * CLI 는 실행 중 오류를 종료 코드가 아니라 stdout 의 JSON 으로 알려 주기도 한다.
 */
function explainFailure(code, stdout, stderr) {
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    /* JSON 이 아니면 원문을 쓴다 */
  }

  const reason = payload?.terminal_reason ?? '';
  const detail = String(payload?.result ?? payload?.error ?? stderr ?? stdout ?? '').slice(0, 300);

  if (reason === 'api_error' || /auth|credential|login|401|403/i.test(detail)) {
    return (
      'Claude CLI 인증에 실패했습니다.\n' +
      '  구독으로 돌리려면 토큰이 필요합니다:\n' +
      '    claude setup-token\n' +
      '  나온 값을 CLAUDE_CODE_OAUTH_TOKEN 에 넣으세요 (로컬은 .env, Actions 는 Secrets).\n' +
      (detail ? `  원문: ${detail}` : '')
    );
  }

  if (/rate.?limit|quota|usage limit|429/i.test(detail) || reason === 'rate_limit') {
    return (
      'Claude 사용량 한도에 걸렸습니다.\n' +
      '  한도가 풀리면 다음 예약 때 자동으로 재개됩니다.\n' +
      (detail ? `  원문: ${detail}` : '')
    );
  }

  return `Claude CLI 실행 실패 (종료 코드 ${code}${reason ? `, ${reason}` : ''})\n  ${detail}`;
}

export async function isAvailable() {
  const { command, shell } = cliCommand();
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { shell, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * @param {object} options
 * @param {string} options.prompt       사용자 프롬프트 (stdin 으로 넘긴다)
 * @param {string} options.systemPrompt 카피 규칙 — 기본 시스템 프롬프트에 덧붙인다
 * @param {object} options.schema       받고 싶은 JSON 구조
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} 스키마에 맞는 객체
 */
export async function generate({ prompt, systemPrompt, schema, timeoutMs = 300_000 }) {
  const { command, shell } = cliCommand();

  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', systemPrompt,
    // 카피 작성에는 도구가 필요 없다. 파일을 뒤지려다 멈추는 걸 막는다.
    '--allowedTools', '',
  ];

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI 응답이 ${Math.round(timeoutMs / 1000)}초를 넘겼습니다.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Claude CLI 를 실행하지 못했습니다: ${error.message}\n` +
            '  설치:  npm install -g @anthropic-ai/claude-code',
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(explainFailure(code, out, err)));
        return;
      }
      resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude CLI 응답을 해석하지 못했습니다:\n${stdout.slice(0, 600)}`);
  }

  // 인증 실패 같은 실행 중 오류는 종료 코드가 아니라 결과에 담겨 온다.
  if (payload.is_error || payload.subtype === 'error') {
    throw new Error(
      `Claude CLI 오류: ${payload.result ?? payload.error ?? '알 수 없음'}\n` +
        '  인증이 원인이면:  claude setup-token  으로 토큰을 다시 발급하세요.',
    );
  }

  const structured = payload.structured_output;
  if (!structured) {
    throw new Error(
      '구조화된 결과가 비어 있습니다. Claude Code 버전이 --json-schema 를 지원하는지 확인하세요.\n' +
        `  받은 결과: ${String(payload.result ?? '').slice(0, 300)}`,
    );
  }

  if (typeof payload.total_cost_usd === 'number' && payload.total_cost_usd > 0) {
    log(`      (구독 사용량 환산 약 $${payload.total_cost_usd.toFixed(4)} — 별도 청구 아님)`);
  }

  return structured;
}
