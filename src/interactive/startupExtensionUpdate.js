import { randomUUID } from 'node:crypto';
import { maybeReloadExtensionAtStartup } from '../extensionStartup.js';

function updateLaunchToken() {
  return `bridge-extension-update-${randomUUID()}`;
}

export async function runInteractiveStartupExtensionUpdate({
  bridge,
  policy = 'ask',
  publicBaseUrl = '',
  waitTimeoutMs = 15_000,
  reloadTimeoutMs = 30_000,
  confirm,
  input,
  output,
  log = () => {},
} = {}) {
  if (!bridge || typeof bridge.health !== 'function' || typeof bridge.reloadExtension !== 'function' || typeof bridge.openBrowserTab !== 'function') {
    throw new TypeError('Interactive extension startup requires bridge health, reload, and browser-tab operations');
  }
  const result = await maybeReloadExtensionAtStartup({
    policy,
    mode: 'interactive',
    waitTimeoutMs,
    reloadTimeoutMs,
    confirm,
    input,
    output,
    getHealth: async () => bridge.health(),
    bootstrapBeforeReload: true,
    bootstrapClient: async ({ timeoutMs }) => await bridge.openBrowserTab({
      url: 'https://chatgpt.com/',
      active: true,
      launchToken: updateLaunchToken(),
      timeoutMs: Math.max(5_000, Number(timeoutMs) || waitTimeoutMs),
      bootstrapWaitMs: 0,
      bridgeServerUrl: publicBaseUrl,
      allowSystemFallback: true,
      allowIncompatibleClient: true,
      select: false,
    }),
    reload: async (options) => await bridge.reloadExtension(options),
    log,
  });
  if (result?.status === 'blocked') {
    const error = new Error(result.compatibility?.message
      || 'The connected browser extension cannot receive the Protocol 5 reload command. Update the unpacked extension manually before starting interactive mode.');
    error.code = 'INTERACTIVE_EXTENSION_UPDATE_BLOCKED';
    error.result = result;
    throw error;
  }
  return result;
}
