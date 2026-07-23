const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

export function normalizeExtensionReloadTarget(value = '') {
  try {
    const target = new URL(String(value || ''));
    if (!CHATGPT_ORIGINS.has(target.origin)) return '';
    return target.toString();
  } catch {
    return '';
  }
}

export function normalizeExtensionReloadDelay(value, fallback = 2_500) {
  return Math.max(500, Math.min(Number(value) || fallback, 15_000));
}

export function extensionReloadTrampolineHtml(targetUrl, delayMs = 2_500) {
  const target = normalizeExtensionReloadTarget(targetUrl);
  if (!target) throw new TypeError('A valid ChatGPT reload target is required');
  const delay = normalizeExtensionReloadDelay(delayMs);
  const targetJson = JSON.stringify(target).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Updating ChatGPT Bridge</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#f7f7f8;color:#18181b}.card{max-width:420px;margin:24px;padding:24px;border:1px solid #ddd;border-radius:16px;background:#fff;box-shadow:0 12px 36px #0001}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#666}a{display:inline-block;margin-top:16px;color:inherit}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1d1d20;border-color:#444}p{color:#aaa}}</style></head>
<body><main class="card"><h1>Updating ChatGPT Bridge</h1><p>The extension is restarting. This tab will return to ChatGPT automatically.</p><a id="continue" href=${JSON.stringify(target)}>Return now</a></main>
<script>const target=${targetJson};setTimeout(()=>location.replace(target),${delay});</script></body></html>`;
}
