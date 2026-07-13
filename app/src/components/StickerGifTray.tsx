import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { ensureGiphyConfigured, isGifPickerAvailable, type PickedGif } from "../media/gifPicker";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";
import GifTray from "./GifTray";

export interface StickerGifTrayProps {
  height: number;
  onSelectMedia: (media: PickedGif) => void;
}

const TAB_BAR_HEIGHT = 40;

type Tab = "sticker" | "gif";

// Single tray, embedded in place of the keyboard, that switches between a
// sticker grid and a GIF search grid via a small tab bar. Mobile keyboards
// already have a built-in emoji picker (that's what tapping the keyboard
// icon next to this falls back to — see ChatScreen's togglePicker), so this
// tray only ever needs to cover what the OS keyboard doesn't: stickers and
// GIFs, both served by the same GIPHY-backed GifTray component (see there
// for why a "sticker" is just a different content type in the same picker).
export default function StickerGifTray({ height, onSelectMedia }: StickerGifTrayProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>("sticker");
  const giphyAvailable = isGifPickerAvailable();
  const contentHeight = height - TAB_BAR_HEIGHT;

  const selectTab = (next: Tab) => {
    // The native SDK needs its API key set before GifTray's GiphyGridView
    // can fetch anything — isGifPickerAvailable only checks that a key
    // exists in env, it doesn't configure the SDK itself.
    ensureGiphyConfigured();
    setTab(next);
  };

  if (!giphyAvailable) {
    return (
      <View style={[styles.container, styles.unavailable, { height }]}>
        <MaterialCommunityIcons name="sticker-emoji" size={28} color={colors.textTertiary} />
        <Text style={styles.unavailableText}>Stickers and GIFs aren't set up for this build.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.tabBar}>
        <Pressable style={styles.tab} onPress={() => selectTab("sticker")}>
          <Text style={[styles.tabLabel, tab === "sticker" && styles.tabLabelActive]}>Stickers</Text>
          {tab === "sticker" ? <View style={styles.tabIndicator} /> : null}
        </Pressable>
        <Pressable style={styles.tab} onPress={() => selectTab("gif")}>
          <Text style={[styles.tabLabel, tab === "gif" && styles.tabLabelActive]}>GIF</Text>
          {tab === "gif" ? <View style={styles.tabIndicator} /> : null}
        </Pressable>
      </View>
      {/* key={tab} forces a fresh GifTray per tab so switching always lands
          back on a clean trending feed instead of the other tab's leftover
          search query/results — see GifTray's own comment on this. */}
      <GifTray key={tab} height={contentHeight} mediaType={tab === "sticker" ? "sticker" : "gif"} onSelectGif={onSelectMedia} />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { backgroundColor: colors.background },
    unavailable: { alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 24 },
    unavailableText: { color: colors.textTertiary, fontSize: 13, textAlign: "center" },
    tabBar: {
      flexDirection: "row",
      height: TAB_BAR_HEIGHT,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    tab: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    tabLabel: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textTertiary,
    },
    tabLabelActive: {
      color: colors.accent,
    },
    tabIndicator: {
      position: "absolute",
      bottom: 0,
      left: "25%",
      right: "25%",
      height: 2,
      borderRadius: 1,
      backgroundColor: colors.accent,
    },
  });
