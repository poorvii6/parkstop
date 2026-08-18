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
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
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
 * wall.
 *
 * 25, not 101. The first version built a 6,000-row minute column, and while
 * FlatList virtualises the rendering it still allocates and diffs the array —
 * which is what made the wheel feel heavy to drag. Twelve cycles of headroom
 * in each direction is twelve straight hours of scrolling before an edge could
 * be reached, so nothing is lost by cutting it.
 */
const LOOPS = 25;
const MIDDLE = Math.floor(LOOPS / 2);

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
/** Every minute. Five-minute steps could not express "leaving at 6:42". */
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const MERIDIEMS = ['AM', 'PM'];

/**
 * One row, memoised.
 *
 * renderItem used to build its View and Text inline, so every row rebuilt on
 * every parent render — and the parent re-renders on each row the wheel passes.
 * Pulling the row out and memoising it means only the rows whose active state
 * actually changed do any work.
 */
const Row = React.memo(function Row({ label, active }: { label: string; active: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowText, active && styles.rowTextActive]}>{label}</Text>
    </View>
  );
});

type ColumnProps = {
  /** The values themselves, listed once. Repeating is this component's job. */
  base: (string | number)[];
  /** Index into `base` of the current value. */
  valueIndex: number;
  onValueIndex: (i: number) => void;
  format?: (v: string | number) => string;
  width: number;
};

function Column({ base, valueIndex, onValueIndex, format, width }: ColumnProps) {
  const ref = useRef<FlatList>(null);
  const settled = useRef(valueIndex);
  const selfChanged = useRef(false);

  // The repeated sequence. Memoised because rebuilding a 6,000-entry array on
  // every keystroke of the wheel would be the one genuinely slow thing here.
  const data = useMemo(
    () => Array.from({ length: base.length * LOOPS }, (_, i) => base[i % base.length]),
    [base]
  );

  const absoluteIndex = MIDDLE * base.length + valueIndex;

  // Land on the current value when the wheel opens, and follow it if it is
  // changed from outside — picking an arrival time shifts the departure along
  // with it, and the departure wheel must open on the new value, not the old.
  //
  // But NOT when this column itself caused the change. The value flows out to
  // the parent and back on every scroll that lands, and a programmatic
  // scrollToOffset arriving while the list is still settling its own snap
  // fights that animation and shows as a twitch.
  useEffect(() => {
    if (selfChanged.current) {
      selfChanged.current = false;
      return;
    }
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
    const next = abs % base.length;
    if (next !== settled.current) {
      settled.current = next;
      selfChanged.current = true;
      // A tick per row is what makes a wheel feel mechanical rather than laggy.
      Haptics.selectionAsync().catch(() => {});
      onValueIndex(next);
    }
  };

  // Only one repeat of a given value can be on screen at a time — the sequence
  // repeats every base.length rows and only five are visible — so matching
  // modulo cannot highlight two rows at once.
  const renderRow = useCallback(
    ({ item, index }: { item: string | number; index: number }) => (
      <Row
        label={format ? format(item) : String(item)}
        active={index % base.length === valueIndex}
      />
    ),
    [base.length, valueIndex, format]
  );

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
      // Virtualisation trimmed from the defaults (about twenty screens' worth),
      // which across two live columns was a lot of view churn per scroll.
      //
      // NOT removeClippedSubviews. It looks like the obvious further win and on
      // Android it detaches views the list still believes are laid out: rows
      // render at the wrong offset or not at all. It is what made the hour
      // column sit half a row below the minute column with a clipped fragment
      // at the top — the columns were never actually misaligned, one of them
      // was just drawn wrong.
      //
      // windowSize 5 rather than 3 for the same reason: 3 is tight enough that
      // a fast flick outruns the render batch and shows blanks.
      windowSize={5}
      initialNumToRender={VISIBLE + 6}
      maxToRenderPerBatch={VISIBLE + 6}
      renderItem={renderRow}
    />
  );
}

type Props = {
  visible: boolean;
  /** Heading — "Arriving" or "Leaving", so the wheel says what it is setting. */
  title: string;
  value: Date;
  /**
   * Which day the currently-drafted time will land on — "Today", "Tomorrow".
   *
   * The wheel only chooses an hour and a minute; the caller decides the date.
   * Showing that decision live is the difference between a rider understanding
   * why their booking is tomorrow and being surprised by it afterwards.
   */
  dayLabel?: (d: Date) => string;
  onCancel: () => void;
  onConfirm: (d: Date) => void;
};

export default function WheelTimePicker({ visible, title, value, dayLabel, onCancel, onConfirm }: Props) {
  // Local draft: the wheel edits a copy and nothing is applied until Set. A
  // picker that wrote straight through would reprice the booking on every row
  // the rider scrolled past.
  const [draft, setDraft] = React.useState<Date>(value);
  const wasVisible = useRef(false);

  // Seed the draft when the sheet OPENS, and only then.
  //
  // Two things had to be got right here, and the first version got both wrong.
  //
  // The dependency is value.getTime(), not value. The caller passes a freshly
  // constructed Date each render (it converts to IST inline), so depending on
  // the object meant a new reference every render — the effect ran constantly
  // and wrote the draft back to the original. Scrolling applied a new time,
  // the re-render undid it, and the wheel sprang back. The selection could
  // not stick at all.
  //
  // And it fires on the closed→open transition rather than whenever the value
  // changes, so confirming a time cannot immediately re-seed the draft from
  // the value it just set.
  const valueMs = value.getTime();
  useEffect(() => {
    if (visible && !wasVisible.current) setDraft(new Date(valueMs));
    wasVisible.current = visible;
  }, [visible, valueMs]);

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
            {/* The band sits behind the two wheels only, so the centre row
              * reads as chosen without a border on every item. */}
            <View pointerEvents="none" style={styles.band} />

            <Column
              base={HOURS}
              valueIndex={hourIndex}
              width={76}
              onValueIndex={(i) => apply(i, minuteIndex, meridiemIndex)}
            />
            <Text style={styles.colon}>:</Text>
            <Column
              base={MINUTES}
              valueIndex={minuteIndex}
              width={76}
              format={(v) => String(v).padStart(2, '0')}
              onValueIndex={(i) => apply(hourIndex, i, meridiemIndex)}
            />
          </View>

          {/* AM/PM below the wheels, as a segmented control.
            *
            * It is buttons rather than a third wheel because two rows gives a
            * scrollable range of exactly one row: a flick snaps straight back
            * and a slow drag barely registers, so PM to AM was unreachable.
            *
            * And it sits below rather than beside because a vertically centred
            * pair puts the gap between the two buttons on the selection band's
            * centre line — neither button ever lined up with the chosen row,
            * which is what read as the wheel being out of alignment. */}
          <View style={styles.meridiem}>
            {MERIDIEMS.map((m, i) => {
              const on = i === meridiemIndex;
              return (
                <TouchableOpacity
                  key={m}
                  activeOpacity={0.8}
                  onPress={() => {
                    if (on) return;
                    Haptics.selectionAsync().catch(() => {});
                    apply(hourIndex, minuteIndex, i);
                  }}
                  style={[styles.meridiemBtn, on && styles.meridiemBtnOn]}
                >
                  <Text style={[styles.meridiemText, on && styles.meridiemTextOn]}>{m}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {dayLabel ? (
            <Text style={styles.dayLabel}>{dayLabel(draft)}</Text>
          ) : null}

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
  /* Spans only the two wheels, which are now the only things in that row. */
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
  row: { height: ITEM_H, justifyContent: 'center', alignItems: 'center' },
  rowText: { color: 'rgba(255,255,255,0.32)', fontSize: 20, fontWeight: '700' },
  rowTextActive: { color: '#ffffff', fontSize: 26, fontWeight: '900' },
  meridiem: { flexDirection: 'row', gap: 10, marginTop: 16 },
  meridiemBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  meridiemBtnOn: {
    backgroundColor: 'rgba(99,102,241,0.18)',
    borderColor: '#6366f1',
  },
  meridiemText: { color: 'rgba(255,255,255,0.4)', fontWeight: '900', fontSize: 15 },
  meridiemTextOn: { color: '#ffffff' },
  dayLabel: {
    color: '#22d3ee',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 14,
  },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.05)' },
  btnGhostText: { color: '#94a3b8', fontWeight: '900', fontSize: 14 },
  btnPrimary: { backgroundColor: '#6366f1' },
  btnPrimaryText: { color: '#fff', fontWeight: '900', fontSize: 14 },
});
