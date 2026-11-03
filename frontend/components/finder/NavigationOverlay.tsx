/**
 * NavigationOverlay — the driving screen shown over ParkStop's map.
 *
 *   top     next turn: arrow, distance to it, the instruction, and a
 *           "Then …" strip when another turn follows right after
 *   side    voice on/off, and route overview
 *   bottom  current speed, time left, distance left, arrival time, and End
 *   arrived "You have arrived" with the check-in PIN for the owner
 *
 * Display only; all navigation state lives in useInAppNavigation.
 */
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { NavProgress } from '../../hooks/useInAppNavigation';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function maneuverIcon(m?: string): IconName {
  switch (m) {
    case 'TURN_LEFT': return 'arrow-left-top';
    case 'TURN_RIGHT': return 'arrow-right-top';
    case 'TURN_SLIGHT_LEFT': return 'arrow-top-left';
    case 'TURN_SLIGHT_RIGHT': return 'arrow-top-right';
    case 'TURN_SHARP_LEFT': return 'arrow-left-bottom';
    case 'TURN_SHARP_RIGHT': return 'arrow-right-bottom';
    case 'UTURN_LEFT': return 'arrow-u-left-top';
    case 'UTURN_RIGHT': return 'arrow-u-right-top';
    case 'RAMP_LEFT':
    case 'FORK_LEFT':
    case 'RAMP_RIGHT':
    case 'FORK_RIGHT': return 'call-split';
    case 'MERGE': return 'call-merge';
    case 'ROUNDABOUT_LEFT': return 'rotate-left';
    case 'ROUNDABOUT_RIGHT': return 'rotate-right';
    case 'FERRY':
    case 'FERRY_TRAIN': return 'ferry';
    default: return 'arrow-up';
  }
}

/** 1240 -> "1.2 km", 340 -> "350 m", 37 -> "40 m" */
export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

export function formatDuration(s: number): string {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return mm ? `${h} hr ${mm} min` : `${h} hr`;
}

function arrivalClock(s: number): string {
  const t = new Date(Date.now() + s * 1000);
  let h = t.getHours();
  const m = t.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

export function NavigationOverlay({
  phase,
  progress,
  rerouting,
  destinationTitle,
  otp,
  speedKmh,
  speedLimitKmh = null,
  compact = false,
  voiceAvailable,
  muted,
  onToggleMute,
  onOverview,
  onEnd,
  onDone,
}: {
  phase: 'navigating' | 'arrived';
  progress: NavProgress | null;
  rerouting: boolean;
  destinationTitle?: string;
  /** Check-in PIN, shown on arrival. Absent when navigating to a searched place. */
  otp?: string;
  speedKmh: number | null;
  /** Limit of the current road (km/h), or null when unknown. */
  speedLimitKmh?: number | null;
  /** Floating mini-map (picture-in-picture): show only the next turn. */
  compact?: boolean;
  voiceAvailable: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onOverview: () => void;
  onEnd: () => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();

  // ── Mini-map: one small card, no buttons (the window is too small to tap) ──
  if (compact) {
    const n = progress?.nextStep;
    return (
      <View style={s.miniWrap} pointerEvents="none">
        <View style={s.miniCard}>
          {phase === 'arrived' ? (
            <>
              <MaterialCommunityIcons name="flag-checkered" size={22} color="#fff" />
              <Text style={s.miniText} numberOfLines={1}>Arrived</Text>
            </>
          ) : (
            <>
              <MaterialCommunityIcons name={n ? maneuverIcon(n.maneuver) : 'map-marker'} size={24} color="#fff" />
              <Text style={s.miniText} numberOfLines={1}>
                {progress ? formatDistance(progress.distanceToNextM) : '…'}
              </Text>
            </>
          )}
        </View>
      </View>
    );
  }

  if (phase === 'arrived') {
    return (
      <View style={[s.bottomWrap, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]} pointerEvents="box-none">
        <View style={s.card}>
          <View style={s.arrivedHead}>
            <View style={s.arrivedIcon}>
              <MaterialCommunityIcons name="flag-checkered" size={24} color="#22c55e" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.arrivedTitle}>You have arrived</Text>
              <Text style={s.arrivedSub} numberOfLines={1}>{destinationTitle || 'Your destination'}</Text>
            </View>
          </View>
          {otp ? (
            <View style={s.pinBox}>
              <Text style={s.pinLabel}>Show this PIN to the owner</Text>
              <Text style={s.pinValue} selectable>{otp}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={s.doneBtn} activeOpacity={0.9} onPress={() => { tap(); onDone(); }}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const next = progress?.nextStep;
  const then = progress?.thenStep;
  const instruction = next ? next.instruction : `Arrive at ${destinationTitle || 'your destination'}`;
  const icon: IconName = next ? maneuverIcon(next.maneuver) : 'map-marker';
  // Shown whenever the phone reports a speed at all. A stopped car reads 0
  // (the hook floors GPS wander), which is honest — hiding the bubble at
  // every red light would make it flicker in and out of view.
  const showSpeed = speedKmh != null;
  // Small tolerance, as Google uses, so GPS noise at the limit doesn't flash red.
  const overLimit = showSpeed && speedLimitKmh != null && (speedKmh as number) > speedLimitKmh + 5;

  return (
    <>
      {/* Next turn */}
      <View style={[s.topWrap, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={s.banner}>
          {rerouting ? (
            <View style={s.bannerRow}>
              <ActivityIndicator color="#fff" />
              <Text style={[s.instruction, { marginLeft: 14 }]}>Finding a new route…</Text>
            </View>
          ) : !progress ? (
            <View style={s.bannerRow}>
              <ActivityIndicator color="#fff" />
              <Text style={[s.instruction, { marginLeft: 14 }]}>Getting your position…</Text>
            </View>
          ) : (
            <View style={s.bannerRow}>
              <MaterialCommunityIcons name={icon} size={46} color="#fff" />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={s.turnDistance}>{formatDistance(progress.distanceToNextM)}</Text>
                <Text style={s.instruction} numberOfLines={2}>{instruction}</Text>
              </View>
            </View>
          )}
        </View>
        {then && !rerouting ? (
          <View style={s.thenStrip}>
            <Text style={s.thenText}>Then</Text>
            <MaterialCommunityIcons name={maneuverIcon(then.maneuver)} size={22} color="#fff" />
          </View>
        ) : null}

        {/* Side buttons: voice + overview */}
        <View style={s.sideCol} pointerEvents="box-none">
          {voiceAvailable ? (
            <TouchableOpacity
              style={s.roundBtn}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={muted ? 'Turn voice guidance on' : 'Mute voice guidance'}
              onPress={() => { tap(); onToggleMute(); }}
            >
              <MaterialCommunityIcons name={muted ? 'volume-off' : 'volume-high'} size={22} color={muted ? '#dc2626' : '#1f2937'} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={s.roundBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Show the whole route"
            onPress={() => { tap(); onOverview(); }}
          >
            <MaterialCommunityIcons name="map-outline" size={22} color="#1f2937" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Trip summary + End */}
      <View style={[s.bottomWrap, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]} pointerEvents="box-none">
        {showSpeed || speedLimitKmh != null ? (
          <View style={s.speedRow}>
            {showSpeed ? (
              <View style={[s.speedBubble, overLimit && s.speedBubbleOver]}>
                <Text style={[s.speedValue, overLimit && s.speedTextOver]}>{Math.round(speedKmh as number)}</Text>
                <Text style={[s.speedUnit, overLimit && s.speedTextOver]}>km/h</Text>
              </View>
            ) : null}
            {speedLimitKmh != null ? (
              <View style={s.limitSign} accessibilityLabel={`Speed limit ${speedLimitKmh} kilometres per hour`}>
                <Text style={s.limitValue}>{speedLimitKmh}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <View style={[s.card, s.tripRow]}>
          <View style={{ flex: 1 }}>
            <Text style={s.eta}>{progress ? formatDuration(progress.remainingS) : '—'}</Text>
            <Text style={s.tripSub} numberOfLines={1}>
              {progress ? `${formatDistance(progress.remainingM)} · arrive ${arrivalClock(progress.remainingS)}` : 'Calculating…'}
            </Text>
            {destinationTitle ? <Text style={s.dest} numberOfLines={1}>To {destinationTitle}</Text> : null}
          </View>
          <TouchableOpacity
            style={s.endBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="End navigation"
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onEnd(); }}
          >
            <Text style={s.endText}>End</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
}

const shadow = {
  shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
};

const s = StyleSheet.create({
  topWrap: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, zIndex: 2000 },
  banner: { backgroundColor: '#0b6b3a', borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, ...shadow, elevation: 12 },
  bannerRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  turnDistance: { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: -0.5 },
  instruction: { color: '#e8f5ee', fontSize: 17, fontWeight: '700', marginTop: 2 },
  thenStrip: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#07502b', borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
    paddingHorizontal: 14, paddingVertical: 7, marginLeft: 12, ...shadow, elevation: 11,
  },
  thenText: { color: '#d1fae5', fontSize: 15, fontWeight: '800' },
  sideCol: { alignSelf: 'flex-end', marginTop: 12, gap: 10 },
  roundBtn: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center', ...shadow, elevation: 8,
  },

  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, zIndex: 2000 },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginLeft: 4 },
  speedBubble: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#e5e7eb', ...shadow, elevation: 8,
  },
  speedBubbleOver: { backgroundColor: '#dc2626', borderColor: '#b91c1c' },
  speedValue: { color: '#111827', fontSize: 22, fontWeight: '900', lineHeight: 24 },
  speedUnit: { color: '#6b7280', fontSize: 10, fontWeight: '700' },
  speedTextOver: { color: '#fff' },
  // Indian speed-limit sign: white disc, thick red ring, black number.
  limitSign: {
    width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff',
    borderWidth: 5, borderColor: '#dc2626',
    alignItems: 'center', justifyContent: 'center', ...shadow, elevation: 8,
  },
  limitValue: { color: '#111827', fontSize: 19, fontWeight: '900' },

  miniWrap: { position: 'absolute', top: 6, left: 6, right: 6, zIndex: 2000 },
  miniCard: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: '#0b6b3a', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6,
  },
  miniText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  card: {
    backgroundColor: '#0f172a', borderRadius: 22, padding: 18,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', ...shadow, elevation: 16,
  },
  tripRow: { flexDirection: 'row', alignItems: 'center' },
  eta: { color: '#22c55e', fontSize: 26, fontWeight: '900', letterSpacing: -0.5 },
  tripSub: { color: '#cbd5e1', fontSize: 14, fontWeight: '600', marginTop: 2 },
  dest: { color: '#64748b', fontSize: 12, fontWeight: '600', marginTop: 4 },
  endBtn: { backgroundColor: '#dc2626', paddingVertical: 14, paddingHorizontal: 26, borderRadius: 28, marginLeft: 12 },
  endText: { color: '#fff', fontSize: 16, fontWeight: '900' },

  arrivedHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  arrivedIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(34,197,94,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  arrivedTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  arrivedSub: { color: '#94a3b8', fontSize: 13, fontWeight: '600', marginTop: 2 },
  pinBox: { backgroundColor: 'rgba(16,185,129,0.06)', borderRadius: 18, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.15)', marginBottom: 14 },
  pinLabel: { color: '#10b981', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  pinValue: { color: '#fff', fontSize: 38, fontWeight: '900', letterSpacing: 8 },
  doneBtn: { backgroundColor: '#1a73e8', paddingVertical: 15, borderRadius: 18, alignItems: 'center' },
  doneText: { color: '#fff', fontSize: 16, fontWeight: '900' },
});
