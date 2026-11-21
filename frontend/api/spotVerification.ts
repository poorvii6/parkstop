/**
 * spotVerification.ts — the owner's side of per-spot property verification.
 *
 * Owner verification approves a PERSON. This is about a PLACE, and there is one
 * of these per spot: an owner with four driveways submits four documents and
 * gets four verdicts. Nothing here computes a status or decides what is
 * missing — the server does both, in SpotVerificationPolicy, so the screen and
 * the submit endpoint cannot tell an owner different things.
 */
import apiClient from './client';

export type SpotVerificationStatus =
  | 'not_started'
  | 'in_progress'
  | 'desk_pending'
  | 'desk_approved'
  | 'approved'
  | 'rejected'
  | 'grandfathered';

/** One thing still standing between this spot and a submission. */
export type Gap = { code: 'NO_DOCUMENT' | 'NO_LANDLORD_CONSENT' | 'NO_PIN' | string; message: string };

/**
 * Exactly what the server sends, and nothing derived from it on this side.
 *
 * Note what is NOT here: no document id, no signed URL, no reviewer name, no
 * office, and no field notes. An admin's note about a suspected forgery must
 * never reach an owner's screen, so the server does not send one and this type
 * has nowhere to put it.
 */
export type SpotVerification = {
  spot_id: number;
  title: string | null;
  status: SpotVerificationStatus;
  /** What drivers see right now, which is not always the same as `status`. */
  visible_to_drivers: SpotVerificationStatus | null;
  is_live: boolean;
  /** The sentence to show. Written once on the server. */
  message: string;
  document: {
    doc_type: string;
    address: string;
    relationship: 'owner' | 'tenant' | string;
    is_pdf: boolean;
  } | null;
  is_tenant: boolean;
  landlord: { noc_uploaded: boolean; name: string | null };
  /** Still missing, from the same function the submit endpoint refuses with. */
  missing: Gap[];
  can_submit: boolean;
  editable: boolean;
  submitted_at: string | null;
  waiting_hours: number | null;
  hours_left: number | null;
  promised_hours: number;
  rejection_reason: string | null;
  pin_locked: boolean;
};

const unwrap = (res: any) => res.data?.data as SpotVerification;

const multipart = {
  headers: { 'Content-Type': 'multipart/form-data' },
  transformRequest: (d: any) => d,
  timeout: 120000,
};

/** A file the owner picked: a photo from the camera or gallery, or a PDF. */
export type PickedDoc = { uri: string; name: string; mimeType: string };

export const spotVerification = {
  get: async (spotId: number) => unwrap(await apiClient.get(`/spot-verification/${spotId}`)),

  uploadDocument: async (
    spotId: number,
    file: PickedDoc,
    doc_type: string,
    address: string,
    relationship: 'owner' | 'tenant'
  ) => {
    const form = new FormData();
    form.append('document', { uri: file.uri, name: file.name, type: file.mimeType } as any);
    form.append('doc_type', doc_type);
    form.append('address', address);
    form.append('relationship', relationship);
    return unwrap(await apiClient.post(`/spot-verification/${spotId}/document`, form, multipart));
  },

  /**
   * The landlord's consent letter. A separate call because it is a separate
   * document about a different person — and stage 3 refuses the submission
   * without it, which is why the screen says so before the owner uploads
   * anything.
   */
  uploadLandlordNoc: async (spotId: number, file: PickedDoc, landlord_name: string) => {
    const form = new FormData();
    form.append('document', { uri: file.uri, name: file.name, type: file.mimeType } as any);
    form.append('landlord_name', landlord_name);
    return unwrap(await apiClient.post(`/spot-verification/${spotId}/landlord-noc`, form, multipart));
  },

  /** Starts the 48-hour clock, and only if nothing is missing. */
  submit: async (spotId: number) => unwrap(await apiClient.post(`/spot-verification/${spotId}/submit`)),
};

/** Any server or network error, as one plain sentence for the owner. */
export function errorText(e: any, fallback = 'Something went wrong. Please try again.'): string {
  return e?.response?.data?.message
    || (e?.code === 'ECONNABORTED' ? 'The upload took too long. Please try again.' : '')
    || e?.message
    || fallback;
}

/**
 * Other spots already using the document the owner just picked.
 *
 * The server refuses a document that is already verifying a DIFFERENT address
 * and says where. Surfaced so the owner can see what happened rather than
 * reading "could not upload" and trying the same file again.
 */
export function alsoUsedFor(e: any): { spot_id: number; address: string | null }[] {
  const list = e?.response?.data?.also_used_for;
  return Array.isArray(list) ? list : [];
}
