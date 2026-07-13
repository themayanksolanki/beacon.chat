import { Platform } from "react-native";
import { GiphySDK, type GiphyMedia } from "@giphy/react-native-sdk";

// GIPHY issues a separate SDK key per platform (each is bound to the app's
// bundle id / package name) — see developers.giphy.com/dashboard.
const GIPHY_API_KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_GIPHY_API_KEY_IOS,
  android: process.env.EXPO_PUBLIC_GIPHY_API_KEY_ANDROID,
});

let configured = false;

/** Configures the GIPHY SDK once per app session. Returns false (a no-op) if no SDK key is set for this platform — check isGifPickerAvailable() first to gate the UI. */
export function ensureGiphyConfigured(): boolean {
  if (configured) return true;
  if (!GIPHY_API_KEY) return false;

  GiphySDK.configure({ apiKey: GIPHY_API_KEY });
  configured = true;
  return true;
}

export function isGifPickerAvailable(): boolean {
  return !!GIPHY_API_KEY;
}

export interface PickedGif {
  url: string;
  width: number;
  height: number;
}

// "downsized" is GIPHY's capped-filesize rendition (~2MB max) — plenty sharp
// at chat-bubble size without the "original" rendition's sometimes-huge
// payload. Only this URL/width/height is ever used; nothing else from the
// native GiphyMedia object leaves this module.
export function mediaToPickedGif(media: GiphyMedia): PickedGif | null {
  const rendition = media.data.images.downsized;
  if (!rendition?.url) return null;
  return { url: rendition.url, width: rendition.width || 0, height: rendition.height || 0 };
}
