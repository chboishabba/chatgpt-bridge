(() => {
  'use strict';

  // Internal bundle identity is intentionally separate from the user-facing
  // extension version. It changes whenever a bundled extension release must be
  // distinguishable from another unpacked directory with the same semver.
  globalThis.ChatGptBridgeBuildIdentity = Object.freeze({
    bundleId: '1f4a8d26eb6b4a04aeb76b7d482996c1',
  });
})();