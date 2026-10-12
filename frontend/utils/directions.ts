/**
 * directions.ts — hand driving directions to Google Maps.
 *
 * ParkStop does not do turn-by-turn navigation itself. Google Maps already
 * does it well (traffic, voice, rerouting, offline maps), so we open it with
 * the spot as the destination and let the driver come back to ParkStop when
 * they arrive.
 *
 * The universal https link works everywhere: it opens the Google Maps app when
 * installed (Android and iOS) and the Google Maps website otherwise.
 * `dir_action=navigate` starts navigation straight away instead of showing a
 * route preview.
 */
import { Alert, Linking } from 'react-native';

export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving&dir_action=navigate`;
}

export async function openDirections(lat: number, lng: number): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    Alert.alert('Location missing', 'We could not find this spot on the map.');
    return;
  }
  try {
    await Linking.openURL(directionsUrl(lat, lng));
  } catch {
    Alert.alert('Could not open maps', 'Please install Google Maps or try again.');
  }
}
