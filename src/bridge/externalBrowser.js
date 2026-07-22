import { spawn } from 'node:child_process';
import { safeChatGptUrl } from '../browserLaunch.js';

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/i;
const MAINTENANCE_RELOAD_PATH = '/maintenance-reload.html';
const MAINTENANCE_RELOAD_CONFIRMATION = 'chatgpt-bridge-maintenance-reload-v1';

export function safeExternalBrowserUrl(value, options = {}) {
  if (options.allowExtensionMaintenance !== true) return safeChatGptUrl(value);
  const parsed = new URL(String(value || ''));
  if (!EXTENSION_ORIGIN_RE.test(`${parsed.protocol}//${parsed.host}`)
    || parsed.pathname !== MAINTENANCE_RELOAD_PATH
    || parsed.username
    || parsed.password
    || parsed.searchParams.get('confirm') !== MAINTENANCE_RELOAD_CONFIRMATION) {
    throw new Error(`Refusing to open untrusted extension URL: ${parsed.toString()}`);
  }
  return parsed.toString();
}

export function openExternalBrowserUrl(value, options = {}) {
  const url = safeExternalBrowserUrl(value, options);
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to open the system browser with ${command}: ${err.message || String(err)}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ command, url });
    });
  });
}
