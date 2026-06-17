// Native desktop notifications via the Tauri notification plugin. Best-effort:
// a no-op in the browser demo and whenever permission is unavailable or denied,
// so a notification failure can never disrupt a scan.

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./api";

/** Post a desktop notification, requesting OS permission once if not yet granted. */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notifications are a nicety; swallow any plugin/permission error.
  }
}
