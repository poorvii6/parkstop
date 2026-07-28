// app.config.js — extends app.json to inject the Android Google Maps SDK key
// from the environment, so the key is NEVER committed to source control.
//
// Set this in frontend/.env (which is gitignored):
//   EXPO_PUBLIC_ANDROID_MAPS_KEY=<your Android Maps SDK key>
//
// Expo reads app.json first and passes it here as `config`; we only add the
// android.config.googleMaps.apiKey that react-native-maps needs on Android.
module.exports = ({ config }) => {
  config.android = config.android || {};
  config.android.config = config.android.config || {};
  config.android.config.googleMaps = {
    apiKey: process.env.EXPO_PUBLIC_ANDROID_MAPS_KEY || '',
  };
  return config;
};
