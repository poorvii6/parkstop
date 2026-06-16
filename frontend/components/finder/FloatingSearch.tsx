import React from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { BlueprintColors } from '../../constants/BlueprintTheme';

interface FloatingSearchProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  handleSearch: () => void;
  isSearching: boolean;
  step: string;
  suggestions: any[];
  setSuggestions: (s: any[]) => void;
  selectSuggestion: (item: any) => void;
}

export const FloatingSearch: React.FC<FloatingSearchProps> = ({
  searchQuery,
  setSearchQuery,
  handleSearch,
  isSearching,
  step,
  suggestions,
  setSuggestions,
  selectSuggestion,
}) => {
  return (
    <View style={styles.floatingSearchContainer}>
      <View style={styles.searchBarWrapper}>
        <Text style={styles.searchIconPrefix}>🔍</Text>
        <TextInput
          style={styles.searchBar}
          placeholder="Search for a destination..."
          placeholderTextColor={BlueprintColors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity 
            style={styles.clearSearchBtn} 
            onPress={() => { setSearchQuery(''); setSuggestions([]); }}
          >
            <Text style={{ color: BlueprintColors.textSecondary, fontSize: 18 }}>✕</Text>
          </TouchableOpacity>
        )}
        {isSearching && <View style={styles.searchLoader} />}
      </View>

      {step === 'search' && suggestions.length === 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterContainer}>
          <TouchableOpacity 
            style={[styles.filterChip, { backgroundColor: BlueprintColors.primaryAccent }]} 
            onPress={() => { setSearchQuery('EV Charging Parking'); handleSearch(); }}
          >
            <Text style={styles.filterChipText}>🔌 EV Charge</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {suggestions.length > 0 && (
        <View style={styles.suggestionsContainer}>
          {searchQuery === '' && (
            <Text style={styles.suggestedNearYou}>
              📍 SUGGESTED NEAR YOU
            </Text>
          )}
          <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
            {suggestions.map((item, idx) => {
              let icon = '📍';
              const type = item.type || '';
              if (type === 'city' || type === 'town') icon = '🏙️';
              else if (type === 'house' || type === 'building') icon = '🏠';
              else if (type === 'park') icon = '🌳';
              else if (type === 'attraction') icon = '🎡';

              return (
                <TouchableOpacity
                  key={idx}
                  style={styles.suggestionItem}
                  onPress={() => selectSuggestion(item)}
                >
                  <View style={styles.suggestionIconCircle}>
                    <Text style={styles.suggestionIcon}>{icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.suggestionTitle} numberOfLines={1}>
                      {item.display_name.split(',')[0]}
                    </Text>
                    <Text style={styles.suggestionSub} numberOfLines={1}>
                      {item.display_name}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  floatingSearchContainer: {
    position: 'absolute',
    top: 100,
    left: 16,
    right: 16,
    zIndex: 100,
  },
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E293B',
    borderRadius: 20,
    paddingHorizontal: 16,
    height: 58,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  searchIconPrefix: { fontSize: 18, marginRight: 12 },
  searchBar: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '600' },
  clearSearchBtn: { padding: 8 },
  searchLoader: { 
    width: 20, 
    height: 20, 
    borderRadius: 10, 
    borderTopWidth: 2, 
    borderColor: BlueprintColors.primaryAccent, 
    marginLeft: 10 
  },
  filterContainer: { marginTop: 12, paddingBottom: 5 },
  filterChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterChipText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  suggestionsContainer: {
    marginTop: 8,
    backgroundColor: '#1E293B',
    borderRadius: 20,
    paddingVertical: 8,
    maxHeight: 300,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 15,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  suggestedNearYou: { 
    color: 'rgba(255,255,255,0.5)', 
    fontSize: 12, 
    fontWeight: '700', 
    paddingHorizontal: 16, 
    paddingTop: 8, 
    paddingBottom: 4 
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  suggestionIconCircle: {
    width: 36,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  suggestionIcon: { fontSize: 16 },
  suggestionTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  suggestionSub: { color: BlueprintColors.textSecondary, fontSize: 12, marginTop: 2 },
});
