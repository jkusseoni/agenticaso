/**
 * Best-effort homepage persistence. Does not await the network call.
 * The ChatGPT link opens from the anchor href, independent of this request.
 */
export function notifyChatgptPluginClick() {
  try {
    void fetch("/api/funnel", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    /* Analytics must not block the ChatGPT link. */
  }
}
