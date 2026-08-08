import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 시스템에 이미 깔린 Chromium 계열 브라우저를 찾는다.
 * 크로미움을 따로 내려받지 않으므로 설치가 가볍고 GitHub Actions 에서도 바로 돈다.
 * (윈도우는 Edge 가 기본 탑재라 사실상 항상 잡힌다.)
 */
export function findBrowser() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`PUPPETEER_EXECUTABLE_PATH 경로에 파일이 없습니다: ${fromEnv}`);
    }
    return fromEnv;
  }

  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = {
    win32: [
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    ],
  };

  for (const candidate of candidates[process.platform] ?? []) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    '크롬 계열 브라우저를 찾지 못했습니다.\n' +
      '  1) 크롬을 설치하거나 https://www.google.com/chrome\n' +
      '  2) 이미 있다면 경로를 지정하세요:\n' +
      '     Windows  set PUPPETEER_EXECUTABLE_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
      '     mac/linux  export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome',
  );
}

/** 렌더링 전용이므로 GPU·샌드박스 관련 옵션을 CI 친화적으로 맞춘다. */
export async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
    ],
  });
}
