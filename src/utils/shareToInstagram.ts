/**
 * Instagram Stories direct-share helper.
 *
 * Apple's documented Instagram Stories integration: write a typed
 * pasteboard attachment under `com.instagram.sharedSticker.backgroundImage`
 * (5-min expiry), then open `instagram-stories://share`. Instagram reads
 * the pasteboard, opens the Story composer, and pre-loads our card as
 * the background. The user can then tap text / stickers / share — same
 * UX Strava ships.
 *
 * `react-native-share` handles the pasteboard write + URL open in one
 * call. We wrap it here so consumers get:
 *   • Lazy import (the JS module is optional in this build until the
 *     native rebuild ships react-native-share).
 *   • Instagram-installed detection via `Linking.canOpenURL` —
 *     `LSApplicationQueriesSchemes` in app.json must include
 *     `instagram-stories` for this check to return true.
 *   • Graceful fallback to the generic iOS share sheet via
 *     `expo-sharing` when Instagram isn't installed.
 *
 * The PNG is read from a file URI returned by `ViewShot.capture()`.
 * react-native-share accepts a base64 data URL too; we use file URI
 * because it's smaller / faster than base64-encoding the image.
 */

import { Linking } from 'react-native';

export type ShareToStoriesResult =
  | { ok: true; method: 'stories' }
  | { ok: true; method: 'fallback_share_sheet' }
  | { ok: false; reason: 'instagram_not_installed' | 'native_module_missing' | 'user_cancelled' | 'failed'; message?: string };

/** True when Instagram is installed AND iOS reports `instagram-stories`
 *  is openable. Returns false when:
 *   • Instagram isn't installed
 *   • LSApplicationQueriesSchemes doesn't list `instagram-stories`
 *   • Running on web / Android without Instagram
 *  Use this to conditionally show a "Stories" button. */
export async function isInstagramStoriesAvailable(): Promise<boolean> {
  try {
    return await Linking.canOpenURL('instagram-stories://share');
  } catch {
    return false;
  }
}

/** Open Instagram's Story composer with the given image as background.
 *  When Instagram isn't installed, falls back to the generic iOS share
 *  sheet so the user can still post via Messages / Mail / etc.
 *
 *  Two layout modes (Strava-style):
 *   • Background-only: pass `imageUri` (the legacy single-image flow).
 *     Instagram puts that image as the full-screen Story background.
 *   • Sticker overlay: pass `stickerImage` (the transparent stats card)
 *     plus an optional `backgroundImage` (a user-picked photo). The
 *     background fills the canvas; the sticker sits on top, draggable
 *     by the user. If `backgroundImage` is omitted, Instagram falls
 *     back to the `backgroundTop/BottomColor` gradient.
 *
 *  All image inputs should be file:// URIs (typically from
 *  ViewShot.capture). */
export async function shareToInstagramStories(opts: {
  imageUri?: string;          // Legacy: single image used as background
  backgroundImage?: string;   // User-picked photo (Strava-style bg)
  stickerImage?: string;      // Transparent sticker card overlaid on bg
  appId?: string;             // Defaults to bundle id 'com.thallo.app'
  backgroundTopColor?: string;
  backgroundBottomColor?: string;
}): Promise<ShareToStoriesResult> {
  const fallbackImage = opts.imageUri ?? opts.stickerImage ?? opts.backgroundImage;
  if (!fallbackImage) {
    return { ok: false, reason: 'failed', message: 'No image provided to share.' };
  }

  const installed = await isInstagramStoriesAvailable();
  if (!installed) {
    // Fall back to the generic iOS share sheet so the user still has
    // SOME way to share — they can pick Instagram from there if they
    // have a different version of the app, or post elsewhere. Prefer
    // the full rendered card when callers provide one.
    try {
      const Sharing = await import('expo-sharing');
      const can = await Sharing.isAvailableAsync();
      if (!can) {
        return { ok: false, reason: 'instagram_not_installed', message: 'Install Instagram to share to Stories.' };
      }
      await Sharing.shareAsync(fallbackImage, {
        mimeType: 'image/png',
        dialogTitle: 'Share Workout',
      });
      return { ok: true, method: 'fallback_share_sheet' };
    } catch (e: any) {
      return { ok: false, reason: 'failed', message: e?.message };
    }
  }

  // Lazy-require react-native-share so the JS bundle still parses on
  // builds that haven't been rebuilt yet (the dep is in package.json
  // but the native side requires a fresh prebuild + run).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Share: any;
  try {
    Share = (await import('react-native-share' as any)).default;
  } catch {
    return { ok: false, reason: 'native_module_missing', message: 'Run npx expo prebuild + rebuild to enable Instagram Stories share.' };
  }

  // Resolve which fields go into the pasteboard. Sticker mode wins
  // when stickerImage is present; otherwise fall back to the legacy
  // single-image background flow.
  const payload: Record<string, unknown> = {
    social: Share.Social?.INSTAGRAM_STORIES ?? 'instagramstories',
    appId: opts.appId ?? 'com.thallo.app',
    // Top/bottom colors paint the canvas around the image when no
    // backgroundImage is provided, or behind a transparent sticker.
    // Strava uses orange→deep-orange; we default to Thallo dark→teal.
    backgroundTopColor: opts.backgroundTopColor ?? '#0D0F14',
    backgroundBottomColor: opts.backgroundBottomColor ?? '#15C7B8',
  };
  if (opts.stickerImage) {
    payload.stickerImage = opts.stickerImage;
    if (opts.backgroundImage) payload.backgroundImage = opts.backgroundImage;
  } else {
    payload.backgroundImage = opts.backgroundImage ?? opts.imageUri;
  }

  try {
    await Share.shareSingle(payload);
    return { ok: true, method: 'stories' };
  } catch (e: any) {
    // user_cancelled is the expected error when the user backs out of
    // the Story composer. Don't surface it as an error to the UI.
    const message = String(e?.message ?? '').toLowerCase();
    if (message.includes('cancel') || message.includes('user did not share')) {
      return { ok: false, reason: 'user_cancelled' };
    }
    return { ok: false, reason: 'failed', message: e?.message };
  }
}
