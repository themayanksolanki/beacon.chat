import { useEffect, useMemo, useRef } from "react";
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";
import type { MessageMenuAnchor } from "./MessageActionMenu";

export interface AttachmentSheetProps {
  visible: boolean;
  anchor: MessageMenuAnchor | null;
  onClose: () => void;
  onPickImages: () => void;
  onPickVideo: () => void;
  onPickAudio: () => void;
}

interface Row {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

const CARD_WIDTH = 200;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 8;

// Anchored popover — always opens directly above the plus button that
// triggers it (see ChatScreen's attachmentButtonRef), same measure-and-
// position pattern as MessageActionMenu. anchor.y is re-measured fresh right
// before every open, so this stays correctly placed whether the keyboard
// (and therefore the input row/button) is currently open or closed — it
// never relies on a stale remembered position. Anchoring the card's *bottom*
// edge a fixed gap above anchor.y (rather than computing a top offset) means
// its own height never has to be known in advance for it to land in the
// right place.
export default function AttachmentSheet({
  visible,
  anchor,
  onClose,
  onPickImages,
  onPickVideo,
  onPickAudio,
}: AttachmentSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    scale.setValue(0.92);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 8, tension: 90, useNativeDriver: true }),
    ]).start();
  }, [visible, opacity, scale]);

  if (!anchor) return null;

  const { height: screenHeight, width: screenWidth } = Dimensions.get("window");
  const bottom = screenHeight - anchor.y + ANCHOR_GAP;
  const left = Math.min(
    Math.max(SCREEN_MARGIN, anchor.x + anchor.width / 2 - CARD_WIDTH / 2),
    screenWidth - CARD_WIDTH - SCREEN_MARGIN
  );

  const rows: Row[] = [
    { label: "Images", icon: "images-outline", onPress: onPickImages },
    { label: "Video", icon: "videocam-outline", onPress: onPickVideo },
    { label: "Audio", icon: "musical-notes-outline", onPress: onPickAudio },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Animated.View style={[styles.menuWrap, { bottom, left, opacity, transform: [{ scale }] }]}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            {rows.map((row) => (
              <Pressable
                key={row.label}
                style={styles.item}
                onPress={() => {
                  row.onPress();
                  onClose();
                }}
              >
                <View style={styles.iconBackground}>
                  <Ionicons name={row.icon} size={15} color={colors.accent} />
                </View>
                <Text style={styles.itemLabel} numberOfLines={1}>
                  {row.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    menuWrap: { position: "absolute", width: CARD_WIDTH },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      flexDirection: "row",
      justifyContent: "space-around",
      paddingVertical: 10,
      paddingHorizontal: 4,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    },
    item: {
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 2,
    },
    // The icon's own footprint is much narrower than most labels below it —
    // a fixed-size tinted circle behind the icon gives every item the same
    // visual width regardless of glyph size, so the row reads as evenly
    // spaced instead of the icons looking small/lost next to their labels.
    iconBackground: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.accentSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    itemLabel: { fontSize: 10.5, color: colors.text },
  });
