(() => {
  'use strict';

  // Internal bundle identity is intentionally separate from the user-facing
  // extension version. It changes whenever a bundled extension release must be
  // distinguishable from another unpacked directory with the same semver.
  globalThis.ChatGptBridgeBuildIdentity = Object.freeze({
    bundleId: '51eb649412d74e0da0449b9f78c4f5b2',
  });
})();