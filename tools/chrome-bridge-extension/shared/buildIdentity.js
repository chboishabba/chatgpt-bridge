(() => {
  'use strict';

  // Internal bundle identity is intentionally separate from the user-facing
  // extension version. It changes whenever a bundled extension release must be
  // distinguishable from another unpacked directory with the same semver.
  globalThis.ChatGptBridgeBuildIdentity = Object.freeze({
    bundleId: '850010bfeefb7b3c831c6ec47d2adad2',
  });
})();