/**
 * ownerVerification.ts — calls for spot-owner verification.
 * The server does every check through Cashfree; the app only collects input.
 */
import apiClient from './client';

/**
 * 'property' was a fifth step. It is gone: it collected one document for the
 * whole account and compared it to nothing. Each spot carries its own property
 * document now, measured against that spot's pin.
 */
export type StepKey = 'aadhaar' | 'pan' | 'selfie' | 'bank';
export type OwnerStatus = 'not_started' | 'in_progress' | 'pending' | 'approved' | 'rejected';

export type OwnerVerification = {
  status: OwnerStatus;
  steps: Record<StepKey, boolean>;
  all_done: boolean;
  rejection_reason: string | null;
  submitted_at: string | null;
  details: {
    aadhaar: { name: string; last4: string } | null;
    pan: { masked: string } | null;
    bank: { last4: string; ifsc: string; bank_name: string | null } | null;
    /** Only on accounts that used the old per-account property step. */
    legacy_property: { doc_type: string; address: string; uploaded_at: string } | null;
  };
};

const unwrap = (res: any) => res.data?.data as OwnerVerification;

/** Turn any server/network error into a plain sentence for the owner. */
export function errorText(e: any, fallback = 'Something went wrong. Please try again.'): string {
  return e?.response?.data?.message || (e?.code === 'ECONNABORTED' ? 'The server took too long. Please try again.' : '') || e?.message || fallback;
}
export function errorCode(e: any): string | undefined {
  return e?.response?.data?.code;
}

const multipart = { headers: { 'Content-Type': 'multipart/form-data' }, transformRequest: (d: any) => d, timeout: 60000 };

export const ownerVerification = {
  get: async () => unwrap(await apiClient.get('/owner-verification')),

  startAadhaar: async (): Promise<{ url: string; return_url: string }> =>
    (await apiClient.post('/owner-verification/aadhaar/start')).data.data,
  completeAadhaar: async () => unwrap(await apiClient.post('/owner-verification/aadhaar/complete')),

  verifyPan: async (pan: string) => unwrap(await apiClient.post('/owner-verification/pan', { pan })),

  verifySelfie: async (uri: string) => {
    const form = new FormData();
    form.append('image', { uri, name: 'selfie.jpg', type: 'image/jpeg' } as any);
    return unwrap(await apiClient.post('/owner-verification/selfie', form, multipart));
  },

  verifyBank: async (account_number: string, ifsc: string) =>
    unwrap(await apiClient.post('/owner-verification/bank', { account_number, ifsc })),

  // uploadProperty is gone with the step it served. A spot's property document
  // goes to /spot-verification/:spotId/document, where it is measured against
  // that spot's own pin.

  submit: async () => unwrap(await apiClient.post('/owner-verification/submit')),

  // Admin
  adminList: async (status = 'pending') => (await apiClient.get(`/owner-verification/admin/list?status=${status}`)).data.data as any[],
  adminDetail: async (userId: number) => (await apiClient.get(`/owner-verification/admin/${userId}`)).data.data,
  adminApprove: async (userId: number) => (await apiClient.post(`/owner-verification/admin/${userId}/approve`)).data,
  adminReject: async (userId: number, reason: string) => (await apiClient.post(`/owner-verification/admin/${userId}/reject`, { reason })).data,
};

/**
 * The document list, re-exported from the one place it is defined.
 *
 * It used to be written out here, which made it the third copy of the same six
 * strings and the one the owner actually saw. Electricity and water bills are
 * gone: they prove you pay for power at an address, not that you own the land.
 * See constants/propertyDocTypes.ts.
 */
export { PROPERTY_DOC_TYPES as DOC_TYPES, labelForDocType } from '../constants/propertyDocTypes';

/** Plain-English labels for the warning flags an admin sees. */
export const FLAG_LABELS: Record<string, string> = {
  POSSIBLE_DUPLICATE_AADHAAR: 'Same Aadhaar as another account',
  PAN_NAME_PARTIAL: 'PAN name only partly matches Aadhaar',
  PAN_NOT_LINKED_TO_AADHAAR: 'PAN is not linked to Aadhaar',
  BANK_NAME_PARTIAL: 'Bank account name only partly matches Aadhaar',
};
