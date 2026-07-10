import { useMemo, useRef, useState } from "react";
import { StyleSheet, TextInput, View, type NativeSyntheticEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GiphyContent, GiphyGridView, type GiphyContentRequest, type GiphyMedia } from "@giphy/react-native-sdk";

import { mediaToPickedGif, type PickedGif } from "../media/gifPicker";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

export interface GifTrayProps {
  height: number;
  onSelectGif: (gif: PickedGif) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

// Inline GIF search tray, embedded in place of the keyboard (see
// ChatScreen's gifTrayOpen state) rather than the SDK's full-screen
// GiphyDialog modal — GiphyGridView is the SDK's plain, non-modal React
// component for this. There's no bundled search bar, so this pairs it with
// its own debounced TextInput, feeding a fresh GiphyContentRequest into the
// grid's `content` prop on every query change.
export default function GifTray({ height, onSelectGif }: GifTrayProps) {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState<GiphyContentRequest>(() => GiphyContent.trendingGifs());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChangeText = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setContent(text.trim() ? GiphyContent.search({ searchQuery: text.trim() }) : GiphyContent.trendingGifs());
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleMediaSelect = (event: NativeSyntheticEvent<{ media: GiphyMedia }>) => {
    const gif = mediaToPickedGif(event.nativeEvent.media);
    if (gif) onSelectGif(gif);
  };

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search GIFs"
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={handleChangeText}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <GiphyGridView
        style={styles.grid}
        content={content}
        spanCount={3}
        cellPadding={2}
        onMediaSelect={handleMediaSelect}
        theme={scheme}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { backgroundColor: colors.background },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 10,
      marginTop: 8,
      marginBottom: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.bubbleIncoming,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
    grid: { flex: 1 },
  });
