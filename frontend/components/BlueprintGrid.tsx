import React from 'react';
import { View, StyleSheet } from 'react-native';
import { BlueprintColors } from '../constants/BlueprintTheme';

interface BlueprintGridProps {
  children?: React.ReactNode;
}

export const BlueprintGrid: React.FC<BlueprintGridProps> = ({ children }) => {
  return (
    <View style={styles.container}>
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BlueprintColors.background,
  }
});
