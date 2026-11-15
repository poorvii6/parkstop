/**
 * Admin — the per-spot verification queue.
 *
 * THE ORDER IS THE QUEUE, NOT A SUGGESTION. The server returns rows oldest
 * first and carries each one's wait, and this screen shows them in that order
 * without re-sorting. We promise an owner 48 hours; a promise nobody measures
 * is one we break quietly, so every row says how long it has been waiting and
 * whether that is still inside the promise.
 *
 * FOUR LISTS, and the fourth is deliberately kept apart:
 *
 *   All       everything waiting on a human, both stages
 *   Desk      a document nobody has read yet
 *   Field     read, and waiting for someone to go to the registrar. NOT live
 *   Backlog   spots that were already in the finder when this shipped. Nobody
 *             promised them 48 hours, so counting them would open the feature
 *             with a queue full of breaches that mean nothing. They are
 *             visible and unchecked, which is work to get through, not a
 *             broken promise.
 *
 * Nothing here computes an SLA band or a status. `sla`, `waiting_hours` and
 * `hours_left` all come from SpotVerificationPolicy, so this screen and the
 * owner's screen cannot disagree about the same spot.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SC } from '../../constants/SpotterTheme';
import { labelForDocType } from '../../constants/propertyDocTypes';
import {
  spotVerificationAdmin, errorText, SLA_LABEL,
  type Queue, type QueueRow, type Backlog, type BacklogRow, type Sla,
} from '../../api/spotVerificationAdmin';

type TabKey = 'all' | 'desk' | 'field' | 'backlog';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'desk', label: 'Desk' },
  { key: 'field', label: 'Field' },
  { key: 'backlog', label: 'Backlog' },
];

const SLA_COLOUR: Record<Sla, string> = {
  not_waiting: SC.textSecondary,
  ok: SC.success,
  at_risk: SC.warning,
  overdue: SC.error,
};

export default function AdminSpotVerifications() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('all');
  const [queue, setQueue] = useState<Queue | null>(null);
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (t: TabKey) => {
    setLoading(true);
    setError('');
    try {
      if (t === 'backlog') setBacklog(await spotVerificationAdmin.backlog());
      else setQueue(await spotVerificationAdmin.queue(t === 'all' ? undefined : t));
    } catch (e) {
      setError(errorText(e, 'Could not load the queue.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(tab); }, [tab, load]));

  const open = (spotId: number) => router.push(`/admin/spot-verification/${spotId}` as any);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Spot verifications</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={s.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={[s.tab, tab === t.key && s.tabOn]} onPress={() => setTab(t.key)}>
            <Text style={[s.tabText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab !== 'backlog' && queue ? <Counts q={queue} /> : null}
      {tab === 'backlog' && backlog ? <BacklogNote b={backlog} /> : null}

      {error ? <Text style={s.error}>{error}</Text> : null}

      {tab === 'backlog' ? (
        <FlatList
          data={backlog?.items || []}
          keyExtractor={(r) => String(r.spot_id)}
          contentContainerStyle={s.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(tab)} tintColor={SC.accent} />}
          ListEmptyComponent={!loading ? <Empty text="The backlog is clear." /> : <Spinner />}
          renderItem={({ item }) => <BacklogCard row={item} onPress={() => open(item.spot_id)} />}
        />
      ) : (
        <FlatList
          data={queue?.items || []}
          keyExtractor={(r) => String(r.spot_id)}
          contentContainerStyle={s.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(tab)} tintColor={SC.accent} />}
          ListEmptyComponent={!loading ? <Empty text="Nothing waiting. The queue is empty." /> : <Spinner />}
          renderItem={({ item }) => <QueueCard row={item} onPress={() => open(item.spot_id)} />}
        />
      )}
    </SafeAreaView>
  );
}

/** The promise, and how we are doing against it. */
function Counts({ q }: { q: Queue }) {
  return (
    <View style={s.counts}>
      <Count n={q.counts.total} label="Waiting" />
      <Count n={q.counts.desk} label="Desk" />
      <Count n={q.counts.field} label="Field" />
      <Count n={q.counts.at_risk} label={`Past ${q.at_risk_after_hours}h`} colour={q.counts.at_risk ? SC.warning : undefined} />
      <Count n={q.counts.overdue} label={`Past ${q.promised_hours}h`} colour={q.counts.overdue ? SC.error : undefined} />
    </View>
  );
}

function Count({ n, label, colour }: { n: number; label: string; colour?: string }) {
  return (
    <View style={s.count}>
      <Text style={[s.countN, colour ? { color: colour } : null]}>{n}</Text>
      <Text style={s.countLabel}>{label}</Text>
    </View>
  );
}

function BacklogNote({ b }: { b: Backlog }) {
  return (
    <View style={s.backlogNote}>
      <Ionicons name="information-circle" size={17} color={SC.info} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={s.backlogNoteText}>{b.note}</Text>
        <Text style={s.backlogNoteSub}>
          {b.count} to chase · {b.submitted_and_in_the_queue} have since submitted and are in the
          ordinary queue
        </Text>
      </View>
    </View>
  );
}

function QueueCard({ row, onPress }: { row: QueueRow; onPress: () => void }) {
  const colour = SLA_COLOUR[row.sla] || SC.textSecondary;

  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.85}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle} numberOfLines={1}>{row.title || `Spot ${row.spot_id}`}</Text>
        <View style={[s.pill, { backgroundColor: `${colour}22`, borderColor: `${colour}66` }]}>
          <Text style={[s.pillText, { color: colour }]}>
            {row.stage === 'desk' ? 'Desk' : 'Field'}
          </Text>
        </View>
      </View>

      <Text style={s.cardAddress} numberOfLines={2}>{row.claimed_address || 'No address submitted'}</Text>

      <View style={s.cardMeta}>
        <Text style={s.metaText}>{labelForDocType(row.doc_type) || 'No document'}</Text>
        {row.relationship === 'tenant' ? (
          <Text style={[s.metaText, { color: SC.warning }]}>· Rented</Text>
        ) : null}
      </View>

      <View style={s.cardFoot}>
        <View style={{ flex: 1 }}>
          <Text style={s.ownerName} numberOfLines={1}>
            {row.owner?.name || 'Unknown owner'}
            {row.owner && !row.owner.person_verified ? ' · person NOT verified' : ''}
          </Text>
        </View>
        {/* The wait and the band, both computed on the server. */}
        <Text style={[s.sla, { color: colour }]}>
          {row.waiting_hours !== null ? `${row.waiting_hours}h · ${SLA_LABEL[row.sla]}` : SLA_LABEL[row.sla]}
        </Text>
      </View>

      {row.sla === 'overdue' && row.overdue_by_hours !== null ? (
        <Text style={s.overdue}>Past the promise by {row.overdue_by_hours}h</Text>
      ) : null}
    </TouchableOpacity>
  );
}

function BacklogCard({ row, onPress }: { row: BacklogRow; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.85}>
      <View style={s.cardTop}>
        <Text style={s.cardTitle} numberOfLines={1}>{row.title || `Spot ${row.spot_id}`}</Text>
        <View style={[s.pill, { backgroundColor: SC.infoSoft, borderColor: `${SC.info}66` }]}>
          <Text style={[s.pillText, { color: SC.info }]}>Live, unchecked</Text>
        </View>
      </View>

      <Text style={s.cardAddress} numberOfLines={2}>
        {row.claimed_address || row.spot_address || 'No address'}
      </Text>

      <View style={s.cardMeta}>
        <Text style={s.metaText}>
          {row.has_document ? 'Document uploaded, not submitted' : 'No document yet'}
        </Text>
      </View>

      <View style={s.cardFoot}>
        <Text style={s.ownerName} numberOfLines={1}>
          {row.owner?.name || 'Unknown owner'}
          {row.owner?.phone ? ` · ${row.owner.phone}` : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const Spinner = () => <ActivityIndicator color={SC.accent} style={{ marginTop: 40 }} size="large" />;
const Empty = ({ text }: { text: string }) => <Text style={s.empty}>{text}</Text>;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', flex: 1, textAlign: 'center' },

  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 12, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border, alignItems: 'center' },
  tabOn: { backgroundColor: SC.accent, borderColor: SC.accent },
  tabText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13 },

  counts: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  count: { flex: 1, backgroundColor: SC.bgCard, borderRadius: 12, borderWidth: 1, borderColor: SC.border, paddingVertical: 10, alignItems: 'center' },
  countN: { color: SC.textPrimary, fontSize: 18, fontWeight: '800' },
  countLabel: { color: SC.textSecondary, fontSize: 10, fontWeight: '700', marginTop: 2 },

  backlogNote: {
    flexDirection: 'row', gap: 9, marginHorizontal: 16, marginBottom: 14, padding: 13,
    backgroundColor: SC.infoSoft, borderRadius: 14, borderWidth: 1, borderColor: `${SC.info}44`,
  },
  backlogNoteText: { color: SC.textPrimary, fontSize: 12.5, lineHeight: 18 },
  backlogNoteSub: { color: SC.textSecondary, fontSize: 11.5, marginTop: 5 },

  list: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  card: { backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 15 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: SC.textPrimary, fontSize: 15.5, fontWeight: '800', flex: 1 },
  pill: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  pillText: { fontSize: 11, fontWeight: '800' },
  cardAddress: { color: SC.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 7 },
  cardMeta: { flexDirection: 'row', gap: 6, marginTop: 7, flexWrap: 'wrap' },
  metaText: { color: SC.textSecondary, fontSize: 11.5, fontWeight: '700' },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 11, borderTopWidth: 1, borderTopColor: SC.border, paddingTop: 10 },
  ownerName: { color: SC.textPrimary, fontSize: 12.5, fontWeight: '600' },
  sla: { fontSize: 12, fontWeight: '800' },
  overdue: { color: SC.error, fontSize: 11.5, fontWeight: '700', marginTop: 7 },

  error: { color: SC.error, paddingHorizontal: 16, paddingBottom: 10, fontSize: 13 },
  empty: { color: SC.textSecondary, textAlign: 'center', marginTop: 50, fontSize: 14 },
});
