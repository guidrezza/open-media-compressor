# Open Media Compressor

An ultra-minimalist, "Brutalist" single-page web application for media compression. It runs entirely in the browser using **WebCodecs** and **Web Workers** for high-performance, non-blocking compression.

## Features

- **Privacy First**: All processing happens locally on your device. No data is ever sent to a server.
- **Videos**: Compressed to **H.264 (.mp4)** with exactly targeted bitrates using native browser hardware acceleration via WebCodecs.
- **Images**: Intelligently compressed to **WebP** to hit target sizes.
- **High Performance**: Uses a dedicated Web Worker to ensure the UI remains responsive, even during heavy 4K video compression.
- **Brutalist Aesthetic**: Built with a sleek, high-contrast dark mode using **Alpine.js**.

## Technology Stack

- **Core**: Native `WebCodecs` API + `mp4box.js` + `mp4-muxer`.
- **UI**: `Alpine.js` + Vanilla CSS.
- **Build**: Vite.

## Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   ```

## Credits

Open-source and 100% free. Made by [guidrezza](https://guidrezza.com).
