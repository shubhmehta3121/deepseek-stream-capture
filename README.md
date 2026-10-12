# DeepSeek Stream Capture

When DeepSeek chat hits a content filter, the UI can replace your answer with a generic refusal—even though the model already streamed thinking + response text. This extension listens to the chat **SSE stream** in your browser and saves that text locally so you can view or copy it afterward.

**Browser:** Built and tested for **Google Chrome** (Manifest V3). Other **Chromium** browsers (Edge, Brave, Opera, etc.) often work the same way with **Load unpacked**; this project does not target Firefox or Safari.

**Not affiliated with DeepSeek.** Captured text stays in **`chrome.storage.local`** on your machine (no backend).

---

## Install (Chrome)

1. **Get the code** — clone this repo or download and unzip it. You need the folder that contains `manifest.json`.
2. Open **`chrome://extensions`** in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select that folder (not a single file inside it).
5. Open **[chat.deepseek.com](https://chat.deepseek.com)** (or refresh an already open tab with **Ctrl+Shift+R** / **Cmd+Shift+R** on Mac).

You should see a small **dock** in the top-right while a reply is generating.

After you change extension code: go to `chrome://extensions` → **Reload** on this extension, then hard-refresh the DeepSeek tab.

---

## How to use

- During generation, the dock shows **Receiving stream** with growing think/response character counts.
- If DeepSeek shows a filter message (e.g. *"Sorry, that's beyond my current scope..."*), the dock turns amber, the panel can open, and **Copy recovered text** may appear when a capture matched that message.
- After a normal completion (no filter), use **Open stream** on the dock to inspect what was captured.
- Expand the dock (chevron) for **View** / **Copy**.

### Per-message storage (v1.4)

- Saves captures under **`chrome.storage.local`**, keyed by chat id (URL `s/{uuid}`) and message id when DeepSeek sends it in SSE.
- Reopen the same chat later in the **same Chrome profile**: matching refusal rows can offer **Copy recovered text** / **Open panel**.
- **`dsc_last_capture`** holds the most recent capture for quick View/Copy on the dock.

### Test the filter UI without a real failure

1. Run any chat completion so the extension has a capture.
2. Double-click the dock subtitle (**Preview demo**).
3. Confirm amber dock, panel badge, toast, and copy actions.

---

## Troubleshooting

- **Tab feels stuck after a filter:** reload the extension on `chrome://extensions`, then hard-refresh the chat tab.
- Dock should show **Receiving stream** during generation; if not, confirm the extension is enabled and the tab URL is `https://chat.deepseek.com/...`.
- Red failed `query` rows in DevTools → Network are often unrelated; chat SSE may be `completion`, `query`, or `edit_message` with `text/event-stream`.

---

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config |
| `inject.js` | Page context: fetch + SSE XHR hooks, SSE parser |
| `content.js` | Dock, panel, toasts |
| `styles.css` | Dock/panel styling |
