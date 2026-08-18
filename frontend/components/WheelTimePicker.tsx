/**
 * Scrolling time wheel — hour, minute, AM/PM.
 *
 * Replaces the platform DateTimePicker, which on Android draws a clock face in
 * the system theme: a light grey dialog dropped on a dark app, with a dial you
 * have to aim at. This is the alarm-style spinner people expect for setting a
 * time, in ParkStop's own colours, inside its own modal.
 *
 * Built rather than pulled from a library because the behaviour is a snapping
 * list and little else — the dependency would be larger than the code.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Modal,
  StyleSheet,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';

/** Row height. Padding, snap distance and centring all derive from it. */
const ITEM_H = 46;
/** Rows visible at once. Odd, so exactly one sits in the middle. */
const VISIBLE = 5;
const LIST_H = ITEM_H * VISIBLE;

/**
 * How many times a wrapping column repeats its values.
 *
 * The wheel wraps by rendering the same sequence many times over and starting
 * in the middle, so scrolling past 59 continues into 0 rather than hitting a
 * wall. Nothing needs to recentre during a session: reaching either end from
 * the middle would take fifty hours of continuous scrolling.
 *
 * This is only affordable because the columns are FlatLists — the rows are
 * virtualised, so a 6,000-entry minute column renders the same handful of
 * views a 60-entry one does.
 */
const LOOPS = 101;
const MIDDLE = Math.floor(LOOPS / 2);

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
/** Every minute. Five-minute steps could not express "leaving at 6:42". */
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const MERIDIEMS = ['AM', 'PM'];

type ColumnProps = {
  /** The values themselves, listed once. Repeating is this component's job. */
  base: (string | number)[];
  /** Index into `base` of the current value. */
  valueIndex: number;
  onValueIndex: (i: number) => void;
  /** Whether scrolling past the last value continues into the first. */
  wrap?: boolean;
  format?: (v: string | number) => string;
  width: number;
};

function Column({ base, valueIndex, onValueIndex, wrap = true, format, width }: ColumnProps) {
  const ref = useRef<FlatList>(null);
  const settled = useRef(valueIndex);

  // The repeated sequence. Memoised because rebuilding a 6,000-entry array on
  // every keystroke of the wheel would be the one genuinely slow thing here.
  const data = useMemo(
    () => (wrap ? Array.from({ length: base.length * LOOPS }, (_, i) => base[i % base.length]) : base),
    [base, wrap]
  );

  const absoluteIndex = wrap ? MIDDLE * base.length + valueIndex : valueIndex;

  // Land on the current value when the wheel opens, and follow it if it is
  // changed from outside — picking an arrival time shifts the departure along
  // with it, and the departure wheel must open on the new value, not the old.
  useEffect(() => {
    settled.current = valueIndex;
    const t = setTimeout(
      () => ref.current?.scrollToOffset({ offset: absoluteIndex * ITEM_H, animated: false }),
      0
    );
    return () => clearTimeout(t);
  }, [absoluteIndex, valueIndex]);

  const commit = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const raw = e.nativeEvent.contentOffset.y / ITEM_H;
    const abs = Math.max(0, Math.min(data.length - 1, Math.round(raw)));
    const next = wrap ? abs % base.length : abs;
    if (next !== settled.current) {
      settled.current = next;
      // A tick per row is what makes a wheel feel mechanical rather than laggy.
      Haptics.selectionAsync().catch(() => {});
      onValueIndex(next);
    }
  };

  return (
    <FlatList
      ref={ref}
      style={{ width, height: LIST_H }}
      data={data}
      keyExtractor={(_, i) => String(i)}
      contentContainerStyle={{ paddingVertical: ITEM_H * ((VISIBLE - 1) / 2) }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      initialScrollIndex={absoluteIndex}
      // Required for initialScrollIndex to land accurately, and it also spares
      // the list from measuring six thousand rows.
      getItemLayout={(_, i) => ({ length: ITEM_H, offset: ITEM_H * i, index: i })}
      // Momentum covers a flick; the drag handler catches a slow drag that
      // stops without momentum, which otherwise leaves the value unchanged
      // while the wheel visibly sits on a different number.
      onMomentumScrollEnd={commit}
      onScrollEndDrag={commit}
      renderItem={({ item, index }) => {
        // Only one repeat of a given value can be on screen at a time — the
        // sequence repeats every base.length rows and only five are visible —
        // so matching modulo cannot highlight two rows at once.
        const active = wrap ? index % base.length === valueIndex : index === valueIndex;
        return (
          <View style={{ height: ITEM_H, justifyContent: 'center', alignItems: 'center' }}>
            <Text
              style={{
                color: active ? '#ffffff' : 'rgba(255,255,255,0.32)',
                fontSize: active ? 26 : 20,
                fontWeight: active ? '900' : '700',
              }}
            >
              {format ? format(item) : String(item)}
            </Text>
          </View>
        );
      }}
    />
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
  // Local draft: the wheel edits a copy and nothing is applied until Set. A
  // picker that wrote straight through would reprice the booking on every row
  // the rider scrolled past.
  const [draft, setDraft] = React.useState<Date>(value);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const h24 = draft.getHours();
  const hourIndex = (h24 % 12 || 12) - 1;
  const minuteIndex = draft.getMinutes();
  const meridiemIndex = h24 >= 12 ? 1 : 0;

  const apply = (hIdx: number, mIdx: number, merIdx: number) => {
    const next = new Date(draft);
    const hour12 = HOURS[hIdx];
    const hour24 = (hour12 % 12) + (merIdx === 1 ? 12 : 0);
    next.setHours(hour24, MINUTES[mIdx], 0, 0);
    setDraft(next);
  };

  // Remounting the columns per open guarantees initialScrollIndex is honoured;
  // a FlatList that stays mounted keeps its old offset.
  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>

          <View style={styles.wheels}>
            {/* The selection band sits behind the columns, so the centre row
              * reads as chosen without a border on every item. */}
            <View pointerEvents="none" style={styles.band} />

            <Column
              base={HOURS}
              valueIndex={hourIndex}
              width={72}
              onValueIndex={(i) => apply(i, minuteIndex, meridiemIndex)}
            />
            <Text style={styles.colon}>:</Text>
            <Column
              base={MINUTES}
              valueIndex={minuteIndex}
              width={72}
              format={(v) => String(v).padStart(2, '0')}
              onValueIndex={(i) => apply(hourIndex, i, meridiemIndex)}
            />
            {/* AM/PM does not wrap: with two values, wrapping makes a flick
              * land unpredictably on either one. */}
            <Column
              base={MERIDIEMS}
              valueIndex={meridiemIndex}
              width={72}
              wrap={false}
              onValueIndex={(i) => apply(hourIndex, minuteIndex, i)}
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
