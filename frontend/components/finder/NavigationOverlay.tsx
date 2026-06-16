import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BlueprintColors } from '../../constants/BlueprintTheme';

interface NavigationOverlayProps {
  arrivalDetected: boolean;
  currentInstruction: { turn: string, street: string, icon: string };
  distanceInfo: { miles: string, mins: string };
  onCheckIn: () => void;
  onExit: () => void;
}

export const NavigationOverlay: React.FC<NavigationOverlayProps> = ({
  arrivalDetected,
  currentInstruction,
  distanceInfo,
  onCheckIn,
  onExit,
}) => {
  return (
    <>
      <View style={styles.enRouteOverlay} pointerEvents="box-none">
        <View style={styles.enRouteBanner}>
          {arrivalDetected ? (
            <>
              <Text style={{ fontSize: 32, marginRight: 15 }}>📍</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.arrivedTitle}>You have arrived!</Text>
                <Text style={styles.arrivedSub}>Destination is on your right.</Text>
              </View>
              <TouchableOpacity style={styles.continueBtn} onPress={onCheckIn}>
                <Text style={styles.continueBtnText}>Check In →</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.navIconCircle}>
                <Text style={{ fontSize: 32 }}>{currentInstruction.icon}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 15 }}>
                <Text style={styles.instructionTurn}>{currentInstruction.turn}</Text>
                <Text style={styles.instructionStreet}>{currentInstruction.street}</Text>
              </View>
              <View style={styles.navStats}>
                <Text style={styles.navStatValue}>{distanceInfo.mins}</Text>
                <Text style={styles.navStatLabel}>MIN</Text>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.bottomNavDashboard}>
        <View style={styles.etaProgressBar}>
          <View style={[styles.etaProgressFill, { width: '70%' }]} />
        </View>
        <View style={styles.bottomNavStats}>
          <View style={styles.bottomStatItem}>
            <Text style={styles.bottomStatValue}>{distanceInfo.miles}</Text>
            <Text style={styles.bottomStatLabel}>miles</Text>
          </View>
          <View style={styles.bottomStatDivider} />
          <View style={styles.bottomStatItem}>
            <Text style={styles.bottomStatValue}>{distanceInfo.mins}:45</Text>
            <Text style={styles.bottomStatLabel}>ETA</Text>
          </View>
          <View style={styles.bottomStatDivider} />
          <TouchableOpacity style={styles.stopNavBtn} onPress={onExit}>
            <Text style={styles.stopNavBtnText}>Exit</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  enRouteOverlay: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    zIndex: 10,
  },
  enRouteBanner: {
    backgroundColor: '#1E293B',
    padding: 20,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: BlueprintColors.primaryAccent,
    shadowColor: BlueprintColors.primaryAccent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 20,
  },
  arrivedTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  arrivedSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13 },
  continueBtn: {
    backgroundColor: BlueprintColors.primaryAccent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  continueBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  navIconCircle: {
    width: 60,
    height: 60,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  instructionTurn: { color: '#fff', fontSize: 20, fontWeight: '900' },
  instructionStreet: { color: BlueprintColors.primaryAccent, fontSize: 14, fontWeight: '800' },
  navStats: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    alignItems: 'center',
  },
  navStatValue: { color: '#fff', fontSize: 18, fontWeight: '900' },
  navStatLabel: { color: BlueprintColors.textSecondary, fontSize: 10, fontWeight: '800' },
  bottomNavDashboard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1E293B',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingBottom: 40,
    paddingTop: 12,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 25,
    elevation: 30,
  },
  etaProgressBar: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 32,
    borderRadius: 2,
    marginBottom: 20,
  },
  etaProgressFill: {
    height: '100%',
    backgroundColor: BlueprintColors.primaryAccent,
    borderRadius: 2,
  },
  bottomNavStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 20,
  },
  bottomStatItem: { alignItems: 'center' },
  bottomStatValue: { color: '#fff', fontSize: 24, fontWeight: '900' },
  bottomStatLabel: { color: BlueprintColors.textSecondary, fontSize: 12, fontWeight: '700' },
  bottomStatDivider: { width: 1, height: 30, backgroundColor: 'rgba(255,255,255,0.1)' },
  stopNavBtn: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 16,
  },
  stopNavBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },
});
