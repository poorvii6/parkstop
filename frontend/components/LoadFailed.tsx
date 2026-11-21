/**
 * What a screen shows when a request failed.
 *
 * The rule: a failed load must say so and offer a way to try again. It must
 * never leave a spinner turning, and it must never fall through to the empty
 * state — "No spots yet" for a dropped connection tells an owner with four
 * driveways that they have none, and the only trace of the real failure is a
 * console.log nobody reads.
 *
 * Two shapes, because there are two situations:
 *
 *   LoadFailed        nothing is on screen. Takes over the content area.
 *   LoadFailedBanner  stale data IS on screen. A strip above it saying the
 *                     numbers may be old, tappable to retry.
 *
 * Both are theme-neutral: SC.error and SC.bg are identical in SpotterTheme and
 * BlueprintTheme, and the retry button is bordered rather than accent-filled,
 * so these read correctly on admin, spotter and finder screens alike.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SC, ICON } from '../constants/SpotterTheme';

/** The message to show for a thrown request error. */
export function loadErrorText(e: any, fallback = 'Could not reach the server.'): string {
  const status = e?.response?.status;
  if (status === 403) return 'You do not have access to this.';
  if (status && status >= 500) return 'The server had a problem. Please try again.';
  return (
    e?.response?.data?.message ||
    (e?.code === 'ECONNABORTED' ? 'The server took too long. Please try again.' : '') ||
    (e?.message === 'Network Error' ? 'No connection. Check your internet and try again.' : '') ||
    fallback
  );
}

export function LoadFailed({
  message,
  onRetry,
  retrying,
  what,
  compact,
}: {
  message?: string;
  onRetry: () => void;
  /** Disables the button and reads "Trying…" while the retry is in flight. */
  retrying?: boolean;
  /** Named in the accessibility label, e.g. "the queue". */
  what?: string;
  /** Less vertical padding, for a block inside an already-short section. */
  compact?: boolean;
}) {
  return (
    <View style={[s.wrap, compact && { paddingVertical: 28 }]}>
      <Ionicons name="cloud-offline-outline" size={compact ? ICON.empty : ICON.hero} color={SC.textMuted} />
      <Text style={s.message}>{message || 'Could not reach the server.'}</Text>
      <TouchableOpacity
        style={[s.retry, retrying && { opacity: 0.5 }]}
        onPress={onRetry}
        disabled={retrying}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Try loading ${what || 'this'} again`}
      >
        <Ionicons name="refresh" size={ICON.label} color={SC.textPrimary} />
        <Text style={s.retryText}>{retrying ? 'Trying…' : 'Try again'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export function LoadFailedBanner({
  message,
  onRetry,
  style,
}: {
  message?: string;
  onRetry: () => void;
  style?: any;
}) {
  return (
    <TouchableOpacity
      style={[s.banner, style]}
      onPress={onRetry}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel="Could not refresh. Tap to try again."
    >
      {/* Solid in the banner, outline in the block above: the banner reports
          state, the block is an illustration. SpotterTheme has the rule. */}
      <Ionicons name="cloud-offline" size={ICON.tile} color={SC.warning} />
      <Text style={s.bannerText} numberOfLines={2}>
        {message || 'Could not refresh — this may be out of date.'}
      </Text>
      <Text style={s.bannerAction}>Retry</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 56, paddingHorizontal: 32, gap: 14 },
  message: { color: SC.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center', lineHeight: 20 },
  retry: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 18, paddingVertical: 11, borderRadius: 14,
    backgroundColor: SC.bgElevated, borderWidth: 1, borderColor: SC.border,
  },
  retryText: { color: SC.textPrimary, fontSize: 14, fontWeight: '700' },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: SC.warningSoft, borderRadius: 14, borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.3)', paddingHorizontal: 13, paddingVertical: 11,
  },
  bannerText: { color: SC.textPrimary, flex: 1, fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
  bannerAction: { color: SC.warning, fontSize: 12.5, fontWeight: '800' },
});
