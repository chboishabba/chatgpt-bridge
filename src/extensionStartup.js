import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTENSION_INSTALL_DIRECTORY, deployBundledExtension } from './extensionDeployment.js';

export const DEFAULT_EXTENSION_DIRECTORY = fileURLToPath(new URL('../tools/chrome-bridge-extension', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeExtensionReloadPolicy(value = 'ask') {
  const normalized = String(value || 'ask').trim().toLowerCase();
  if (['always', 'force', 'forced'].includes(normalized)) return 'always';
  if (['if-needed', 'needed', 'auto', 'yes', 'true', '1', 'reload'].includes(normalized)) return 'if-needed';
  if (['never', 'no', 'false', '0', 'skip'].includes(normalized)) return 'never';
  return 'ask';
}

export async function readBundledExtensionInfo(extensionDir = DEFAULT_EXTENSION_DIRECTORY) {
  const resolvedDir = path.resolve(extensionDir);
  const manifestPath = path.join(resolvedDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const version = String(manifest?.version || '').trim();
  if (!version) throw new Error(`Extension manifest has no version: ${manifestPath}`);
  const contentPath = path.join(resolvedDir, 'content.js');
  const contentSource = await fs.readFile(contentPath, 'utf8').catch(() => '');
  const contentVersion = String(contentSource.match(/\bCONTENT_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] || '').trim();
  const buildIdentityPath = path.join(resolvedDir, 'shared', 'buildIdentity.js');
  const buildIdentitySource = await fs.readFile(buildIdentityPath, 'utf8').catch(() => '');
  const bundleId = String(buildIdentitySource.match(/\bbundleId\s*:\s*['"]([^'"]+)['"]/)?.[1] || '').trim();
  return {
    extensionDir: resolvedDir,
    manifestPath,
    contentPath,
    version,
    bundleId,
    buildIdentityPath,
    contentVersion,
    name: String(manifest.name || 'ChatGPT Browser Bridge'),
  };
}

export function extensionClientMatchesBundle(client = {}, info = {}) {
  const extensionMatches = String(client.extensionVersion || '') === String(info.version || '');
  if (!extensionMatches) return false;
  if (info.bundleId && String(client.extensionBundleId || '') !== String(info.bundleId)) return false;
  if (!info.contentVersion) return true;
  return String(client.clientVersion || '') === String(info.contentVersion);
}

export async function confirmYesNo(question, {
  input = process.stdin,
  output = process.stdout,
  defaultValue = true,
} = {}) {
  if (!input?.isTTY || !output?.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
    const answer = String(await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return ['y', 'yes', 'д', 'да'].includes(answer);
  } finally {
    rl.close();
  }
}

export function selectReloadableExtensionClient(health = {}, preferredClientId = '') {
  const clients = Array.isArray(health.clients) ? health.clients : [];
  const activeId = String(health.selectedClientId || health.activeClient?.id || '');
  // A connected extension may be version-incompatible precisely because it needs
  // to reload the unpacked files from disk. Startup reload is the one control
  // operation that is allowed for such a client.
  const usable = clients.filter((client) => client?.ready);
  const preferredId = String(preferredClientId || '');
  return usable.find((client) => client.id === preferredId)
    || usable.find((client) => client.id === activeId)
    || usable.find((client) => client.selected)
    || usable[0]
    || null;
}

export async function waitForReloadableExtension(getHealth, {
  timeoutMs = 15_000,
  intervalMs = 250,
  preferredClientId = '',
} = {}) {
  const startedAt = Date.now();
  let lastHealth = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await getHealth();
    const client = selectReloadableExtensionClient(lastHealth, preferredClientId);
    if (client) return { client, health: lastHealth, waitedMs: Date.now() - startedAt };
    await sleep(intervalMs);
  }
  return { client: null, health: lastHealth, waitedMs: Date.now() - startedAt };
}


function bootstrapResultClient(result = null) {
  if (!result || typeof result !== 'object') return null;
  return result.client && typeof result.client === 'object' ? result.client : result;
}

async function bootstrapReloadableExtension({
  bootstrapClient,
  getHealth,
  preferredClientId = '',
  waitTimeoutMs = 15_000,
  mode = 'startup',
  info = {},
  deployment = null,
  log = () => {},
} = {}) {
  if (typeof bootstrapClient !== 'function') return null;
  log('action', `Opening a dedicated ChatGPT tab to bootstrap the ${mode} extension update...`);
  let opened;
  try {
    opened = await bootstrapClient({
      mode,
      timeoutMs: waitTimeoutMs,
      expectedVersion: String(info.version || ''),
      expectedBundleId: String(info.bundleId || ''),
      expectedContentVersion: String(info.contentVersion || ''),
      extensionDir: String(info.extensionDir || ''),
      installDir: String(deployment?.targetDir || ''),
    });
  } catch (cause) {
    const error = new Error(`Could not open a ChatGPT bootstrap tab for the extension update: ${cause?.message || cause}`);
    error.code = 'EXTENSION_UPDATE_BOOTSTRAP_FAILED';
    error.cause = cause;
    throw error;
  }
  const directClient = bootstrapResultClient(opened);
  const bootstrappedId = String(directClient?.id || preferredClientId || '');
  const connected = await waitForReloadableExtension(getHealth, {
    timeoutMs: waitTimeoutMs,
    preferredClientId: bootstrappedId,
  });
  if (!connected.client) {
    const error = new Error(`The ChatGPT bootstrap tab opened, but no Protocol 5 extension client connected within ${waitTimeoutMs}ms. Confirm that the unpacked extension is loaded from ${deployment?.targetDir || info.extensionDir || 'the packaged extension directory'} and configured for this bridge.`);
    error.code = 'EXTENSION_UPDATE_BOOTSTRAP_TIMEOUT';
    error.bootstrap = opened || null;
    throw error;
  }
  log('ok', `Extension update bootstrap tab connected as ${connected.client.id}.`);
  return { ...connected, bootstrap: opened || null };
}
export async function maybeReloadExtensionAtStartup({
  policy = 'ask',
  mode = 'startup',
  extensionDir = DEFAULT_EXTENSION_DIRECTORY,
  installDir = process.env.BRIDGE_EXTENSION_TARGET_DIR || DEFAULT_EXTENSION_INSTALL_DIRECTORY,
  deploy = deployBundledExtension,
  getHealth,
  reload,
  confirm = confirmYesNo,
  input = process.stdin,
  output = process.stdout,
  waitTimeoutMs = 15_000,
  initialWaitTimeoutMs = Math.min(2_500, waitTimeoutMs),
  reloadTimeoutMs = 30_000,
  reloadTabs = true,
  preferredClientId = '',
  bootstrapClient = null,
  bootstrapBeforeReload = false,
  log = () => {},
} = {}) {
  if (typeof getHealth !== 'function') throw new TypeError('getHealth is required');
  if (typeof reload !== 'function') throw new TypeError('reload is required');
  const normalizedPolicy = normalizeExtensionReloadPolicy(policy);
  const sourceInfo = await readBundledExtensionInfo(extensionDir);
  if (normalizedPolicy === 'never') return { status: 'skipped', reason: 'disabled', policy: normalizedPolicy, ...sourceInfo };
  const deployment = await deploy(sourceInfo.extensionDir, installDir);
  const info = await readBundledExtensionInfo(deployment.targetDir);
  log(deployment.deployed ? 'ok' : 'info', deployment.deployed
    ? `Extension bundle deployed atomically to ${deployment.targetDir}.`
    : `Extension bundle already uses the loaded target ${deployment.targetDir}.`);

  let connected = await waitForReloadableExtension(getHealth, { timeoutMs: initialWaitTimeoutMs, preferredClientId });
  let bootstrapApproved = normalizedPolicy === 'always' || normalizedPolicy === 'if-needed' || deployment.deployed;
  if (!connected.client) {
    if (normalizedPolicy === 'ask' && !bootstrapApproved) {
      const answer = await confirm(
        `No ChatGPT tab is currently connected. Open a temporary ChatGPT tab and reload the unpacked extension from ${deployment.targetDir}?`,
        { input, output, defaultValue: true },
      );
      if (answer === null) {
        log('info', `Skipping ${mode} extension reload because no interactive confirmation channel is available.`);
        return { status: 'skipped', reason: 'non-interactive', policy: normalizedPolicy, deployment, ...info };
      }
      if (!answer) return { status: 'skipped', reason: 'declined', policy: normalizedPolicy, deployment, ...info };
      bootstrapApproved = true;
    }
    if (!bootstrapApproved || typeof bootstrapClient !== 'function') {
      const error = new Error(`No connected extension was available for ${mode} startup reload, and no bootstrap tab could be opened.`);
      error.code = 'EXTENSION_UPDATE_CLIENT_UNAVAILABLE';
      throw error;
    }
    connected = await bootstrapReloadableExtension({
      bootstrapClient, getHealth, preferredClientId, waitTimeoutMs, mode, info, deployment, log,
    });
  }

  if (Number(connected.client.extensionProtocolVersion) !== 5) {
    log('warn', 'The connected extension does not use protocol 5 and cannot receive a reload command. Update the unpacked extension manually or run the installer.');
    return {
      status: 'blocked',
      reason: 'protocol-incompatible',
      policy: normalizedPolicy,
      clientId: connected.client.id,
      deployment,
      compatibility: connected.client.compatibility || null,
      waitedMs: connected.waitedMs,
      ...info,
    };
  }

  if (normalizedPolicy !== 'always' && !deployment.deployed && extensionClientMatchesBundle(connected.client, info)) {
    log('info', `Connected extension is already current (extension v${info.version}${info.contentVersion ? `, content v${info.contentVersion}` : ''}); startup reload is not required.`);
    return {
      status: 'skipped',
      reason: 'already-current',
      policy: normalizedPolicy,
      clientId: connected.client.id,
      deployment,
      connectedVersion: String(connected.client.extensionVersion || ''),
      connectedContentVersion: String(connected.client.clientVersion || ''),
      waitedMs: connected.waitedMs,
      ...info,
    };
  }

  let approved = normalizedPolicy === 'always' || normalizedPolicy === 'if-needed' || deployment.deployed || (Boolean(connected.bootstrap) && bootstrapApproved);
  if ((normalizedPolicy === 'ask' || normalizedPolicy === 'if-needed') && deployment.deployed) {
    log('action', `Extension files changed at ${deployment.targetDir}; reloading the connected unpacked extension even though its version string is unchanged.`);
  } else if (normalizedPolicy === 'ask' && !approved) {
    const currentVersion = String(connected.client.extensionVersion || 'unknown');
    const currentContentVersion = String(connected.client.clientVersion || 'unknown');
    log('action', `Extension update confirmation required for ${mode}. Local: v${info.version}${info.contentVersion ? ` / content ${info.contentVersion}` : ''}; connected: v${currentVersion} / content ${currentContentVersion}.`);
    const answer = await confirm(
      `Reload the connected unpacked extension now? Local project bundle: ${info.extensionDir} (v${info.version}${info.contentVersion ? `, content v${info.contentVersion}` : ''}); connected version: ${currentVersion}, content v${currentContentVersion}.`,
      { input, output, defaultValue: true },
    );
    if (answer === null) {
      log('info', `Skipping ${mode} extension reload because no interactive terminal is available. Use --force-reload-extension to force it.`);
      return { status: 'skipped', reason: 'non-interactive', policy: normalizedPolicy, clientId: connected.client.id, deployment, ...info };
    }
    approved = answer;
  }
  if (!approved) return { status: 'skipped', reason: 'declined', policy: normalizedPolicy, clientId: connected.client.id, deployment, ...info };

  if (bootstrapBeforeReload && typeof bootstrapClient === 'function' && !connected.bootstrap) {
    connected = await bootstrapReloadableExtension({
      bootstrapClient, getHealth, preferredClientId: connected.client.id, waitTimeoutMs, mode, info, deployment, log,
    });
    if (Number(connected.client.extensionProtocolVersion) !== 5) {
      const error = new Error('The dedicated update tab connected through an extension that does not support Protocol 5 reload control.');
      error.code = 'EXTENSION_UPDATE_BOOTSTRAP_PROTOCOL_INCOMPATIBLE';
      throw error;
    }
  }

  log('action', `Reloading unpacked extension deployed at ${deployment.targetDir}...`);
  const result = await reload({
    sourceClientId: connected.client.id,
    expectedVersion: info.version,
    expectedBundleId: info.bundleId,
    reloadTabs,
    allowMaintenancePageBootstrap: true,
    timeoutMs: reloadTimeoutMs,
  });
  const reconnectedVersion = String(result?.reconnected?.extensionVersion || result?.extensionVersion || '');
  const reconnectedContentVersion = String(result?.reconnected?.clientVersion || result?.clientVersion || '');
  const reconnectedBundleId = String(result?.reconnected?.extensionBundleId || result?.extensionBundleId || '');
  if (reconnectedVersion && reconnectedVersion !== info.version) {
    const error = new Error(`Extension reconnected as ${reconnectedVersion}, expected ${info.version}. The current files were deployed to ${deployment.targetDir}, but Chrome is still loading a different unpacked directory. Open chrome://extensions, remove or reload the old entry, and use Load unpacked with ${deployment.targetDir} once.`);
    error.code = 'EXTENSION_LOADED_PATH_MISMATCH';
    error.deployment = deployment;
    throw error;
  }
  if (info.bundleId && reconnectedBundleId !== info.bundleId) {
    const error = new Error(`Extension reconnected from bundle ${reconnectedBundleId || 'unknown'}, expected ${info.bundleId}. Chrome is still loading a different unpacked directory than ${deployment.targetDir}.`);
    error.code = 'EXTENSION_LOADED_PATH_MISMATCH';
    error.deployment = deployment;
    throw error;
  }
  if (info.contentVersion && reconnectedContentVersion && reconnectedContentVersion !== info.contentVersion) {
    const error = new Error(`Extension content runtime reconnected as ${reconnectedContentVersion}, expected ${info.contentVersion}. Chrome is not running the bundle deployed at ${deployment.targetDir}. Load that directory once from chrome://extensions.`);
    error.code = 'EXTENSION_LOADED_PATH_MISMATCH';
    error.deployment = deployment;
    throw error;
  }
  if (result?.recovery?.used) {
    log('warn', `The original owned tab did not reconnect after extension reload; opened a replacement tab and closed the stale owned tab safely (${result.recovery.reason}).`);
  }
  log('ok', `Extension reloaded and reconnected as v${reconnectedVersion || info.version}.`);
  return {
    status: 'reloaded',
    policy: normalizedPolicy,
    clientId: connected.client.id,
    waitedMs: connected.waitedMs,
    reconnectedVersion: reconnectedVersion || info.version,
    reconnectedContentVersion: reconnectedContentVersion || info.contentVersion,
    reconnectedBundleId: reconnectedBundleId || info.bundleId,
    result,
    deployment,
    ...info,
  };
}
