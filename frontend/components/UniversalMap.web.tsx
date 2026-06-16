import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export const Marker = ({ children }: any) => <View>{children}</View>;

export default function UniversalMap({ style, initialRegion, children }: any) {
  return (
    <View style={[style, styles.webPlaceholder]}>
      <View style={styles.webContent}>
        <Text style={styles.webTitle}>Interactive Map (Native Only)</Text>
        <Text style={styles.webSubtitle}>
          The interactive map is optimized for iOS and Android. 
          Please use Expo Go on your mobile device to see the full experience.
        </Text>
        <View style={styles.mockMap}>
           <Text style={styles.mockText}>[ Native Map Preview ]</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  webPlaceholder: {
    backgroundColor: '#121212',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  webContent: {
    maxWidth: 400,
    alignItems: 'center',
    textAlign: 'center',
    backgroundColor: '#1A1A1A',
    padding: 30,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#333',
  },
  webTitle: {
    color: '#6366F1',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  webSubtitle: {
    color: '#888',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 30,
  },
  mockMap: {
    width: '100%',
    height: 150,
    backgroundColor: '#121212',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#222',
    justifyContent: 'center',
    alignItems: 'center',
    borderStyle: 'dashed',
  },
  mockText: {
    color: '#444',
    fontWeight: '500',
  }
});
