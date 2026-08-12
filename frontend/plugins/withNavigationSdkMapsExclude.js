/**
 * Expo config plugin: keep the standalone Maps SDK out of the build.
 *
 * THE PROBLEM
 * -----------
 * The Google Navigation SDK bundles its own copy of the Maps SDK classes —
 * `com.google.android.gms.maps.GoogleMap`, `CameraUpdateFactory`, the whole
 * `maps.model` package. If `com.google.android.gms:play-services-maps` is also
 * on the classpath, every one of those classes exists twice and the build dies
 * at `checkReleaseDuplicateClasses` with a hundred-line wall of
 * "Duplicate class ... found in modules navigation-7.6.1.aar and
 * play-services-maps-x.y.z.aar".
 *
 * Google states this directly: "You cannot use the Navigation SDK and the Maps
 * SDK in the same app, as the Navigation SDK replaces the Maps SDK's
 * functionalities."
 *
 * WHY AN EXCLUDE RATHER THAN REMOVING A DEPENDENCY
 * ------------------------------------------------
 * Removing react-native-maps was not sufficient. play-services-maps came back
 * at a DIFFERENT version (18.0.2 rather than react-native-maps' 19.1.0),
 * meaning it arrives transitively through a prebuilt AAR — a payments or
 * sign-in SDK that lists it as a dependency. Those are not ours to edit, and
 * chasing whichever one it is would only hold until the next SDK adds it back.
 *
 * Excluding the module for every configuration is both the robust fix and a
 * safe one: nothing loses functionality, because the Navigation SDK supplies
 * identical classes under identical names. Anything compiled against
 * `com.google.android.gms.maps.*` still links.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const BLOCK = `
// Added by plugins/withNavigationSdkMapsExclude.js
// The Navigation SDK bundles the Maps SDK classes. A second copy arriving
// transitively (payments / sign-in SDKs pull play-services-maps) makes the
// build fail on duplicate classes. Excluding it is Google's stated position:
// the two SDKs cannot coexist, and the Navigation SDK replaces the Maps SDK.
configurations.all {
    exclude group: 'com.google.android.gms', module: 'play-services-maps'
}
`;

module.exports = function withNavigationSdkMapsExclude(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(
        '[withNavigationSdkMapsExclude] Expected a Groovy build.gradle, got ' +
          `"${cfg.modResults.language}".`
      );
    }
    // Idempotent: prebuild runs repeatedly and must not stack copies.
    if (cfg.modResults.contents.includes("module: 'play-services-maps'")) {
      return cfg;
    }
    cfg.modResults.contents += BLOCK;
    return cfg;
  });
};
