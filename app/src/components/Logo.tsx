import { Image, StyleSheet, View } from "react-native";

interface Props {
  size?: number;
}

const DEFAULT_SIZE = 96;

// Single shared brand mark — used on every auth/onboarding screen
// (EmailEntry, Otp, NameEntry, ProfilePhoto) so the logo is consistent
// across sign-in and sign-up. Rounded-square "app icon" tile rather than
// a circle crop, since a circular mask cuts off the corner glyphs in
// assets/logo.png.
export default function Logo({ size = DEFAULT_SIZE }: Props) {
  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size * 0.24 }]}>
      <Image source={require("../../assets/logo.png")} style={styles.image} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  image: { width: "100%", height: "100%" },
});
