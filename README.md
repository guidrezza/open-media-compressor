# Open Media Compressor

An ultra-minimalist, "Brutalist" single-page web application for media compression. It runs entirely in the browser using Vite for a seamless local development experience with proper security headers.

## Features

- **Privacy First**: All processing happens locally using `ffmpeg.wasm` and the Canvas API.
- **Videos**: Compressed to **AV1 (.mp4)** with exactly targeted bitrates.
- **Audio**: Automatically capped at **64 kbps** (Opus or AAC) to maximize video quality.
- **Images**: Iteratively compressed to **WebP** to hit target size.
- **GIFs**: Converted to **Animated WebP** with looping enabled.
- **Smart Verification**: Automatically re-runs compression with lower quality if the target size is exceeded.
- **Brutalist Aesthetic**: Built with a sleek, high-contrast dark mode.

## Deployment Requirements

### COOP/COEP Headers
Because this app uses `ffmpeg.wasm`, it relies on `SharedArrayBuffer`. For security reasons, modern browsers require **Cross-Origin Isolation**. Your server **MUST** serve the application with the following HTTP headers:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

### Hosting
Ensure your hosting provider allows you to set custom headers (e.g., Vercel, Netlify, Cloudflare Pages). If these headers are missing, the app will fail to load the compression engine.


## Credits
Open-source and 100% free. Made by [guidrezza](https://guidrezza.com).

