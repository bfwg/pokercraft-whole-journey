# PokerCraft Whole Journey

Chrome extension that removes the 3-month date range restriction on [PokerCraft](https://my.pokercraft.com) session history, allowing you to view your complete poker journey.

## What it does

- **Unlocks date picker** — select any past date, not just the last 3 months
- **Auto-chunks large requests** — splits date ranges into 85-day chunks and merges results transparently
- **Handles encrypted API responses** — decrypts, merges, and re-encrypts so the app works normally
- **Blocks future dates** — keeps future dates and months disabled since there's no data there

## Install

### From source (developer mode)

1. Clone this repo
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `extension/` folder

### From Chrome Web Store

_Coming soon_

## Development

The entire extension is a single content script (`extension/content.js`) injected into `my.pokercraft.com` in the `MAIN` world at `document_start`.

To enable debug logging, set `DEBUG = true` at the top of `content.js`:

```js
const DEBUG = true; // Set to true to enable console logging
```

After making changes, go to `chrome://extensions/` and click the reload button on the extension.

### Build for Chrome Web Store

```bash
cd extension && zip -r ../pokercraft-whole-journey.zip . -x ".*"
```
