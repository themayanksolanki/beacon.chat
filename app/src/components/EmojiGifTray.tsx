import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { EmojiKeyboard, type EmojiType } from "rn-emoji-keyboard";

import { ensureGiphyConfigured, isGifPickerAvailable, type PickedGif } from "../media/gifPicker";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";
import GifTray from "./GifTray";

export interface EmojiGifTrayProps {
  height: number;
  onEmojiSelected: (emoji: EmojiType) => void;
  onSelectGif: (gif: PickedGif) => void;
}

const TAB_BAR_HEIGHT = 40;

type Tab = "emoji" | "gif";

// Single tray, embedded in place of the keyboard, that switches between the
// emoji keyboard and the GIF search grid via a small tab bar — one entry
// point instead of the previous two separate triggers (a dedicated emoji
// button and a dedicated GIF badge). Defaults to the emoji tab; the GIF tab
// is only shown when the SDK key is actually configured for this build.
export default function EmojiGifTray({ height, onEmojiSelected, onSelectGif }: EmojiGifTrayProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>("emoji");
  const gifAvailable = isGifPickerAvailable();
  const contentHeight = height - TAB_BAR_HEIGHT;

  const selectTab = (next: Tab) => {
    // The native SDK needs its API key set before GifTray's GiphyGridView
    // can fetch anything — isGifPickerAvailable only checks that a key
    // exists in env, it doesn't configure the SDK itself.
    if (next === "gif") ensureGiphyConfigured();
    setTab(next);
  };

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.tabBar}>
        <Pressable style={styles.tab} onPress={() => selectTab("emoji")}>
          <Text style={[styles.tabLabel, tab === "emoji" && styles.tabLabelActive]}>Emoji</Text>
          {tab === "emoji" ? <View style={styles.tabIndicator} /> : null}
        </Pressable>
        {gifAvailable ? (
          <Pressable style={styles.tab} onPress={() => selectTab("gif")}>
            <Text style={[styles.tabLabel, tab === "gif" && styles.tabLabelActive]}>GIF</Text>
            {tab === "gif" ? <View style={styles.tabIndicator} /> : null}
          </Pressable>
        ) : null}
      </View>
      {tab === "emoji" ? (
        <EmojiKeyboard
          onEmojiSelected={onEmojiSelected}
          enableSearchBar
          enableRecentlyUsed
          categoryPosition="floating"
          defaultHeight={contentHeight}
          hideHeader
          // The library's own container ships with a card-style border
          // radius + drop shadow (meant for its default use inside a
          // floating bottom-sheet modal). Embedded flush in our own flat
          // tray under the tab bar, that rounded/shadowed box reads as an
          // offset, tilted card instead of sitting level — flatten it here.
          styles={{
            container: { borderRadius: 0, shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
          }}
          // The library's default theme hardcodes near-black search text on a
          // near-transparent-black search-bar background — fine against its
          // own default white container, but with our container set to
          // transparent (showing our actual, possibly-dark, background
          // through) that leaves near-black text on a dark background,
          // effectively invisible. Map every themeable surface to our app
          // theme instead of just the container.
          theme={{
            container: "transparent",
            header: colors.textSecondary,
            skinTonesContainer: colors.surface,
            knob: colors.textTertiary,
            category: {
              icon: colors.textSecondary,
              iconActive: colors.accent,
              container: colors.bubbleIncoming,
              containerActive: colors.accentSoft,
            },
            search: {
              text: colors.text,
              placeholder: colors.textTertiary,
              icon: colors.textSecondary,
              background: colors.bubbleIncoming,
            },
            customButton: {
              icon: colors.textSecondary,
              iconPressed: colors.accent,
              background: colors.bubbleIncoming,
              backgroundPressed: colors.border,
            },
            emoji: { selected: colors.accentSoft },
          }}
        />
      ) : (
        <GifTray height={contentHeight} onSelectGif={onSelectGif} />
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { backgroundColor: colors.background },
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
