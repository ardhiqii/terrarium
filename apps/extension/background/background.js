/**
 * MV3 service worker. Its only job: perform the actual `fetch()` to the
 * creature API on behalf of content scripts and the popup.
 *
 * Why this exists at all, instead of content.js calling fetch() directly:
 * verified empirically while testing this extension against a real
 * github.com page, a content script's own fetch() is still blocked by the
 * host page's Content-Security-Policy `connect-src` in current Chrome,
 * even though content scripts run in an "isolated world" for JS execution.
 * Isolation covers script execution, not the page's CSP-governed network
 * policy. A service worker has no such page to inherit a CSP from: it runs
 * in the extension's own context, governed by the extension's
 * host_permissions, which is exactly the privilege this fetch needs.
 *
 * No remote code is ever loaded or executed here (MV3 forbids it anyway);
 * this only ever calls `fetch` on a URL built from the configured API base
 * plus a handle/repo, and returns parsed JSON or an error string.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'GC_FETCH' || typeof message.url !== 'string') {
    return false
  }

  ;(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(message.url, { signal: controller.signal })
      if (!response.ok) {
        sendResponse({ ok: false, error: `http ${response.status}` })
        return
      }
      const data = await response.json()
      sendResponse({ ok: true, data })
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
    } finally {
      clearTimeout(timeout)
    }
  })()

  return true // keep the message channel open for the async sendResponse above
})
