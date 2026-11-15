/**
 * Admin — reviewing ONE spot's property verification.
 *
 * Two stages, in order, and only the second can make a spot live. The screen
 * shows whichever is next and nothing else, so a reviewer is never offered a
 * field result on a document nobody has read.
 *
 * WHAT THIS SCREEN WILL NOT DO:
 *
 *   It does not recompute a verdict. Every band, distance and blocker comes
 *   from the server and is rendered as given — `explanation` is a sentence
 *   written in SpotVerificationPolicy, not assembled here. Widening a band on
 *   a phone would silently disagree with what was stored against decisions
 *   already taken.
 *
 *   It does not decide whether a blocker can be waved. The server marks the
 *   ones that cannot (`final`), because they are missing FACTS rather than
 *   judgement calls: a consent letter that names this owner, and the transfer
 *   document behind a dead holder's khata. Those are cleared by supplying the
 *   fact, never by writing a reason.
 *
 *   It does not let an admin review their own spot. The server refuses both
 *   decisions outright; this hides the controls so nobody drafts a decision
 *   that is going to be thrown away.
 *
 * AND THE ONE THING IT SAYS OUT LOUD: a desk review cannot tell you whether a
 * document is genuine. A good forgery passes it. That is the whole reason the
 * field check exists, and the reviewer is reminded of it at the point of
 * deciding rather than in a wiki nobody reads.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, RefreshControl, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { SC } from '../../../constants/SpotterTheme';
import { labelForDocType, INHERITANCE_DOC_TYPES } from '../../../constants/propertyDocTypes';
import {
  spotVerificationAdmin, errorText, blockersFrom, cannotOverride, howToProceed, alsoUsedFor,
  SLA_LABEL, NAME_VERDICT_LABEL, ADDRESS_VERDICT_LABEL,
  type SpotDetail, type CheckResult, type Blocker,
} from '../../../api/spotVerificationAdmin';

export default function AdminSpotVerification() {
  const router = useRouter();
  const { spotId: raw } = useLocalSearchParams<{ spotId: string }>();
  const spotId = Number(raw);

  const [d, setD] = useState<SpotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (!Number.isInteger(spotId)) { setError('That spot could not be found.'); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      setD(await spotVerificationAdmin.detail(spotId));
      setError('');
    } catch (e) {
      setError(errorText(e, 'Could not load this submission.'));
    } finally {
      setLoading(false);
    }
  }, [spotId]);

  useFocusEffect(useCallback(() => { load(true); }, [load]));

  if (loading && !d) {
    return (
      <Shell title="Review spot" onBack={() => router.back()}>
        <ActivityIndicator color={SC.accent} size="large" style={{ marginTop: 60 }} />
      </Shell>
    );
  }
  if (!d) {
    return (
      <Shell title="Review spot" onBack={() => router.back()}>
        <Text style={s.error}>{error || 'Could not load this submission.'}</Text>
      </Shell>
    );
  }

  const stage = d.submission.status === 'desk_pending' ? 'desk'
    : d.submission.status === 'desk_approved' ? 'field'
      : 'done';

  return (
    <Shell
      title={d.spot.title || `Spot ${spotId}`}
      onBack={() => router.back()}
      onRefresh={() => load(true)}
    >
      <StatusStrip d={d} />
      {error ? <Text style={s.error}>{error}</Text> : null}

      {d.independence.reviewer_is_the_owner ? (
        <Banner tone="error" icon="hand-left">
          This spot belongs to you. Another admin has to check it — the server refuses both
          decisions from you, at both stages.
        </Banner>
      ) : null}

      <Submission d={d} />
      <OwnerCard d={d} />
      <SameDocument d={d} />

      {stage === 'desk' ? (
        <DeskStage spotId={spotId} d={d} onDone={() => load(true)} />
      ) : null}

      {stage === 'field' ? (
        <FieldStage spotId={spotId} d={d} onDone={() => load(true)} />
      ) : null}

      {/* What was already found, whichever stage we are at. */}
      <StoredDesk d={d} />
      {d.field.checked_at ? <StoredField d={d} /> : null}
      <Independence d={d} />
      <ReviewLog d={d} />
    </Shell>
  );
}

// ─────────────────────────────── chrome ───────────────────────────────

function Shell({
  title, onBack, onRefresh, children,
}: {
  title: string; onBack: () => void; onRefresh?: () => void; children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh
          ? <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={SC.accent} />
          : undefined}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {note ? <Text style={s.sectionNote}>{note}</Text> : null}
      {children}
    </View>
  );
}

function Row({ k, v }: { k: string; v?: any }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v} selectable>{v === null || v === undefined || v === '' ? '—' : String(v)}</Text>
    </View>
  );
}

function Banner({
  tone, icon, children,
}: {
  tone: 'error' | 'warn' | 'info'; icon: any; children: React.ReactNode;
}) {
  const colour = tone === 'error' ? SC.error : tone === 'warn' ? SC.warning : SC.info;
  const bg = tone === 'error' ? SC.errorSoft : tone === 'warn' ? SC.warningSoft : SC.infoSoft;
  return (
    <View style={[s.banner, { backgroundColor: bg, borderColor: `${colour}55` }]}>
      <Ionicons name={icon} size={17} color={colour} style={{ marginTop: 1 }} />
      <Text style={s.bannerText}>{children}</Text>
    </View>
  );
}

// ───────────────────────────── the submission ─────────────────────────────

function StatusStrip({ d }: { d: SpotDetail }) {
  const sla = d.submission.sla;
  const colour = sla === 'overdue' ? SC.error : sla === 'at_risk' ? SC.warning : sla === 'ok' ? SC.success : SC.textSecondary;

  return (
    <View style={s.strip}>
      <View style={{ flex: 1 }}>
        <Text style={s.stripStatus}>{d.submission.status.replace(/_/g, ' ')}</Text>
        <Text style={s.stripVisible}>
          Drivers see: {d.spot.visible_to_drivers?.replace(/_/g, ' ') || 'nothing'}
        </Text>
      </View>
      {d.submission.waiting_hours !== null ? (
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.stripWait, { color: colour }]}>{d.submission.waiting_hours}h</Text>
          <Text style={[s.stripSla, { color: colour }]}>{SLA_LABEL[sla]}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Submission({ d }: { d: SpotDetail }) {
  const sub = d.submission;

  /**
   * A PDF opens in the browser; a photo renders inline.
   *
   * doc_preview_url is page 1 rasterised for a PDF and the image itself for a
   * photo, so the <Image> below always has something it can draw. doc_url is
   * the file, and React Native cannot render a PDF — hence the separate
   * "Open" action rather than trying.
   */
  const open = async (url: string | null) => {
    if (!url) return;
    try { await WebBrowser.openBrowserAsync(url); }
    catch { Linking.openURL(url).catch(() => {}); }
  };

  return (
    <Section title="The submission">
      <Row k="Document" v={labelForDocType(sub.doc_type)} />
      <Row k="Address on it" v={sub.claimed_address} />
      <Row k="Holds it as" v={sub.relationship === 'tenant' ? 'Tenant (rented)' : 'Owner'} />
      {sub.relationship === 'tenant' ? <Row k="Landlord" v={sub.landlord_name} /> : null}
      <Row k="Spot pin" v={`${d.spot.latitude ?? '—'}, ${d.spot.longitude ?? '—'}`} />
      <Row k="Listing address" v={d.spot.address_on_listing} />

      {sub.doc_preview_url ? (
        <TouchableOpacity onPress={() => open(sub.doc_url)} activeOpacity={0.85} style={{ marginTop: 12 }}>
          <Image source={{ uri: sub.doc_preview_url }} style={s.doc} resizeMode="contain" />
          <View style={s.docFoot}>
            <Ionicons name={sub.doc_is_pdf ? 'document-text' : 'image'} size={15} color={SC.accent} />
            <Text style={s.docFootText}>
              {sub.doc_is_pdf
                ? 'PDF · showing page 1 — tap to open the full document'
                : 'Tap to open full size'}
            </Text>
          </View>
        </TouchableOpacity>
      ) : (
        <Text style={s.none}>No document uploaded.</Text>
      )}

      {sub.landlord_noc_preview_url ? (
        <TouchableOpacity onPress={() => open(sub.landlord_noc_url)} activeOpacity={0.85} style={{ marginTop: 14 }}>
          <Text style={s.subLabel}>Landlord&apos;s consent letter</Text>
          <Image source={{ uri: sub.landlord_noc_preview_url }} style={s.doc} resizeMode="contain" />
          <View style={s.docFoot}>
            <Ionicons name={sub.landlord_noc_is_pdf ? 'document-text' : 'image'} size={15} color={SC.accent} />
            <Text style={s.docFootText}>
              {sub.landlord_noc_is_pdf ? 'PDF · page 1 — tap to open' : 'Tap to open full size'}
            </Text>
          </View>
        </TouchableOpacity>
      ) : null}
    </Section>
  );
}

function OwnerCard({ d }: { d: SpotDetail }) {
  const o = d.owner;
  if (!o) return null;

  return (
    <Section title="The owner">
      <Row k="Name" v={o.name} />
      <Row k="Aadhaar name" v={o.aadhaar_name} />
      <Row k="Email" v={o.email} />
      <Row k="Phone" v={o.phone} />
      {!o.person_verified ? (
        <Banner tone="error" icon="alert-circle">
          This person is not verified. A place is verified in a PERSON&apos;s name, so there is no
          name to check the document against — verify the person first. This one does not yield to
          an override.
        </Banner>
      ) : null}
      {o.person_property_address ? (
        <>
          <Row k="Address they gave at KYC" v={o.person_property_address} />
          <Text style={s.hint}>
            That was collected once for the whole account under the old flow and was never compared
            to any spot. It is not evidence about THIS address.
          </Text>
        </>
      ) : null}
    </Section>
  );
}

/**
 * The same file on other spots.
 *
 * Reuse at a different address is refused at upload, so anything listed here
 * is either at the same address — allowed, one plot with several bays — or
 * predates the check. Worth a look either way: four spots sharing one khata at
 * one address should make a reviewer confirm four bays really exist rather
 * than one bay listed four times.
 */
function SameDocument({ d }: { d: SpotDetail }) {
  const rows = d.submission.same_document_on;
  if (!rows?.length) return null;

  return (
    <Section
      title="The same document elsewhere"
      note="Reuse at a different address is refused at upload. Same address is allowed — but check that the bays exist."
    >
      {rows.map((r) => (
        <View key={r.spot_id} style={s.dupRow}>
          <Ionicons
            name={r.same_address ? 'copy-outline' : 'warning'}
            size={16}
            color={r.same_address ? SC.textSecondary : SC.error}
            style={{ marginTop: 2 }}
          />
          <View style={{ flex: 1 }}>
            <Text style={s.dupTitle}>{r.title || `Spot ${r.spot_id}`} · {r.status.replace(/_/g, ' ')}</Text>
            <Text style={s.dupAddress}>{r.claimed_address || 'No address'}</Text>
            <Text style={[s.dupTag, !r.same_address && { color: SC.error }]}>
              {r.same_address ? 'Same address' : 'DIFFERENT address'}
              {r.same_owner ? ' · same owner' : ' · another owner'}
            </Text>
          </View>
        </View>
      ))}
    </Section>
  );
}

// ─────────────────────────────── desk stage ───────────────────────────────

function DeskStage({ spotId, d, onDone }: { spotId: number; d: SpotDetail; onDone: () => void }) {
  const [name, setName] = useState(d.desk.name_on_document || '');
  const [checks, setChecks] = useState<CheckResult | null>(null);
  const [nocNamesOwner, setNocNamesOwner] = useState<boolean | null>(d.desk.noc_names_owner);
  const [inheritance, setInheritance] = useState<string | null>(d.desk.inheritance_doc_type);
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [finals, setFinals] = useState<string[]>([]);
  const [proceed, setProceed] = useState<string | null>(null);

  const mine = d.independence.reviewer_is_the_owner;
  const isTenant = d.submission.relationship === 'tenant' || d.submission.doc_type === 'rent_agreement';
  const deceased = !!checks?.name?.deceased_holder;

  const body = () => ({
    name_on_document: name.trim() || undefined,
    ...(isTenant && nocNamesOwner !== null ? { noc_names_owner: nocNamesOwner } : {}),
    ...(inheritance ? { inheritance_document: inheritance } : {}),
  });

  const runChecks = async () => {
    setBusy(true); setErr(''); setBlockers([]); setFinals([]); setProceed(null);
    try {
      const r = await spotVerificationAdmin.check(spotId, body());
      setChecks(r);
      setBlockers(r.blockers);
      setFinals(r.cannot_be_overridden);
    } catch (e) {
      setErr(errorText(e, 'Could not run the checks.'));
    } finally { setBusy(false); }
  };

  const pass = async () => {
    setBusy(true); setErr(''); setBlockers([]); setFinals([]); setProceed(null);
    try {
      await spotVerificationAdmin.desk(spotId, {
        decision: 'pass',
        ...body(),
        ...(override.trim() ? { override_reason: override.trim() } : {}),
      });
      Alert.alert(
        'Desk review passed',
        'This spot is NOT live. It is waiting for the field check — the only step that can publish it.'
      );
      onDone();
    } catch (e) {
      setErr(errorText(e, 'Could not record the decision.'));
      setBlockers(blockersFrom(e));
      setFinals(cannotOverride(e));
      setProceed(howToProceed(e));
    } finally { setBusy(false); }
  };

  const reject = async () => {
    if (reason.trim().length < 10) {
      setErr('Give the owner a clear reason they can act on (at least 10 characters).');
      return;
    }
    setBusy(true); setErr('');
    try {
      await spotVerificationAdmin.desk(spotId, { decision: 'reject', reason: reason.trim() });
      Alert.alert('Sent back', 'The owner has been told what to fix and can submit again.');
      onDone();
    } catch (e) {
      setErr(errorText(e, 'Could not send it back.'));
    } finally { setBusy(false); }
  };

  if (mine) return null;

  return (
    <Section title="Desk review — read the document">
      <Banner tone="warn" icon="eye-off">
        These checks cannot tell you whether the document is genuine. A good forgery passes a desk
        review — that is exactly why the field check exists.
      </Banner>

      <Text style={s.label}>
        The name printed on the document
        {isTenant ? ' (this should be the LANDLORD\'s name)' : ''}
      </Text>
      <TextInput
        style={s.input}
        value={name}
        onChangeText={(t) => { setName(t); setErr(''); }}
        placeholder={isTenant ? 'As printed — the landlord owns the place' : 'As printed on the document'}
        placeholderTextColor={SC.textDisabled}
        maxLength={150}
        autoCapitalize="words"
      />
      {isTenant ? (
        <Text style={s.hint}>
          This spot is rented, so the ownership document is the landlord&apos;s. It is compared to
          the name on the consent letter, not to the owner&apos;s Aadhaar.
        </Text>
      ) : null}

      <TouchableOpacity style={s.secondary} onPress={runChecks} disabled={busy}>
        {busy ? <ActivityIndicator color={SC.accent} /> : (
          <>
            <Ionicons name="calculator-outline" size={17} color={SC.accent} />
            <Text style={s.secondaryText}>Run the checks</Text>
          </>
        )}
      </TouchableOpacity>

      {checks ? <CheckReadout checks={checks} /> : null}

      {/* A tenant's letter: a fact only a human can supply. */}
      {isTenant ? (
        <>
          <Text style={s.label}>Does the consent letter name THIS owner and this address?</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {[{ v: true, l: 'Yes, it names them' }, { v: false, l: 'No, it does not' }].map((o) => (
              <TouchableOpacity
                key={String(o.v)}
                style={[s.choice, nocNamesOwner === o.v && s.choiceOn]}
                onPress={() => setNocNamesOwner(o.v)}
              >
                <Ionicons
                  name={nocNamesOwner === o.v ? 'radio-button-on' : 'radio-button-off'}
                  size={17}
                  color={nocNamesOwner === o.v ? SC.accent : SC.textSecondary}
                />
                <Text style={[s.choiceText, nocNamesOwner === o.v && { color: SC.textPrimary }]}>{o.l}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.hint}>
            A written reason cannot stand in for this. Either the letter names them or it does not.
          </Text>
        </>
      ) : null}

      {/* A dead holder: cleared by naming the transfer document, not by a note. */}
      {deceased ? (
        <>
          <Banner tone="warn" icon="alert-circle">
            The document names a LATE holder. However well the name matches, it does not show the
            applicant owns the property now — an inherited khata is common here, and sons often
            carry the father&apos;s name.
          </Banner>
          <Text style={s.label}>Which transfer document are you holding?</Text>
          {INHERITANCE_DOC_TYPES.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[s.choiceWide, inheritance === t.key && s.choiceOn]}
              onPress={() => setInheritance(t.key)}
            >
              <Ionicons
                name={inheritance === t.key ? 'radio-button-on' : 'radio-button-off'}
                size={17}
                color={inheritance === t.key ? SC.accent : SC.textSecondary}
              />
              <Text style={[s.choiceText, inheritance === t.key && { color: SC.textPrimary }]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
          <Text style={s.hint}>
            Naming the document you are holding is a statement of fact, recorded against this spot.
            A written note is not accepted for this.
          </Text>
        </>
      ) : null}

      {blockers.length ? <Blockers blockers={blockers} finals={finals} proceed={proceed} /> : null}

      {/* An override is for judgement calls only, and only when one is raised. */}
      {blockers.some((b) => !b.final) ? (
        <>
          <Text style={s.label}>Passing it anyway? Say why (recorded against the spot)</Text>
          <TextInput
            style={[s.input, { minHeight: 76, textAlignVertical: 'top' }]}
            value={override}
            onChangeText={setOverride}
            placeholder="What you checked, and why this is still the same place and person"
            placeholderTextColor={SC.textDisabled}
            multiline
            maxLength={500}
          />
        </>
      ) : null}

      {err ? <Text style={s.error}>{err}</Text> : null}

      <TouchableOpacity style={[s.primary, busy && { opacity: 0.5 }]} onPress={pass} disabled={busy}>
        <Text style={s.primaryText}>Pass the desk review</Text>
      </TouchableOpacity>
      <Text style={s.hint}>
        A pass sends this to the field check. It does NOT make the spot visible to drivers.
      </Text>

      <Text style={s.label}>Or send it back to the owner</Text>
      <TextInput
        style={[s.input, { minHeight: 76, textAlignVertical: 'top' }]}
        value={reason}
        onChangeText={(t) => { setReason(t); setErr(''); }}
        placeholder="What the owner needs to fix. They see this exactly as written."
        placeholderTextColor={SC.textDisabled}
        multiline
        maxLength={500}
      />
      <TouchableOpacity style={[s.danger, busy && { opacity: 0.5 }]} onPress={reject} disabled={busy}>
        <Text style={s.dangerText}>Send back with a reason</Text>
      </TouchableOpacity>
    </Section>
  );
}

/** What the checks found. Every sentence is the server's. */
function CheckReadout({ checks }: { checks: CheckResult }) {
  const n = checks.name;
  const a = checks.address;

  const nameColour = n && ['DIRECT_MATCH', 'GOOD_PARTIAL_MATCH'].includes(n.verdict) ? SC.success
    : n && n.verdict === 'MODERATE_PARTIAL_MATCH' ? SC.warning : SC.error;
  const addrColour = a.verdict === 'consistent' ? SC.success
    : a.verdict === 'mismatch' || a.verdict === 'unresolved' ? SC.error : SC.warning;

  return (
    <View style={s.readout}>
      {n ? (
        <View style={s.readRow}>
          <Text style={[s.readPill, { color: nameColour, borderColor: `${nameColour}66`, backgroundColor: `${nameColour}18` }]}>
            {NAME_VERDICT_LABEL[n.verdict] || n.verdict}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={s.readWhat}>
              &ldquo;{n.name_on_document}&rdquo; vs &ldquo;{n.expected_name || '—'}&rdquo;
            </Text>
            <Text style={s.readWhy}>{n.explanation}</Text>
            {n.note ? <Text style={s.readNote}>{n.note}</Text> : null}
            <Text style={s.readMeta}>
              Checked against {n.checked_against === 'landlord_name' ? 'the landlord\'s name' : 'the Aadhaar name'}
              {n.via_variant ? (n.weak_variant ? ' · WEAK spelling match' : ' · spelling variant') : ''}
              {n.exact_full_matches === 0 && n.matched > 0 ? ' · initials only' : ''}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={s.none}>Type the name on the document to compare it.</Text>
      )}

      <View style={s.readRow}>
        <Text style={[s.readPill, { color: addrColour, borderColor: `${addrColour}66`, backgroundColor: `${addrColour}18` }]}>
          {ADDRESS_VERDICT_LABEL[a.verdict] || a.verdict}
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={s.readWhat}>
            {a.metres !== null ? `${a.metres} m from the pin` : 'Not found on the map'}
          </Text>
          {/* The sentence that makes the number readable. */}
          <Text style={s.readWhy}>{a.explanation}</Text>
          <Text style={s.readMeta}>
            {a.resolved_to ? `Resolved to: ${a.resolved_to}` : 'Nothing resolved'}
            {a.precision ? ` · ${a.precision}` : ''}
            {a.uncertainty_m ? ` ±${a.uncertainty_m} m` : ''}
            {a.source ? ` · ${a.source}` : ''}
          </Text>
        </View>
      </View>

      <Text style={s.reminder}>{checks.reminder}</Text>
    </View>
  );
}

function Blockers({ blockers, finals, proceed }: { blockers: Blocker[]; finals: string[]; proceed: string | null }) {
  return (
    <View style={s.blockers}>
      <Text style={s.blockersTitle}>This cannot pass as it stands</Text>
      {blockers.map((b) => {
        const isFinal = b.final || finals.includes(b.code);
        return (
          <View key={b.code} style={s.blockerRow}>
            <Ionicons
              name={isFinal ? 'lock-closed' : 'alert-circle-outline'}
              size={15}
              color={isFinal ? SC.error : SC.warning}
              style={{ marginTop: 2 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={s.blockerText}>{b.message}</Text>
              {isFinal ? (
                <Text style={s.blockerFinal}>
                  A written reason will not clear this — it needs the fact itself.
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {proceed ? <Text style={s.proceed}>{proceed}</Text> : null}
    </View>
  );
}

// ─────────────────────────────── field stage ───────────────────────────────

/**
 * The field check: our team went to the regional office.
 *
 * The only thing in the flow that can make a spot live, and the only step that
 * tests something a forger cannot print. A result is recorded either way — "we
 * went and found nothing" is a finding, written down with the office so the
 * next person does not repeat the visit.
 */
function FieldStage({ spotId, d, onDone }: { spotId: number; d: SpotDetail; onDone: () => void }) {
  const [office, setOffice] = useState(d.field.office || '');
  const [found, setFound] = useState<boolean | null>(null);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dupes, setDupes] = useState<{ spot_id: number; claimed_address?: string | null }[]>([]);

  if (d.independence.reviewer_is_the_owner) return null;

  const save = async () => {
    if (found === null) { setErr('Say whether the record was found.'); return; }
    setBusy(true); setErr(''); setDupes([]);
    try {
      await spotVerificationAdmin.field(spotId, {
        record_found: found,
        office: office.trim(),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(found ? {} : { reason: reason.trim() }),
      });
      Alert.alert(
        found ? 'Spot verified and live' : 'Recorded: no record found',
        found
          ? 'Drivers can see and book it now.'
          : 'The owner has been told, with the reason you gave.'
      );
      onDone();
    } catch (e) {
      setErr(errorText(e, 'Could not record the field check.'));
      setDupes(alsoUsedFor(e));
    } finally { setBusy(false); }
  };

  return (
    <Section
      title="Field check — the registrar's record"
      note="The only step that can make this spot live, and the only one a forger cannot simply print."
    >
      <Text style={s.label}>Which office was checked?</Text>
      <TextInput
        style={s.input}
        value={office}
        onChangeText={(t) => { setOffice(t); setErr(''); }}
        placeholder="e.g. Sub-Registrar Office, Indiranagar"
        placeholderTextColor={SC.textDisabled}
        maxLength={120}
      />

      <Text style={s.label}>Was the record found?</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {[{ v: true, l: 'Yes, found it' }, { v: false, l: 'No record' }].map((o) => (
          <TouchableOpacity
            key={String(o.v)}
            style={[s.choice, found === o.v && s.choiceOn]}
            onPress={() => { setFound(o.v); setErr(''); }}
          >
            <Ionicons
              name={found === o.v ? 'radio-button-on' : 'radio-button-off'}
              size={17}
              color={found === o.v ? SC.accent : SC.textSecondary}
            />
            <Text style={[s.choiceText, found === o.v && { color: SC.textPrimary }]}>{o.l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={s.label}>
        Registration reference{found === false ? ' (what you searched for)' : ''}
      </Text>
      <TextInput
        style={s.input}
        value={reference}
        onChangeText={(t) => { setReference(t); setErr(''); }}
        placeholder="The reference for the record"
        placeholderTextColor={SC.textDisabled}
        maxLength={100}
      />
      {found ? (
        <Text style={s.hint}>
          Required on a pass — without one there is nothing for anyone to check again later. One
          reference cannot verify two different addresses.
        </Text>
      ) : null}

      <Text style={s.label}>Notes — INTERNAL, never shown to the owner</Text>
      <TextInput
        style={[s.input, { minHeight: 76, textAlignVertical: 'top' }]}
        value={notes}
        onChangeText={setNotes}
        placeholder="What the clerk said, what you checked, anything the next person needs"
        placeholderTextColor={SC.textDisabled}
        multiline
        maxLength={1000}
      />
      <Text style={s.hint}>
        These stay inside ParkStop. The owner sees only the reason below.
      </Text>

      {found === false ? (
        <>
          <Text style={s.label}>The reason the owner sees</Text>
          <TextInput
            style={[s.input, { minHeight: 76, textAlignVertical: 'top' }]}
            value={reason}
            onChangeText={(t) => { setReason(t); setErr(''); }}
            placeholder="Something they can act on, in plain words"
            placeholderTextColor={SC.textDisabled}
            multiline
            maxLength={500}
          />
        </>
      ) : null}

      {err ? <Text style={s.error}>{err}</Text> : null}

      {dupes.length ? (
        <View style={s.blockers}>
          <Text style={s.blockersTitle}>That reference is already recorded elsewhere</Text>
          {dupes.map((x) => (
            <Text key={x.spot_id} style={s.blockerText}>
              • Spot {x.spot_id} — {x.claimed_address || 'no address'}
            </Text>
          ))}
          <Text style={s.proceed}>
            One property record cannot describe two places. If both spots really are at that one
            property, their addresses should match.
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[found === false ? s.danger : s.primary, busy && { opacity: 0.5 }]}
        onPress={save}
        disabled={busy}
      >
        <Text style={found === false ? s.dangerText : s.primaryText}>
          {found === false ? 'Record: no record found' : 'Record the check and publish'}
        </Text>
      </TouchableOpacity>
    </Section>
  );
}

// ───────────────────────── what is already recorded ─────────────────────────

function StoredDesk({ d }: { d: SpotDetail }) {
  if (!d.desk.reviewed_at && !d.desk.name_on_document) return null;

  return (
    <Section title="Desk review — what was found">
      <Row k="Name on document" v={d.desk.name_on_document} />
      <Row k="Name verdict" v={NAME_VERDICT_LABEL[d.desk.name_match || ''] || d.desk.name_match} />
      {/* Without this, name_match is unreadable: a DIRECT_MATCH means the
          OWNER on an owner-occupied spot and the LANDLORD on a rented one. */}
      <Row
        k="Compared against"
        v={d.desk.name_checked_against === 'landlord_name' ? 'The landlord\'s name'
          : d.desk.name_checked_against === 'aadhaar_name' ? 'The Aadhaar name' : null}
      />
      {d.desk.noc_names_owner !== null ? (
        <Row k="Letter names the owner" v={d.desk.noc_names_owner ? 'Confirmed' : 'No'} />
      ) : null}
      {d.desk.inheritance_doc_type ? (
        <Row k="Transfer document seen" v={labelForDocType(d.desk.inheritance_doc_type)} />
      ) : null}
      <Row k="Address vs pin" v={d.desk.address_match_metres !== null ? `${d.desk.address_match_metres} m` : null} />
      <Row k="Address verdict" v={ADDRESS_VERDICT_LABEL[d.desk.address_match_verdict || ''] || d.desk.address_match_verdict} />
      {d.desk.reading ? <Text style={s.hint}>{d.desk.reading}</Text> : null}
      <Row k="Resolved by" v={d.desk.geocode_source} />
      <Row k="Precision" v={d.desk.geocode_precision} />
      {d.desk.override_reason ? (
        <Banner tone="warn" icon="key">
          Passed with an override: {d.desk.override_reason}
        </Banner>
      ) : null}
    </Section>
  );
}

function StoredField({ d }: { d: SpotDetail }) {
  return (
    <Section title="Field check — what was found">
      <Row k="Office" v={d.field.office} />
      <Row k="Record found" v={d.field.record_found === null ? null : d.field.record_found ? 'Yes' : 'No'} />
      <Row k="Reference" v={d.field.reference} />
      {d.field.notes ? (
        <>
          <Text style={s.label}>Internal notes</Text>
          <Text style={s.notes} selectable>{d.field.notes}</Text>
          <Text style={s.hint}>Internal. The owner has never been shown this.</Text>
        </>
      ) : null}
    </Section>
  );
}

/**
 * Who looked, and whether it was more than one person.
 *
 * The field check is meant to be independent of the desk review. One admin may
 * do both — refusing that would stop a one-admin team working — so it is
 * recorded and shown rather than blocked, and an auditor asking "did two
 * people see this?" can answer it from here.
 */
function Independence({ d }: { d: SpotDetail }) {
  const i = d.independence;
  if (!i.desk_reviewed_by && !i.field_checked_by) return null;

  return (
    <Section title="Who checked it">
      <Row k="Desk review" v={i.desk_reviewed_by ? `Admin ${i.desk_reviewed_by}` : null} />
      <Row k="Field check" v={i.field_checked_by ? `Admin ${i.field_checked_by}` : null} />
      {i.both_stages_same_admin ? (
        <Banner tone="warn" icon="person">
          Both stages were done by the same admin. Allowed — a small team has to be able to work —
          but the field check is meant to be independent of the desk review.
        </Banner>
      ) : null}
      {i.reviewer_is_the_owner ? (
        <Banner tone="error" icon="alert-circle">
          A reviewer on this spot is also its owner. This should not have been possible.
        </Banner>
      ) : null}
    </Section>
  );
}

function ReviewLog({ d }: { d: SpotDetail }) {
  if (!d.review_log?.length) return null;

  return (
    <Section
      title="History"
      note="Append-only, and it survives a resubmission — so who did what is still answerable after a second attempt overwrites the first."
    >
      {[...d.review_log].reverse().map((e, i) => (
        <View key={`${e.at}-${i}`} style={s.logRow}>
          <Text style={s.logWhen}>{new Date(e.at).toLocaleString()}</Text>
          <Text style={s.logWhat}>
            {e.stage} · {e.action.replace(/_/g, ' ')} · admin {e.by}
          </Text>
          {e.note ? <Text style={s.logNote}>{e.note}</Text> : null}
        </View>
      ))}
    </Section>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', flex: 1, textAlign: 'center' },
  body: { padding: 16, paddingBottom: 48 },

  strip: { flexDirection: 'row', alignItems: 'center', backgroundColor: SC.bgCard, borderRadius: 14, borderWidth: 1, borderColor: SC.border, padding: 14 },
  stripStatus: { color: SC.textPrimary, fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  stripVisible: { color: SC.textSecondary, fontSize: 12, marginTop: 3, textTransform: 'capitalize' },
  stripWait: { fontSize: 19, fontWeight: '800' },
  stripSla: { fontSize: 11, fontWeight: '800' },

  section: { backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 15, marginTop: 14 },
  sectionTitle: { color: SC.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  sectionNote: { color: SC.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 5 },

  row: { flexDirection: 'row', gap: 10, marginTop: 10 },
  k: { color: SC.textSecondary, fontSize: 12.5, width: 132 },
  v: { color: SC.textPrimary, fontSize: 13, flex: 1, fontWeight: '600' },

  label: { color: SC.textSecondary, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 16, marginBottom: 7 },
  input: { backgroundColor: SC.bgElevated, borderRadius: 12, borderWidth: 1, borderColor: SC.border, color: SC.textPrimary, fontSize: 15, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 12 },
  hint: { color: SC.textSecondary, fontSize: 11.5, lineHeight: 17, marginTop: 7 },
  none: { color: SC.textSecondary, fontSize: 12.5, marginTop: 10, fontStyle: 'italic' },
  subLabel: { color: SC.textSecondary, fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', marginBottom: 7 },
  notes: { color: SC.textPrimary, fontSize: 13, lineHeight: 19, backgroundColor: SC.bgElevated, borderRadius: 10, padding: 11 },

  doc: { width: '100%', height: 260, borderRadius: 12, backgroundColor: SC.bgElevated },
  docFoot: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8, justifyContent: 'center' },
  docFootText: { color: SC.accent, fontSize: 12, fontWeight: '700' },

  banner: { flexDirection: 'row', gap: 9, borderRadius: 12, borderWidth: 1, padding: 12, marginTop: 12 },
  bannerText: { color: SC.textPrimary, fontSize: 12.5, lineHeight: 19, flex: 1 },

  readout: { backgroundColor: SC.bgElevated, borderRadius: 12, padding: 13, marginTop: 14, gap: 14 },
  readRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  readPill: { fontSize: 10.5, fontWeight: '800', borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, overflow: 'hidden', textAlign: 'center', width: 96 },
  readWhat: { color: SC.textPrimary, fontSize: 13, fontWeight: '700' },
  readWhy: { color: SC.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 3 },
  readNote: { color: SC.warning, fontSize: 11.5, lineHeight: 17, marginTop: 5 },
  readMeta: { color: SC.textMuted ?? SC.textSecondary, fontSize: 10.5, marginTop: 5 },
  reminder: { color: SC.warning, fontSize: 11.5, lineHeight: 17, fontWeight: '700' },

  blockers: { backgroundColor: SC.errorSoft, borderRadius: 12, borderWidth: 1, borderColor: `${SC.error}55`, padding: 13, marginTop: 14, gap: 9 },
  blockersTitle: { color: SC.textPrimary, fontSize: 13, fontWeight: '800' },
  blockerRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  blockerText: { color: SC.textPrimary, fontSize: 12.5, lineHeight: 18, flex: 1 },
  blockerFinal: { color: SC.error, fontSize: 11.5, fontWeight: '700', marginTop: 3 },
  proceed: { color: SC.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 2 },

  choice: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, backgroundColor: SC.bgElevated, borderWidth: 1, borderColor: SC.border },
  choiceWide: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, backgroundColor: SC.bgElevated, borderWidth: 1, borderColor: SC.border, marginBottom: 8 },
  choiceOn: { borderColor: SC.accent },
  choiceText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13, flex: 1 },

  secondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderColor: SC.accent, paddingVertical: 13, marginTop: 14 },
  secondaryText: { color: SC.accent, fontSize: 14, fontWeight: '800' },
  primary: { backgroundColor: SC.accent, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  danger: { backgroundColor: SC.error, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 12 },
  dangerText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  dupRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 11 },
  dupTitle: { color: SC.textPrimary, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  dupAddress: { color: SC.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
  dupTag: { color: SC.textSecondary, fontSize: 11, fontWeight: '800', marginTop: 3 },

  logRow: { marginTop: 12, borderLeftWidth: 2, borderLeftColor: SC.border, paddingLeft: 10 },
  logWhen: { color: SC.textSecondary, fontSize: 11 },
  logWhat: { color: SC.textPrimary, fontSize: 12.5, fontWeight: '700', marginTop: 2, textTransform: 'capitalize' },
  logNote: { color: SC.textSecondary, fontSize: 11.5, lineHeight: 17, marginTop: 3 },

  error: { color: SC.error, fontSize: 13, marginTop: 12, fontWeight: '600' },
});
