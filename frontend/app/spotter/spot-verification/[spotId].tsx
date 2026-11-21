/**
 * Verifying ONE spot — the owner's side of the door.
 *
 * Stages 1-3 built the gate, the clock, the two checks and the field visit, and
 * nothing in the app called any of it: an owner saw "Not visible · add a
 * document" on their spot list with nowhere to tap. This is where they tap.
 *
 * FOUR THINGS THIS SCREEN MUST GET RIGHT, and they are all about telling the
 * owner the truth before they spend effort on it:
 *
 *   1. It says which documents this spot needs, and that the document must be
 *      in their OWN name, BEFORE any upload button appears. A utility bill is
 *      not accepted and it is better to say so than to reject it later.
 *
 *   2. A tenant is told the landlord's letter is required, and that the
 *      submission is refused without it, up front. The server has always
 *      refused it; finding that out at the submit button is the experience this
 *      exists to prevent. Both the warning and the refusal come from
 *      Policy.submissionGaps, so they cannot drift apart.
 *
 *   3. The status comes from the server — `message`, `status`,
 *      `visible_to_drivers`, `missing`, `can_submit` — and NOTHING here
 *      re-derives it. driverVisibleStatusFor decides what a driver can see and
 *      it is not a copy of `status`: a spot that was live before this feature
 *      existed stays live while its review is in flight. Working that out
 *      again on a phone would eventually disagree with the finder.
 *
 *   4. It never shows field_notes. The server does not send them — an admin's
 *      note about a suspected forgery is for other admins — and there is
 *      nowhere on this screen that could display one.
 *
 * It also states the promise plainly, because a promise nobody is told is not
 * one: verified and listed within 48 hours of a COMPLETE submission.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { SC, ICON } from '../../../constants/SpotterTheme';
import { PROPERTY_DOC_TYPES, isTenancyDoc, labelForDocType } from '../../../constants/propertyDocTypes';
import {
  spotVerification, errorText, alsoUsedFor,
  type SpotVerification, type PickedDoc,
} from '../../../api/spotVerification';
import DocumentPickerField from '../../../components/spotter/DocumentPicker';
import { PrimaryButton, ErrorNote, WhatsMissing } from '../../../components/spotter/VerifyUI';
import { LoadFailed } from '../../../components/LoadFailed';

/** Where the owner is in filling this in. Not a server status. */
type Sheet = 'none' | 'document' | 'landlord';

export default function SpotVerificationScreen() {
  const router = useRouter();
  const { spotId: raw } = useLocalSearchParams<{ spotId: string }>();
  const spotId = Number(raw);

  const [data, setData] = useState<SpotVerification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Sheet>('none');

  const load = useCallback(async (quiet = false) => {
    if (!Number.isInteger(spotId)) { setError('That spot could not be found.'); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      setData(await spotVerification.get(spotId));
      setError('');
    } catch (e) {
      setError(errorText(e, 'Could not load this spot.'));
    } finally {
      setLoading(false);
    }
  }, [spotId]);

  useFocusEffect(useCallback(() => { load(true); }, [load]));

  if (loading && !data) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <Header title="Verify this spot" onBack={() => router.back()} />
        <ActivityIndicator color={SC.accent} size="large" style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <Header title="Verify this spot" onBack={() => router.back()} />
        {/*
          A retry, not just a message. Without one the only way out of a
          failed load was to back out of the screen and come in again.
          Nothing to retry if the spot id itself is unusable, though.
        */}
        {Number.isInteger(spotId)
          ? <LoadFailed message={error || 'Could not load this spot.'} onRetry={() => load()} what="this spot" />
          : <View style={{ padding: 20 }}><ErrorNote text={error || 'That spot could not be found.'} /></View>}
      </SafeAreaView>
    );
  }

  if (sheet === 'document') {
    return (
      <DocumentSheet
        spotId={spotId}
        current={data}
        onDone={(next) => { setData(next); setSheet('none'); }}
        onCancel={() => setSheet('none')}
      />
    );
  }

  if (sheet === 'landlord') {
    return (
      <LandlordSheet
        spotId={spotId}
        current={data}
        onDone={(next) => { setData(next); setSheet('none'); }}
        onCancel={() => setSheet('none')}
      />
    );
  }

  return (
    <Overview
      data={data}
      error={error}
      onRefresh={() => load(true)}
      onBack={() => router.back()}
      onEditDocument={() => { setError(''); setSheet('document'); }}
      onEditLandlord={() => { setError(''); setSheet('landlord'); }}
      onSubmitted={(next) => setData(next)}
      onError={setError}
      spotId={spotId}
    />
  );
}

// ─────────────────────────────── overview ───────────────────────────────

function Overview({
  data, error, spotId, onRefresh, onBack, onEditDocument, onEditLandlord, onSubmitted, onError,
}: {
  data: SpotVerification;
  error: string;
  spotId: number;
  onRefresh: () => void;
  onBack: () => void;
  onEditDocument: () => void;
  onEditLandlord: () => void;
  onSubmitted: (next: SpotVerification) => void;
  onError: (m: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    onError('');
    try {
      const next = await spotVerification.submit(spotId);
      onSubmitted(next);
      Alert.alert(
        'Sent for checking',
        `We will verify this spot and list it within ${next.promised_hours} hours. `
        + 'You do not need to do anything else.'
      );
    } catch (e) {
      onError(errorText(e, 'Could not submit this spot.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Header title={data.title || 'Verify this spot'} onBack={onBack} />
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={SC.accent} />}
      >
        {/* The state, in the server's own words. Never re-derived here. */}
        <StatusCard data={data} />

        <ErrorNote text={error} />

        {/*
          WHAT THIS SPOT NEEDS, said before any upload button. An owner who
          reads this and realises they have the wrong paper has lost a minute;
          an owner who uploads first loses a 48-hour cycle.
        */}
        {data.editable ? <WhatIsNeeded isTenant={data.is_tenant} /> : null}

        <Text style={s.sectionLabel}>Your document</Text>
        <DocumentRow data={data} onEdit={onEditDocument} />

        {/*
          The landlord's letter only appears once we know it is rented — which
          is after the document is uploaded with relationship/doc_type. Before
          that, WhatIsNeeded has already said it will be required.
        */}
        {data.is_tenant ? <LandlordRow data={data} onEdit={onEditLandlord} /> : null}

        {data.editable && data.missing.length ? (
          <View style={s.missingCard}>
            <Text style={s.missingTitle}>Still needed before we can check this spot</Text>
            {data.missing.map((m) => (
              <View key={m.code} style={s.missingRow}>
                <Ionicons name="ellipse-outline" size={ICON.label} color={SC.warning} style={{ marginTop: 3 }} />
                <Text style={s.missingText}>{m.message}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* The promise, stated plainly, wherever the owner is in the process. */}
        <View style={s.promise}>
          <Ionicons name="time-outline" size={ICON.label} color={SC.textSecondary} />
          <Text style={s.promiseText}>
            Once everything is in, we verify this spot and list it within{' '}
            <Text style={{ fontWeight: '800', color: SC.textPrimary }}>{data.promised_hours} hours</Text>.
            The clock starts when your submission is complete — not before.
          </Text>
        </View>

        <View style={s.privacy}>
          <Ionicons name="lock-closed" size={ICON.label} color={SC.textSecondary} />
          <Text style={s.privacyText}>
            Your documents are stored privately. Only the ParkStop team reviewing this spot can open
            them, and drivers never see them.
          </Text>
        </View>
      </ScrollView>

      {data.editable ? (
        <View style={s.footer}>
          <PrimaryButton
            label={data.status === 'rejected' ? 'Submit again' : 'Send for checking'}
            onPress={submit}
            loading={submitting}
            disabled={!data.can_submit}
          />
          {!data.can_submit ? (
            <Text style={s.footerHint}>
              {data.missing[0]?.message || 'Add your document to continue.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Where this spot stands, and whether a driver can see it.
 *
 * `status` and `visible_to_drivers` are shown as two separate facts because
 * they genuinely are two: a spot that was listed before per-spot verification
 * existed stays visible while its review is in flight, and telling its owner
 * "not visible" would be a lie.
 */
function StatusCard({ data }: { data: SpotVerification }) {
  const tone = data.status === 'approved' ? 'good'
    : data.status === 'rejected' ? 'bad'
      : data.status === 'desk_pending' || data.status === 'desk_approved' ? 'wait'
        : 'idle';

  const colour = tone === 'good' ? SC.success : tone === 'bad' ? SC.error : tone === 'wait' ? SC.info : SC.warning;
  const bg = tone === 'good' ? SC.successSoft : tone === 'bad' ? SC.errorSoft : tone === 'wait' ? SC.infoSoft : SC.warningSoft;
  const icon = tone === 'good' ? 'shield-checkmark' : tone === 'bad' ? 'alert-circle' : tone === 'wait' ? 'time' : 'shield-outline';

  return (
    <View style={[s.statusCard, { backgroundColor: bg, borderColor: `${colour}55` }]}>
      <View style={s.statusTop}>
        <Ionicons name={icon as any} size={ICON.tile} color={colour} />
        <Text style={[s.statusLive, { color: colour }]}>
          {data.is_live ? 'Drivers can see this spot' : 'Drivers cannot see this spot yet'}
        </Text>
      </View>

      {/* The sentence is the server's. One definition, two screens. */}
      <Text style={s.statusMessage}>{data.message}</Text>

      {data.waiting_hours !== null ? (
        <Text style={s.statusClock}>
          {data.hours_left && data.hours_left > 0
            ? `Waiting ${data.waiting_hours} h · about ${Math.ceil(data.hours_left)} h left of the ${data.promised_hours} we promised`
            : `Waiting ${data.waiting_hours} h · past the ${data.promised_hours} hours we promised. We are on it.`}
        </Text>
      ) : null}

      {/*
        A rejection, with the reason the reviewer wrote FOR the owner. This is
        `rejection_reason` and never field_notes: an internal note about a
        suspected forgery is not sent to this screen at all.
      */}
      {data.rejection_reason ? (
        <View style={s.rejection}>
          <Text style={s.rejectionLabel}>What needs fixing</Text>
          <Text style={s.rejectionText}>{data.rejection_reason}</Text>
          <Text style={s.rejectionHint}>
            Replace the document below and send it again. It goes back into the queue for checking —
            fixing it does not put the spot live on its own.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Which documents are accepted, in whose name, before anything is uploaded. */
function WhatIsNeeded({ isTenant }: { isTenant: boolean }) {
  const owned = PROPERTY_DOC_TYPES.filter((d) => d.proves === 'ownership' && d.key !== 'other');

  return (
    <View style={s.needCard}>
      <Text style={s.needTitle}>What this spot needs</Text>

      <View style={s.needRow}>
        <Ionicons name="document-text-outline" size={ICON.label} color={SC.accent} style={{ marginTop: 2 }} />
        <Text style={s.needText}>
          <Text style={s.needStrong}>A document that proves who owns this address</Text>
          {' — '}
          {owned.map((d) => d.label.toLowerCase()).join(', ')}, or another ownership document.
        </Text>
      </View>

      <View style={s.needRow}>
        <Ionicons name="person-outline" size={ICON.label} color={SC.accent} style={{ marginTop: 2 }} />
        <Text style={s.needText}>
          <Text style={s.needStrong}>It must be in your own name</Text>
          {' — the name on your Aadhaar. We compare the two.'}
          {isTenant ? ' If you rent, see below: the document is your landlord\'s.' : ''}
        </Text>
      </View>

      <View style={s.needRow}>
        <Ionicons name="close-circle-outline" size={ICON.label} color={SC.textSecondary} style={{ marginTop: 2 }} />
        <Text style={[s.needText, { color: SC.textSecondary }]}>
          An electricity or water bill is not enough. A bill shows you pay for power here, not that
          you own the place.
        </Text>
      </View>

      {/*
        THE TENANT WARNING, up front. The server has always refused a rented
        spot without the landlord's letter; this is the screen saying so first
        instead of letting the owner find out at the submit button.
      */}
      <View style={s.tenantNote}>
        <Ionicons name="information-circle" size={ICON.label} color={SC.warning} style={{ marginTop: 1 }} />
        <Text style={s.tenantText}>
          <Text style={s.needStrong}>Renting this place?</Text> You need two things: the ownership
          document in your <Text style={s.needStrong}>landlord&apos;s</Text> name, and a signed letter
          from them naming you and this spot.{' '}
          <Text style={{ fontWeight: '800' }}>
            We cannot accept the submission without the letter
          </Text>
          {' — so please have it ready before you start.'}
        </Text>
      </View>
    </View>
  );
}

function DocumentRow({ data, onEdit }: { data: SpotVerification; onEdit: () => void }) {
  const doc = data.document;

  return (
    <TouchableOpacity
      style={s.itemCard}
      onPress={onEdit}
      disabled={!data.editable}
      activeOpacity={0.8}
    >
      <Ionicons
        name={doc ? (doc.is_pdf ? 'document-text' : 'image') : 'add-circle-outline'}
        size={ICON.action}
        color={doc ? SC.success : SC.warning}
      />
      <View style={{ flex: 1 }}>
        {doc ? (
          <>
            <Text style={s.itemTitle}>{labelForDocType(doc.doc_type)}</Text>
            <Text style={s.itemSub} numberOfLines={2}>{doc.address}</Text>
            <Text style={s.itemTag}>
              {doc.relationship === 'tenant' ? 'You rent this place' : 'You own this place'}
              {doc.is_pdf ? ' · PDF' : ''}
            </Text>
          </>
        ) : (
          <>
            <Text style={s.itemTitle}>Add your ownership document</Text>
            <Text style={s.itemSub}>A PDF from the Karnataka portal, or a photo of the paper.</Text>
          </>
        )}
      </View>
      {data.editable ? <Ionicons name="chevron-forward" size={ICON.tile} color={SC.textSecondary} /> : null}
    </TouchableOpacity>
  );
}

function LandlordRow({ data, onEdit }: { data: SpotVerification; onEdit: () => void }) {
  const have = data.landlord.noc_uploaded && !!data.landlord.name;

  return (
    <>
      <Text style={s.sectionLabel}>Your landlord&apos;s consent</Text>
      <TouchableOpacity style={s.itemCard} onPress={onEdit} disabled={!data.editable} activeOpacity={0.8}>
        <Ionicons
          name={have ? 'checkmark-circle' : 'alert-circle-outline'}
          size={ICON.action}
          color={have ? SC.success : SC.warning}
        />
        <View style={{ flex: 1 }}>
          <Text style={s.itemTitle}>
            {have ? 'Letter from your landlord' : 'Letter from your landlord — required'}
          </Text>
          <Text style={s.itemSub}>
            {have
              ? `Signed by ${data.landlord.name}`
              : 'A signed letter naming you and this spot. We cannot check a rented spot without it.'}
          </Text>
        </View>
        {data.editable ? <Ionicons name="chevron-forward" size={ICON.tile} color={SC.textSecondary} /> : null}
      </TouchableOpacity>
    </>
  );
}

// ───────────────────────────── the document ─────────────────────────────

function DocumentSheet({
  spotId, current, onDone, onCancel,
}: {
  spotId: number;
  current: SpotVerification;
  onDone: (next: SpotVerification) => void;
  onCancel: () => void;
}) {
  const [docType, setDocType] = useState(current.document?.doc_type || '');
  const [address, setAddress] = useState(current.document?.address || '');
  const [relationship, setRelationship] = useState<'owner' | 'tenant'>(
    (current.document?.relationship as 'owner' | 'tenant') || 'owner'
  );
  const [file, setFile] = useState<PickedDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<{ spot_id: number; address: string | null }[]>([]);

  /**
   * A rent agreement means a tenant whatever the owner ticked.
   *
   * Same union the server uses, so the warning the owner sees here is the rule
   * that will be applied to them.
   */
  const tenant = relationship === 'tenant' || isTenancyDoc(docType);

  /**
   * What is still missing, in the order the form asks for it. `ready` is
   * derived from this list rather than written separately, so the button and
   * the explanation can never disagree — the 10-character address rule used to
   * be enforced here and stated nowhere.
   */
  const addressLen = address.trim().length;
  const missing = [
    !docType && 'Choose the document type',
    addressLen < 10 && (addressLen === 0
      ? 'Enter the address printed on the document'
      : `The address needs at least 10 characters — you have ${addressLen}`),
    !file && 'Attach the document',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;

  const save = async () => {
    if (!ready || !file) {
      setError('Choose the document type, enter the address printed on it, and attach the file.');
      return;
    }
    setBusy(true);
    setError('');
    setDuplicates([]);
    try {
      onDone(await spotVerification.uploadDocument(
        spotId, file, docType, address.trim(), tenant ? 'tenant' : 'owner'
      ));
    } catch (e) {
      setError(errorText(e, 'Could not upload your document.'));
      setDuplicates(alsoUsedFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Header title="Your document" onBack={onCancel} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.sheetIntro}>
          The document must be in your own name — the name on your Aadhaar. If you rent this place,
          upload your <Text style={{ fontWeight: '800' }}>landlord&apos;s</Text> ownership document and
          tick &ldquo;I rent it&rdquo; below.
        </Text>

        <Text style={s.sectionLabel}>Which document is it?</Text>
        <View style={s.chips}>
          {PROPERTY_DOC_TYPES.map((d) => (
            <TouchableOpacity
              key={d.key}
              style={[s.chip, docType === d.key && s.chipOn]}
              onPress={() => { setDocType(d.key); setError(''); }}
            >
              <Text style={[s.chipText, docType === d.key && { color: '#fff' }]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.sectionLabel}>Do you own this place or rent it?</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {(['owner', 'tenant'] as const).map((r) => (
            <TouchableOpacity
              key={r}
              style={[s.toggle, relationship === r && s.toggleOn]}
              onPress={() => { setRelationship(r); setError(''); }}
            >
              <Ionicons
                name={relationship === r ? 'radio-button-on' : 'radio-button-off'}
                size={ICON.row}
                color={relationship === r ? SC.accent : SC.textSecondary}
              />
              <Text style={[s.toggleText, relationship === r && { color: SC.textPrimary }]}>
                {r === 'owner' ? 'I own it' : 'I rent it'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Said the moment it becomes true, not at the submit button. */}
        {tenant ? (
          <View style={s.tenantNote}>
            <Ionicons name="information-circle" size={ICON.label} color={SC.warning} style={{ marginTop: 1 }} />
            <Text style={s.tenantText}>
              {isTenancyDoc(docType) && relationship === 'owner'
                ? 'A rent agreement is a tenant\'s document, so this spot counts as rented. '
                : ''}
              You will also need a signed letter from your landlord naming you and this spot.{' '}
              <Text style={{ fontWeight: '800' }}>We cannot accept the submission without it.</Text>
            </Text>
          </View>
        ) : null}

        <Text style={s.sectionLabel}>The address printed on the document</Text>
        <TextInput
          style={[s.input, { minHeight: 84, textAlignVertical: 'top' }]}
          value={address}
          onChangeText={(t) => { setAddress(t); setError(''); }}
          placeholder="House / building, street, area, city, PIN"
          placeholderTextColor={SC.textDisabled}
          multiline
          maxLength={300}
        />
        <Text style={s.fieldHint}>
          Copy it as printed. We check it against where this spot sits on the map.
        </Text>

        <Text style={s.sectionLabel}>The document</Text>
        <DocumentPickerField value={file} onChange={setFile} onError={setError} />

        <ErrorNote text={error} />

        {/*
          The server refuses a document already verifying a different address.
          Showing WHERE turns "could not upload" into something the owner can
          act on — usually: both spots are at one address and should say so.
        */}
        {duplicates.length ? (
          <View style={s.dupCard}>
            <Text style={s.dupTitle}>This file is already used for another address</Text>
            {duplicates.map((d) => (
              <Text key={d.spot_id} style={s.dupText}>• {d.address || `Spot ${d.spot_id}`}</Text>
            ))}
            <Text style={s.dupHint}>
              If both spots really are at the same place, enter the same address for both. Otherwise
              upload the document for this address.
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={s.footer}>
        <WhatsMissing items={missing} />
        <PrimaryButton
          label={current.document ? 'Replace document' : 'Save document'}
          onPress={save}
          loading={busy}
          disabled={!ready}
        />
      </View>
    </SafeAreaView>
  );
}

// ───────────────────────── the landlord's letter ─────────────────────────

function LandlordSheet({
  spotId, current, onDone, onCancel,
}: {
  spotId: number;
  current: SpotVerification;
  onDone: (next: SpotVerification) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(current.landlord.name || '');
  const [file, setFile] = useState<PickedDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Same shape as DocumentSheet: the list is the single source for both the
  // button's disabled state and what the owner is told.
  const missing = [
    name.trim().length < 2 && "Enter the landlord's full name",
    !file && 'Attach the signed letter',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;

  const save = async () => {
    if (!ready || !file) {
      setError('Enter the landlord\'s name and attach the letter.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onDone(await spotVerification.uploadLandlordNoc(spotId, file, name.trim()));
    } catch (e) {
      setError(errorText(e, 'Could not upload the letter.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Header title="Landlord's consent" onBack={onCancel} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.sheetIntro}>
          Because you rent this place, we need a signed letter from the person who owns it saying
          they agree to it being let as parking. The letter should name{' '}
          <Text style={{ fontWeight: '800' }}>you</Text> and{' '}
          <Text style={{ fontWeight: '800' }}>this spot&apos;s address</Text>.
        </Text>

        <Text style={s.sectionLabel}>The letter should say</Text>
        <View style={s.needCard}>
          {[
            'Your landlord\'s full name, as it appears on the ownership document',
            'Your full name, as it appears on your Aadhaar',
            'The address of this parking space',
            'That they agree to it being let as parking on ParkStop',
            'Their signature and the date',
          ].map((line) => (
            <View key={line} style={s.needRow}>
              <Ionicons name="checkmark" size={ICON.label} color={SC.accent} style={{ marginTop: 3 }} />
              <Text style={s.needText}>{line}</Text>
            </View>
          ))}
        </View>

        <Text style={s.sectionLabel}>Your landlord&apos;s name</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={(t) => { setName(t); setError(''); }}
          placeholder="As signed on the letter"
          placeholderTextColor={SC.textDisabled}
          maxLength={150}
          autoCapitalize="words"
        />
        <Text style={s.fieldHint}>
          This should match the name on the ownership document you uploaded.
        </Text>

        <Text style={s.sectionLabel}>The letter</Text>
        <DocumentPickerField value={file} onChange={setFile} onError={setError} />

        <ErrorNote text={error} />
      </ScrollView>
      <View style={s.footer}>
        <WhatsMissing items={missing} />
        <PrimaryButton
          label={current.landlord.noc_uploaded ? 'Replace letter' : 'Save letter'}
          onPress={save}
          loading={busy}
          disabled={!ready}
        />
      </View>
    </SafeAreaView>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.back} hitSlop={12}>
        <Ionicons name="chevron-back" size={ICON.tile} color={SC.textPrimary} />
      </TouchableOpacity>
      <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
      <View style={{ width: 36 }} />
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', flex: 1, textAlign: 'center' },
  body: { padding: 20, paddingBottom: 40 },

  sectionLabel: { color: SC.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, marginTop: 20 },
  sheetIntro: { color: SC.textSecondary, fontSize: 14, lineHeight: 21 },
  input: {
    backgroundColor: SC.bgElevated, borderRadius: 14, borderWidth: 1, borderColor: SC.border,
    color: SC.textPrimary, fontSize: 16, fontWeight: '600', paddingHorizontal: 16, paddingVertical: 14,
  },
  fieldHint: { color: SC.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 8 },

  statusCard: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 10 },
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  statusLive: { fontSize: 15, fontWeight: '800', flex: 1 },
  statusMessage: { color: SC.textPrimary, fontSize: 14, lineHeight: 21 },
  statusClock: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 18 },
  rejection: { borderTopWidth: 1, borderTopColor: `${SC.error}44`, paddingTop: 12, gap: 6 },
  rejectionLabel: { color: SC.error, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  rejectionText: { color: SC.textPrimary, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  rejectionHint: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 18 },

  needCard: { backgroundColor: SC.bgCard, borderRadius: 18, borderWidth: 1, borderColor: SC.border, padding: 16, marginTop: 16, gap: 12 },
  needTitle: { color: SC.textPrimary, fontSize: 15, fontWeight: '800' },
  needRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  needText: { color: SC.textPrimary, fontSize: 13.5, lineHeight: 20, flex: 1 },
  needStrong: { fontWeight: '800' },
  tenantNote: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 16,
    backgroundColor: SC.warningSoft, borderRadius: 14, borderWidth: 1, borderColor: `${SC.warning}55`, padding: 13,
  },
  tenantText: { color: SC.textPrimary, fontSize: 13, lineHeight: 20, flex: 1 },

  itemCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 16,
  },
  itemTitle: { color: SC.textPrimary, fontSize: 15, fontWeight: '700' },
  itemSub: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  itemTag: { color: SC.textSecondary, fontSize: 11.5, marginTop: 5, fontWeight: '700' },

  missingCard: {
    backgroundColor: SC.warningSoft, borderRadius: 16, borderWidth: 1, borderColor: `${SC.warning}55`,
    padding: 15, marginTop: 20, gap: 8,
  },
  missingTitle: { color: SC.textPrimary, fontSize: 13.5, fontWeight: '800' },
  missingRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  missingText: { color: SC.textPrimary, fontSize: 13, lineHeight: 19, flex: 1 },

  promise: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 24 },
  promiseText: { color: SC.textSecondary, fontSize: 13, lineHeight: 20, flex: 1 },
  privacy: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 14 },
  privacyText: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 19, flex: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border },
  chipOn: { backgroundColor: SC.accent, borderColor: SC.accent },
  chipText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13 },
  toggle: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 14, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border,
  },
  toggleOn: { borderColor: SC.accent },
  toggleText: { color: SC.textSecondary, fontWeight: '700', fontSize: 14 },

  dupCard: {
    backgroundColor: SC.errorSoft, borderRadius: 14, borderWidth: 1, borderColor: `${SC.error}55`,
    padding: 14, marginTop: 14, gap: 6,
  },
  dupTitle: { color: SC.textPrimary, fontSize: 13.5, fontWeight: '800' },
  dupText: { color: SC.textPrimary, fontSize: 13, lineHeight: 19 },
  dupHint: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 2 },

  footer: { padding: 16, borderTopWidth: 1, borderTopColor: SC.border, backgroundColor: SC.bg },
  footerHint: { color: SC.textSecondary, fontSize: 12.5, lineHeight: 18, textAlign: 'center', marginTop: 10 },
});
