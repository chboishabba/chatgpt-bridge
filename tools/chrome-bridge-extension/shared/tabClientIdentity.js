export function tabScopedClientId(baseClientId = '', tabId = null) {
  const base = String(baseClientId || '').trim().replace(/:tab:\d+$/i, '');
  if (!Number.isInteger(tabId) || tabId < 0) return base;
  return `${base || 'extension'}:tab:${tabId}`;
}
