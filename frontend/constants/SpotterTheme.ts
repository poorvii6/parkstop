/**
 * SpotterTheme.ts — Unified design system for the Spotter Dashboard.
 * All spotter pages MUST import tokens from this file to ensure
 * 100% visual consistency across Dashboard, Verify, Spots, Support, and Profile.
 */

import { StyleSheet, Platform } from 'react-native';

/* ── Color Palette ─────────────────────────────────────────────── */
export const SC = {
  // Backgrounds
  bg:           '#0C0C14',    // Deep midnight base
  bgCard:       '#161622',    // Card / section background
  bgElevated:   '#1C1C2E',    // Elevated surfaces (inputs, modals)
  bgGlass:      'rgba(28, 28, 46, 0.65)',

  // Accent
  accent:       '#FF5733',    // ParkStop brand orange-red
  accentSoft:   'rgba(255, 87, 51, 0.12)',
  accentGlow:   'rgba(255, 87, 51, 0.25)',

  // Semantic
  success:      '#22C55E',
  successSoft:  'rgba(34, 197, 94, 0.12)',
  warning:      '#F59E0B',
  warningSoft:  'rgba(245, 158, 11, 0.12)',
  error:        '#EF4444',
  errorSoft:    'rgba(239, 68, 68, 0.12)',
  info:         '#3B82F6',
  infoSoft:     'rgba(59, 130, 246, 0.12)',

  // Text
  textPrimary:  '#FFFFFF',
  textSecondary:'rgba(255,255,255,0.55)',
  textMuted:    'rgba(255,255,255,0.35)',
  textDisabled: 'rgba(255,255,255,0.18)',

  // Borders
  border:       'rgba(255,255,255,0.08)',
  borderActive: 'rgba(255, 87, 51, 0.4)',

  // Overlay
  overlay:      'rgba(0,0,0,0.55)',
};

/* ── Typography Presets ────────────────────────────────────────── */
export const TF = {
  // Logo
  logo:         { fontSize: 22, fontWeight: '800' as const, letterSpacing: -0.5 },

  // Headings
  h1:           { fontSize: 24, fontWeight: '800' as const, letterSpacing: -0.3 },
  h2:           { fontSize: 20, fontWeight: '700' as const },
  h3:           { fontSize: 17, fontWeight: '700' as const },

  // Body
  body:         { fontSize: 15, fontWeight: '500' as const },
  bodyBold:     { fontSize: 15, fontWeight: '700' as const },
  bodySm:       { fontSize: 13, fontWeight: '500' as const },
  caption:      { fontSize: 12, fontWeight: '600' as const },

  // Labels
  label:        { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },
  labelSm:      { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.5, textTransform: 'uppercase' as const },

  // Values
  bigValue:     { fontSize: 28, fontWeight: '800' as const },
  medValue:     { fontSize: 18, fontWeight: '800' as const },

  // Buttons
  btnPrimary:   { fontSize: 15, fontWeight: '800' as const, letterSpacing: 0.3 },
  btnSecondary: { fontSize: 13, fontWeight: '700' as const },

  // Chips
  chip:         { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.5 },
};

/* ── Spacing & Radius ──────────────────────────────────────────── */
export const SP = {
  pagePadding: 20,
  cardPadding: 16,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const RAD = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  full: 999,
};

/* ── Shared StyleSheet ─────────────────────────────────────────── */
export const SS = StyleSheet.create({
  /* Page */
  page: {
    flex: 1,
    backgroundColor: SC.bg,
  },

  /* Header */
  headerSafe: {
    backgroundColor: SC.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SP.pagePadding,
    height: 56,
    marginTop: Platform.OS === 'android' ? 8 : 0,
  },
  logoText: {
    color: SC.textPrimary,
    ...TF.logo,
  },
  logoAccent: {
    color: SC.accent,
  },

  /* Status Indicator */
  statusBox: {
    alignItems: 'flex-end' as const,
  },
  statusLabel: {
    color: SC.textMuted,
    ...TF.labelSm,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  statusText: {
    color: SC.success,
    fontSize: 12,
    fontWeight: '700',
    marginRight: 5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: SC.success,
  },

  /* Profile Button */
  profileBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: SC.infoSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },

  /* Scroll */
  scrollContent: {
    padding: SP.pagePadding,
    paddingBottom: 40,
  },

  /* Cards */
  card: {
    backgroundColor: SC.bgCard,
    borderRadius: RAD.lg,
    padding: SP.cardPadding,
    borderWidth: 1,
    borderColor: SC.border,
  },
  glassCard: {
    backgroundColor: SC.bgGlass,
    borderRadius: RAD.xl,
    padding: SP.xl,
    borderWidth: 1,
    borderColor: SC.border,
  },

  /* Section */
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SP.lg,
  },
  sectionTitle: {
    color: SC.textPrimary,
    ...TF.h3,
  },

  /* Inputs */
  inputGroup: {
    marginBottom: SP.pagePadding,
  },
  inputLabel: {
    color: SC.textSecondary,
    ...TF.label,
    marginBottom: SP.sm,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: RAD.sm,
    paddingHorizontal: SP.lg,
    paddingVertical: 14,
    color: SC.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: SC.border,
  },

  /* Buttons */
  primaryBtn: {
    backgroundColor: SC.accent,
    borderRadius: RAD.md,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: SC.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  primaryBtnText: {
    color: '#FFF',
    ...TF.btnPrimary,
  },

  /* Badge */
  badge: {
    backgroundColor: SC.bgElevated,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: RAD.full,
  },
  badgeText: {
    color: SC.textSecondary,
    ...TF.chip,
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: SC.border,
    marginHorizontal: SP.lg,
  },

  /* Empty State */
  emptyText: {
    color: SC.textMuted,
    ...TF.bodySm,
    marginTop: 10,
    textAlign: 'center',
  },
});
