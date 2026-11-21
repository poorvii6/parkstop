/**
 * spotVerificationAdmin.ts — the reviewer's side of per-spot verification.
 *
 * Two stages, in order, and only the second can make a spot live:
 *
 *   DESK   an admin reads the document. Compares the name on it against the
 *          owner's verified Aadhaar name — or, for a rented spot, against the
 *          landlord who signed the consent letter — and measures the address
 *          on it against the spot's pin. A desk pass does NOT publish.
 *   FIELD  our team goes to the registrar and looks for the record. This is
 *          the only thing a forger cannot simply print, and the only route to
 *          `approved`.
 *
 * Nothing here decides anything or recomputes a verdict. Every number, band
 * and blocker comes from the server, because widening a band on a phone would
 * silently disagree with what was stored against a decision already taken.
 */
import apiClient from './client';

export type Sla = 'not_waiting' | 'ok' | 'at_risk' | 'overdue';
export type Stage = 'desk' | 'field';

export type QueueRow = {
  spot_id: number;
  title: string | null;
  claimed_address: string | null;
  doc_type: string | null;
  relationship: string | null;
  status: string;
  stage: Stage;
  submitted_at: string | null;
  waiting_hours: number | null;
  hours_left: number | null;
  overdue_by_hours: number | null;
  sla: Sla;
  owner: { id: number; name: string | null; email: string | null; person_verified: boolean } | null;
  visible_to_drivers: string | null;
};

export type Queue = {
  promised_hours: number;
  at_risk_after_hours: number;
  counts: { total: number; desk: number; field: number; at_risk: number; overdue: number };
  items: QueueRow[];
};

export type BacklogRow = {
  spot_id: number;
  title: string | null;
  spot_address: string | null;
  listed_at: string | null;
  grandfathered_at: string | null;
  status: string;
  has_document: boolean;
  claimed_address: string | null;
  visible_to_drivers: string | null;
  owner: { id: number; name: string | null; email: string | null; phone: string | null } | null;
};

export type Backlog = {
  note: string;
  count: number;
  submitted_and_in_the_queue: number;
  items: BacklogRow[];
};

/** One thing standing in the way of a desk pass. */
export type Blocker = {
  code: string;
  message: string;
  /** Cannot be cleared by writing a reason — only by supplying the fact. */
  final?: boolean;
};

export type NameCheck = {
  name_on_document: string;
  /** 'aadhaar_name', or 'landlord_name' for a rented spot. */
  checked_against: 'aadhaar_name' | 'landlord_name' | string;
  expected_name: string | null;
  aadhaar_name: string | null;
  landlord_name: string | null;
  verdict: string;
  matched: number;
  of: number;
  conflicting: number;
  via_variant: boolean;
  /** The spelling match rested on a two-letter key — thin evidence. */
  weak_variant: boolean;
  exact_full_matches: number;
  deceased_holder: boolean;
  explanation: string;
  note: string | null;
};

export type AddressCheck = {
  verdict: 'consistent' | 'review' | 'mismatch' | 'unverifiable' | 'unresolved' | string;
  metres: number | null;
  beyond_m: number | null;
  explanation: string;
  claimed_address: string | null;
  resolved_to: string | null;
  precision: string | null;
  uncertainty_m: number | null;
  source: string | null;
};

export type SpotDetail = {
  spot: {
    id: number; title: string | null; address_on_listing: string | null;
    latitude: string | number | null; longitude: string | number | null;
    listed_at: string | null; is_active: boolean | null; visible_to_drivers: string | null;
  };
  owner: {
    id: number; name: string | null; email: string | null; phone: string | null;
    person_verified: boolean; aadhaar_name: string | null; person_property_address: string | null;
  } | null;
  submission: {
    status: string;
    doc_type: string | null;
    claimed_address: string | null;
    relationship: string | null;
    landlord_name: string | null;
    /** The file. For a PDF this IS the PDF — open it, do not try to render it. */
    doc_url: string | null;
    /** Page 1 as a JPEG for a PDF; the same image for a photo. Always renderable. */
    doc_preview_url: string | null;
    doc_format: string | null;
    doc_is_pdf: boolean;
    landlord_noc_url: string | null;
    landlord_noc_preview_url: string | null;
    landlord_noc_format: string | null;
    landlord_noc_is_pdf: boolean;
    submitted_at: string | null;
    grandfathered_at: string | null;
    /** Other spots holding the same file. Reuse at another address is refused. */
    same_document_on: {
      spot_id: number; title: string | null; claimed_address: string | null;
      status: string; same_owner: boolean; same_address: boolean;
    }[];
    sla: Sla;
    waiting_hours: number | null;
    hours_left: number | null;
    overdue_by_hours: number | null;
  };
  desk: {
    name_on_document: string | null;
    name_match: string | null;
    name_checked_against: string | null;
    noc_names_owner: boolean | null;
    inheritance_doc_type: string | null;
    address_match_metres: number | null;
    address_match_verdict: string | null;
    geocoded_lat: string | number | null;
    geocoded_lng: string | number | null;
    geocode_source: string | null;
    geocode_precision: string | null;
    geocode_uncertainty_m: number | null;
    override_reason: string | null;
    reviewed_by: number | null;
    reviewed_at: string | null;
    reading: string | null;
  };
  field: {
    office: string | null;
    record_found: boolean | null;
    reference: string | null;
    /** INTERNAL. Never shown to an owner; the server does not send it to them. */
    notes: string | null;
    checked_by: number | null;
    checked_at: string | null;
  };
  /** Who looked, and whether it was more than one person. */
  independence: {
    desk_reviewed_by: number | null;
    field_checked_by: number | null;
    both_stages_same_admin: boolean;
    reviewer_is_the_owner: boolean;
  };
  rejection_reason: string | null;
  review_log: { at: string; stage: string; action: string; by: number; note?: string }[];
};

/** What `check` returns: the measurements, deciding nothing. */
export type CheckResult = {
  spot_id: number;
  status: string;
  address: AddressCheck;
  name: NameCheck | null;
  blockers: Blocker[];
  is_tenant: boolean;
  cannot_be_overridden: string[];
  your_own_spot: boolean;
  reminder: string;
};

const data = (res: any) => res.data?.data;

export const spotVerificationAdmin = {
  queue: async (stage?: Stage) =>
    data(await apiClient.get(`/spot-verification/admin/queue${stage ? `?stage=${stage}` : ''}`)) as Queue,

  backlog: async () => data(await apiClient.get('/spot-verification/admin/backlog')) as Backlog,

  detail: async (spotId: number) =>
    data(await apiClient.get(`/spot-verification/admin/${spotId}`)) as SpotDetail,

  /**
   * Run the two checks and store what they found, deciding nothing.
   *
   * A POST because it costs an external geocode and writes to the row — a GET
   * that did both would be a trap for whoever next adds a refresh button.
   */
  check: async (spotId: number, body: {
    name_on_document?: string;
    noc_names_owner?: boolean;
    inheritance_document?: string;
  }) => data(await apiClient.post(`/spot-verification/admin/${spotId}/check`, body)) as CheckResult,

  desk: async (spotId: number, body: {
    decision: 'pass' | 'reject';
    name_on_document?: string;
    reason?: string;
    override_reason?: string;
    noc_names_owner?: boolean;
    inheritance_document?: string;
  }) => (await apiClient.post(`/spot-verification/admin/${spotId}/desk`, body)).data,

  field: async (spotId: number, body: {
    record_found: boolean;
    office: string;
    reference?: string;
    notes?: string;
    reason?: string;
  }) => (await apiClient.post(`/spot-verification/admin/${spotId}/field`, body)).data,
};

export function errorText(e: any, fallback = 'Something went wrong.'): string {
  return e?.response?.data?.message || e?.message || fallback;
}

/** Blockers the server sent back with a 409, so the screen can show them. */
export function blockersFrom(e: any): Blocker[] {
  const b = e?.response?.data?.blockers;
  return Array.isArray(b) ? b : [];
}

export function cannotOverride(e: any): string[] {
  const c = e?.response?.data?.cannot_be_overridden;
  return Array.isArray(c) ? c : [];
}

export function howToProceed(e: any): string | null {
  return e?.response?.data?.how_to_proceed || null;
}

/** Other spots the refused reference or document is already used for. */
export function alsoUsedFor(e: any): { spot_id: number; claimed_address?: string | null; address?: string | null }[] {
  const l = e?.response?.data?.also_used_for;
  return Array.isArray(l) ? l : [];
}

/** Colour and words for an SLA state. The bands are the server's. */
export const SLA_LABEL: Record<Sla, string> = {
  not_waiting: 'Not waiting',
  ok: 'On time',
  at_risk: 'At risk',
  overdue: 'Overdue',
};

/**
 * Plain words for a verdict, so a reviewer is not reading SCREAMING_SNAKE.
 *
 * The server also sends a full sentence (`explanation`), which is what is
 * actually shown; these are for the short pill next to it.
 */
export const NAME_VERDICT_LABEL: Record<string, string> = {
  DIRECT_MATCH: 'Same name',
  GOOD_PARTIAL_MATCH: 'Matches as far as it goes',
  MODERATE_PARTIAL_MATCH: 'Read it and decide',
  NO_MATCH: 'Does not match',
};

export const ADDRESS_VERDICT_LABEL: Record<string, string> = {
  consistent: 'Agrees with the pin',
  review: 'Worth a look',
  mismatch: 'Somewhere else',
  unverifiable: 'Proves nothing',
  unresolved: 'Not found on the map',
};
