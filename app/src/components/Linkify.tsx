import type { ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";

import { openLink, splitIntoLinkSegments } from "../chat/linkify";
import { useTheme } from "../ThemeContext";

interface Props {
  text: string;
  style: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
  // Rendered as a final nested <Text> child, in the same flowing paragraph
  // as `text` — lets a trailing bit (e.g. ChatScreen's inline timestamp)
  // share the last line with short text instead of always sitting on its
  // own line below. Only makes sense as inline Text-compatible content
  // (nested Text/icon-font components), same constraint nested Text always
  // has in React Native.
  trailing?: ReactNode;
}

/**
 * Renders `text` with any recognized URLs (see chat/linkify.ts) turned into
 * tappable nested <Text> segments — React Native supports mixed styling
 * within one paragraph via nested Text, so link and plain segments stay in
 * the same flowing line instead of breaking into separate blocks. Runs the
 * same regex at render time for every message, old or new, so link
 * recognition needs no migration or stored flag on the message itself.
 */
export default function Linkify({ text, style, linkStyle, numberOfLines, trailing }: Props) {
  const { colors } = useTheme();
  const segments = splitIntoLinkSegments(text);

  if (!segments.some((segment) => segment.isLink)) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
        {trailing}
      </Text>
    );
  }

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((segment, index) =>
        segment.isLink ? (
          <Text
            key={index}
            style={linkStyle ?? { color: colors.accent, textDecorationLine: "underline" }}
            onPress={() => void openLink(segment.text)}
          >
            {segment.text}
          </Text>
        ) : (
          <Text key={index}>{segment.text}</Text>
        )
      )}
      {trailing}
    </Text>
  );
}
