/**
 * ownerVerification.ts — calls for spot-owner verification.
 * The server does every check through Cashfree; the app only collects input.
 */
import apiClient from './client';

export type StepKey = 'aadhaar' | 'pan' | 'selfie' | 'bank' | 'property';
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
    property: { doc_type: string; address: string } | null;
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

  uploadProperty: async (uri: string, mimeType: string | undefined, doc_type: string, address: string) => {
    const form = new FormData();
    const type = mimeType && /^image\/(jpe?g|png|webp)$/.test(mimeType) ? mimeType : 'image/jpeg';
    form.append('document', { uri, name: `document.${type.split('/')[1]}`, type } as any);
    form.append('doc_type', doc_type);
    form.append('address', address);
    return unwrap(await apiClient.post('/owner-verification/property', form, multipart));
  },

  submit: async () => unwrap(await apiClient.post('/owner-verification/submit')),

  // Admin
  adminList: async (status = 'pending') => (await apiClient.get(`/owner-verification/admin/list?status=${status}`)).data.data as any[],
  adminDetail: async (userId: number) => (await apiClient.get(`/owner-verification/admin/${userId}`)).data.data,
  adminApprove: async (userId: number) => (await apiClient.post(`/owner-verification/admin/${userId}/approve`)).data,
  adminReject: async (userId: number, reason: string) => (await apiClient.post(`/owner-verification/admin/${userId}/reject`, { reason })).data,
};

export const DOC_TYPES: { key: string; label: string }[] = [
  { key: 'electricity_bill', label: 'Electricity bill' },
  { key: 'property_tax', label: 'Property tax receipt' },
  { key: 'rent_agreement', label: 'Rent agreement' },
  { key: 'sale_deed', label: 'Sale deed' },
  { key: 'water_bill', label: 'Water bill' },
  { key: 'other', label: 'Other proof' },
];

/** Plain-English labels for the warning flags an admin sees. */
export const FLAG_LABELS: Record<string, string> = {
  POSSIBLE_DUPLICATE_AADHAAR: 'Same Aadhaar as another account',
  PAN_NAME_PARTIAL: 'PAN name only partly matches Aadhaar',
  PAN_NOT_LINKED_TO_AADHAAR: 'PAN is not linked to Aadhaar',
  BANK_NAME_PARTIAL: 'Bank account name only partly matches Aadhaar',
};
