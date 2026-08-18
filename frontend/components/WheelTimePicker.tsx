/**
 * Scrolling time wheel — hour, minute, AM/PM.
 *
 * Replaces the platform DateTimePicker, which on Android draws a clock face in
 * the system theme: a light grey dialog dropped on top of a dark app, with a
 * dial you have to aim at. This is the alarm-style spinner people actually
 * expect for setting a time, rendered in ParkStop's own colours so it reads as
 * part of the sheet rather than an OS interruption.
 *
 * Built rather than pulled from a library because the behaviour is a snapping
 * ScrollView and little else — the dependency would be larger than the code.
 */
import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  StyleSheet,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';

/** Row height. Everything else — padding, snap distance, centring — derives from it. */
const ITEM_H = 46;
/** Rows visible at once. Odd, so exactly one sits in the middle. */
const VISIBLE = 5;
const LIST_H = ITEM_H * VISIBLE;

/** Five-minute steps: fine enough for parking, and a third of the scrolling. */
const MINUTE_STEP = 5;

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
const MERIDIEMS = ['AM', 'PM'];

type ColumnProps = {
  data: (string | number)[];
  index: number;
  onIndex: (i: number) => void;
  format?: (v: string | number) => string;
  width: number;
};

/**
 * One scrolling column.
 *
 * The list is padded by two rows top and bottom so the first and last entries
 * can reach the centre line — without that, 1 o'clock and 55 minutes would be
 * unreachable.
 */
function Column({ data, index, onIndex, format, width }: ColumnProps) {
  const ref = useRef<ScrollView>(null);
  const settled = useRef(index);

  // Jump to the current value on mount and whenever it changes from outside
  // (e.g. picking a start time shifts the end time along with it).
  useEffect(() => {
    settled.current = index;
    const t = setTimeout(
      () => ref.current?.scrollTo({ y: index * ITEM_H, animated: false }),
      0
    );
    return () => clearTimeout(t);
  }, [index]);

  const commit = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const raw = e.nativeEvent.contentOffset.y / ITEM_H;
    const next = Math.max(0, Math.min(data.length - 1, Math.round(raw)));
    if (next !== settled.current) {
      settled.current = next;
      // A tick per row is what makes a wheel feel mechanical rather than laggy.
      Haptics.selectionAsync().catch(() => {});
      onIndex(next);
    }
  };

  return (
    <ScrollView
      ref={ref}
      style={{ width, height: LIST_H }}
      contentContainerStyle={{ paddingVertical: ITEM_H * ((VISIBLE - 1) / 2) }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      // Momentum covers a flick; the drag handler catches a slow drag that
      // stops without momentum, which otherwise leaves the value unchanged
      // while the wheel visibly sits on a different number.
      onMomentumScrollEnd={commit}
      onScrollEndDrag={commit}
    >
      {data.map((v, i) => {
        const active = i === index;
        return (
          <View key={String(v)} style={{ height: ITEM_H, justifyContent: 'center', alignItems: 'center' }}>
            <Text
              style={{
                color: active ? '#ffffff' : 'rgba(255,255,255,0.32)',
                fontSize: active ? 26 : 20,
                fontWeight: active ? '900' : '700',
              }}
            >
              {format ? format(v) : String(v)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

type Props = {
  visible: boolean;
  /** Heading — "Arriving" or "Leaving", so the wheel says what it is setting. */
  title: string;
  value: Date;
  onCancel: () => void;
  onConfirm: (d: Date) => void;
};

export default function WheelTimePicker({ visible, title, value, onCancel, onConfirm }: Props) {
  // Local draft: the wheel edits a copy, and nothing is applied until Set. A
  // picker that wrote straight through would repeatedly reprice the booking
  // while the rider was still spinning.
  const [draft, setDraft] = React.useState<Date>(value);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const h24 = draft.getHours();
  const hourIndex = (h24 % 12 || 12) - 1;
  // Round to the nearest step so a time set elsewhere (now + 1h) still lands on
  // a row rather than between two.
  const minuteIndex = Math.round(draft.getMinutes() / MINUTE_STEP) % MINUTES.length;
  const meridiemIndex = h24 >= 12 ? 1 : 0;

  const apply = (hIdx: number, mIdx: number, merIdx: number) => {
    const next = new Date(draft);
    const hour12 = HOURS[hIdx];
    const hour24 = (hour12 % 12) + (merIdx === 1 ? 12 : 0);
    next.setHours(hour24, MINUTES[mIdx], 0, 0);
    setDraft(next);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>

          <View style={styles.wheels}>
            {/* The selection band sits behind the columns so the centre row
              * reads as chosen without needing a border on every item. */}
            <View pointerEvents="none" style={styles.band} />

            <Column
              data={HOURS}
              index={hourIndex}
              width={72}
              onIndex={(i) => apply(i, minuteIndex, meridiemIndex)}
            />
            <Text style={styles.colon}>:</Text>
            <Column
              data={MINUTES}
              index={minuteIndex}
              width={72}
              format={(v) => String(v).padStart(2, '0')}
              onIndex={(i) => apply(hourIndex, i, meridiemIndex)}
            />
            <Column
              data={MERIDIEMS}
              index={meridiemIndex}
              width={72}
              onIndex={(i) => apply(hourIndex, minuteIndex, i)}
            />
          </View>

          <View style={styles.actions}>
            <TouchableOpacity onPress={onCancel} style={[styles.btn, styles.btnGhost]} activeOpacity={0.8}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                onConfirm(draft);
              }}
              style={[styles.btn, styles.btnPrimary]}
              activeOpacity={0.85}
            >
              <Text style={styles.btnPrimaryText}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0f172a',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingTop: 20,
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
  title: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 12,
  },
  wheels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: LIST_H,
  },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: ITEM_H * ((VISIBLE - 1) / 2),
    height: ITEM_H,
    borderRadius: 14,
    backgroundColor: 'rgba(99,102,241,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.45)',
  },
  colon: { color: '#fff', fontSize: 26, fontWeight: '900', marginHorizontal: -4 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.05)' },
  btnGhostText: { color: '#94a3b8', fontWeight: '900', fontSize: 14 },
  btnPrimary: { backgroundColor: '#6366f1' },
  btnPrimaryText: { color: '#fff', fontWeight: '900', fontSize: 14 },
});
