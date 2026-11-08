// Build identity for the system-info endpoint. SMSinBox reads its version
// from package.json; HiveMos has no package.json, so these stay source
// constants. APP_VERSION is blank until a release version is assigned.
// BUILD_COMMIT names the main commit this source tree was cut from; the
// delivery discipline (deploy only from a pushed commit) keeps it honest,
// but it only moves when someone bumps it — the settings page presents it
// as the source commit, not as a live probe of the running deployment.
export const APP_VERSION = "";
export const BUILD_COMMIT = "8458987";
