/**
 * parkstop-nav — ParkStop's own Android navigation helpers.
 *
 *   mini-map      floating picture-in-picture window while navigating
 *   notification  "ParkStop is navigating" — keeps GPS + voice alive when the
 *                 app is minimised or the screen is locked
 *
 * Native code: modules/parkstop-nav/android. Until the app is rebuilt with it
 * (or on iOS / web), every call below is a harmless no-op.
 */
import { requireOptionalNativeModule } from 'expo';

type NativeParkstopNav = {
  isPipSupported(): boolean;
  isInPictureInPicture(): boolean;
  setNavigationActive(active: boolean): void;
  enterPictureInPicture(): boolean;
  startNavNotification(title: string, text: string): boolean;
  updateNavNotification(title: string, text: string): void;
  stopNavNotification(): void;
};

const Native = requireOptionalNativeModule<NativeParkstopNav>('ParkstopNav');

function safe<T>(fn: () => T, fallback: T): T {
  if (!Native) return fallback;
  try { return fn(); } catch (e) { console.warn('[parkstop-nav]', e); return fallback; }
}

export const ParkstopNav = {
  /** True once the app has been rebuilt with this module. */
  available: !!Native,
  isPipSupported: () => safe(() => Native!.isPipSupported(), false),
  isInPictureInPicture: () => safe(() => Native!.isInPictureInPicture(), false),
  setNavigationActive: (active: boolean) => safe(() => Native!.setNavigationActive(active), undefined),
  enterPictureInPicture: () => safe(() => Native!.enterPictureInPicture(), false),
  startNotification: (title: string, text: string) => safe(() => Native!.startNavNotification(title, text), false),
  updateNotification: (title: string, text: string) => safe(() => Native!.updateNavNotification(title, text), undefined),
  stopNotification: () => safe(() => Native!.stopNavNotification(), undefined),
};

export default ParkstopNav;
