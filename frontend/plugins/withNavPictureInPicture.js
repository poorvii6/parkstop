// withNavPictureInPicture — lets ParkStop's main screen shrink into a floating
// mini-map (Android picture-in-picture) while navigating.
//
// The android/ folder is generated (and gitignored), so this plugin re-applies
// the setting whenever it is regenerated with `npx expo prebuild`.
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

module.exports = function withNavPictureInPicture(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity.$['android:supportsPictureInPicture'] = 'true';
    activity.$['android:resizeableActivity'] = 'true';
    // Entering/leaving the mini-map resizes the window; handle it in place
    // instead of restarting the activity (which would drop navigation).
    const changes = new Set(String(activity.$['android:configChanges'] || '').split('|').filter(Boolean));
    ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout'].forEach((c) => changes.add(c));
    activity.$['android:configChanges'] = Array.from(changes).join('|');
    return cfg;
  });
};
