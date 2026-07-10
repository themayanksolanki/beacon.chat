import { Platform } from "react-native";
import { GiphyContentType, GiphyDialog, GiphySDK, type GiphyMedia } from "@giphy/react-native-sdk";

// GIPHY issues a separate SDK key per platform (each is bound to the app's
// bundle id / package name) — see developers.giphy.com/dashboard.
const GIPHY_API_KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_GIPHY_API_KEY_IOS,
  android: process.env.EXPO_PUBLIC_GIPHY_API_KEY_ANDROID,
});

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!GIPHY_API_KEY) return false;

  GiphySDK.configure({ apiKey: GIPHY_API_KEY });
  GiphyDialog.configure({
    mediaTypeConfig: [GiphyContentType.Gif],
    showConfirmationScreen: false,
  });
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
function toPickedGif(media: GiphyMedia): PickedGif | null {
  const rendition = media.data.images.downsized;
  if (!rendition?.url) return null;
  return { url: rendition.url, width: rendition.width || 0, height: rendition.height || 0 };
}

/**
 * Opens the native GIPHY search/browse dialog (configured for GIFs only) and
 * resolves with the picked GIF, or null if the user dismissed it without
 * picking one (also null if no SDK key is configured for this platform —
 * check isGifPickerAvailable() first to tell those cases apart for the UI).
 */
export function pickGif(): Promise<PickedGif | null> {
  if (!ensureConfigured()) return Promise.resolve(null);

  return new Promise((resolve) => {
    const mediaSub = GiphyDialog.addListener("onMediaSelect", (e) => {
      mediaSub.remove();
      dismissSub.remove();
      resolve(toPickedGif(e.media));
    });
    const dismissSub = GiphyDialog.addListener("onDismiss", () => {
      mediaSub.remove();
      dismissSub.remove();
      resolve(null);
    });
    GiphyDialog.show();
  });
}
