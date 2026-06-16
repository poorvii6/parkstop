import { StyleSheet } from 'react-native';

export const BlueprintColors = {
  background: '#0C0C14', // Deep Midnight (Premium Dark)
  cardBackground: 'rgba(30, 41, 59, 0.7)', // Glassmorphic Slate
  primaryAccent: '#FF6B2C', // Vibrant ParkStop Orange
  secondaryAccent: '#1E293B', // Slate Blue for highlights
  textPrimary: '#FFFFFF', // Crisp White
  textSecondary: '#94A3B8', // Muted Slate Grey
  border: 'rgba(255, 255, 255, 0.1)', // Subtle light border
  success: '#10B981', // Emerald Green
  error: '#EF4444', // Rose Red
};

export const BlueprintTheme = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BlueprintColors.background,
  },
  glassCard: {
    backgroundColor: BlueprintColors.cardBackground,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: BlueprintColors.border,
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 5,
  },
  textPrimary: {
    color: BlueprintColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  textSecondary: {
    color: BlueprintColors.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  buttonPrimary: {
    backgroundColor: BlueprintColors.primaryAccent,
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: BlueprintColors.primaryAccent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  buttonPrimaryText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
    textTransform: 'none',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: BlueprintColors.border,
    color: BlueprintColors.textPrimary,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 16,
    marginBottom: 16,
    fontSize: 16,
  },
  inputLabel: {
    color: BlueprintColors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 1,
  }
});
