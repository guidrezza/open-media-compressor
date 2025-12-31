import MP4Box from 'mp4box';
import * as Mp4Muxer from 'mp4-muxer';

self.onmessage = async (e) => {
    const { file, targetSizeBytes, config } = e.data;

    try {
        await compress(file, targetSizeBytes, config);
    } catch (err) {
        console.error('Worker error:', err);
        self.postMessage({ type: 'error', message: err.message });
    }
};

async function compress(file, targetSizeBytes, config) {
    // 1. Read file
    const arrayBuffer = await file.arrayBuffer();
    arrayBuffer.fileStart = 0; // MP4Box requirement

    // 2. Parse & Extract
    const mp4boxfile = MP4Box.createFile();
    let videoTrack = null;

    self.postMessage({ type: 'status', message: 'Parsing and extracting...' });

    const samplesPromise = new Promise((resolve, reject) => {
        let extractedSamples = [];
        let processingStarted = false;
        let extractionTimeoutId = null;

        // Add 10s timeout for parsing start
        const timeoutId = setTimeout(() => {
            if (!processingStarted) {
                reject(new Error('Timeout: File parsing took too long or format not supported (is it a valid MP4/MOV?)'));
            }
        }, 10000);

        mp4boxfile.onReady = (info) => {
            clearTimeout(timeoutId);
            processingStarted = true;
            videoTrack = info.videoTracks[0];

            if (!videoTrack) {
                reject(new Error('No video track found in file'));
                return;
            }

            self.postMessage({
                type: 'status',
                message: `Found video track: ${videoTrack.video.width}x${videoTrack.video.height}, ${videoTrack.nb_samples} samples`
            });

            // Set a new timeout specifically for extraction
            extractionTimeoutId = setTimeout(() => {
                reject(new Error(`Timeout during sample extraction. Extracted ${extractedSamples.length}/${videoTrack.nb_samples} samples.`));
            }, 20000); // 20s for extraction

            mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: videoTrack.nb_samples });
            mp4boxfile.start();

            mp4boxfile.onSamples = (id, user, newSamples) => {
                extractedSamples = extractedSamples.concat(newSamples);

                if (extractedSamples.length >= videoTrack.nb_samples) {
                    // We have everything, no need to wait for Flush
                    clearTimeout(extractionTimeoutId);
                    resolve(extractedSamples);
                    return;
                }

                if (extractedSamples.length % 100 === 0) {
                    self.postMessage({
                        type: 'status',
                        message: `Extracting: ${extractedSamples.length} / ${videoTrack.nb_samples} samples...`
                    });
                }
            };

            mp4boxfile.onFlush = () => {
                clearTimeout(extractionTimeoutId);
                // Only resolve if we haven't already (though promise resolves once)
                // If onSamples caught it, this does nothing.
                if (extractedSamples.length > 0) {
                    resolve(extractedSamples);
                } else {
                    reject(new Error('No samples extracted from file via MP4Box (onFlush)'));
                }
            };
        };

        mp4boxfile.onError = (e) => {
            clearTimeout(timeoutId); // Clear initial timeout
            if (extractionTimeoutId) { // Clear extraction timeout if it was set
                clearTimeout(extractionTimeoutId);
            }
            reject(new Error('MP4Box error: ' + e));
        }
    });

    mp4boxfile.appendBuffer(arrayBuffer);
    mp4boxfile.flush();

    let samples;
    try {
        samples = await samplesPromise;
    } catch (e) {
        throw new Error(`Parsing failed: ${e.message}`);
    }

    const totalSamples = samples.length;

    if (!videoTrack) {
        throw new Error('No video track identified');
    }

    if (totalSamples === 0) {
        throw new Error('No video samples found');
    }

    // 3. Calculate Duration & Bitrate
    let durationSec = 0;

    // Prefer metadata duration if valid
    if (videoTrack.duration && videoTrack.timescale) {
        durationSec = videoTrack.duration / videoTrack.timescale;
    } else if (mp4boxfile.moov && mp4boxfile.moov.mvhd) {
        durationSec = mp4boxfile.moov.mvhd.duration / mp4boxfile.moov.mvhd.timescale;
    }

    // Fallback to sample calculation if metadata is 0 or missing
    if (!durationSec || durationSec <= 0) {
        const firstSample = samples[0];
        const lastSample = samples[totalSamples - 1];
        const durationInTimescale = (lastSample.cts + lastSample.duration) - firstSample.cts;
        durationSec = durationInTimescale / videoTrack.timescale;
    }

    if (!durationSec || durationSec <= 0) {
        throw new Error('Could not calculate valid duration from file metadata');
    }

    // 4. Calculate Bitrate
    // Target Size (bits) * 0.96 (4% overhead safety for container + fluctuation) / Duration (sec)
    const safetyFactor = 0.96;
    let targetBitrate = Math.floor((targetSizeBytes * 8 * safetyFactor) / durationSec);

    // Clamp min bitrate but warn
    const MIN_BITRATE = 50000; // 50 kbps
    let wasClamped = false;
    if (targetBitrate < MIN_BITRATE) {
        targetBitrate = MIN_BITRATE;
        wasClamped = true;
    }

    self.postMessage({
        type: 'status',
        message: `Video: ${durationSec.toFixed(1)}s. Target: ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB. Bitrate: ${Math.round(targetBitrate / 1000)}k${wasClamped ? ' (min-clamped)' : ''}`
    });

    await processVideo(mp4boxfile, videoTrack, targetBitrate, samples);
}

async function processVideo(mp4boxfile, track, bitrate, samples) {
    const totalSamples = samples.length;
    let encodedFrames = 0;

    // Determine scale factor based on bitrate and resolution
    // Standard bitrate guidelines: 1080p needs ~2-4Mbps, 720p ~1-2Mbps, 480p ~0.5-1Mbps
    let scale = 1;
    let targetWidth = track.video.width;
    let targetHeight = track.video.height;

    // Simple heuristic: if we are starved for bitrate, downscale
    const pixelCount = targetWidth * targetHeight;
    const bitsPerPixel = bitrate / (pixelCount * 30); // assuming 30fps

    // If BPP is very low (< 0.05), quality will be trash, downscale.
    // Or closer manual thresholds:
    if (bitrate < 2000000 && targetHeight > 1080) { // < 2Mbps && > 1080p -> 1080p or 720p
        scale = 1080 / targetHeight;
    }
    // Re-check after potential first downscale or if original was 1080p
    // Note: using 'targetHeight * scale' for checks would be cleaner but let's iterate

    // Easier logic: Target a resolution that fits the bitrate
    if (bitrate < 1000000) { // < 1Mbps -> Target 480p
        const desiredHeight = 480;
        if (targetHeight > desiredHeight) {
            scale = desiredHeight / targetHeight;
        }
    } else if (bitrate < 2500000) { // < 2.5Mbps -> Target 720p
        const desiredHeight = 720;
        if (targetHeight > desiredHeight) {
            scale = desiredHeight / targetHeight;
        }
    }

    // Ensure even dimensions
    let finalWidth = Math.round(targetWidth * scale);
    let finalHeight = Math.round(targetHeight * scale);
    if (finalWidth % 2 !== 0) finalWidth--;
    if (finalHeight % 2 !== 0) finalHeight--;

    // Log the decision
    if (scale < 1) {
        self.postMessage({
            type: 'status',
            message: `Downscaling to ${finalWidth}x${finalHeight} to fit target size...`
        });
    }

    // Prepare OffscreenCanvas for resizing if needed
    let canvas = null;
    let ctx = null;
    if (scale < 1) {
        // OffscreenCanvas is available in Workers
        canvas = new OffscreenCanvas(finalWidth, finalHeight);
        ctx = canvas.getContext('2d');
        // optimize for quality
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
    }

    // 5. Setup Muxer
    const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: {
            codec: 'avc',
            width: finalWidth,
            height: finalHeight
        },
        fastStart: 'in-memory'
    });

    // 6. Setup Encoder - track progress on output
    const encoder = new VideoEncoder({
        output: (chunk, meta) => {
            muxer.addVideoChunk(chunk, meta);
            encodedFrames++;
            // Report progress based on encoded frames
            if (encodedFrames % 10 === 0 || encodedFrames === totalSamples) {
                const progress = Math.round((encodedFrames / totalSamples) * 100);
                self.postMessage({ type: 'progress', value: progress });
            }
        },
        error: (e) => {
            self.postMessage({ type: 'error', message: 'Encoder error: ' + e.message });
        }
    });

    // Helper to get matching level conf
    const getConf = (codecStr) => ({
        codec: codecStr,
        width: finalWidth,
        height: finalHeight,
        bitrate: bitrate,
        framerate: 30,
        bitrateMode: 'constant' // Force CBR to strictly respect limit
    });

    // Fallback for variable if constant not supported
    const getConfVar = (codecStr) => ({
        codec: codecStr,
        width: finalWidth,
        height: finalHeight,
        bitrate: bitrate,
        framerate: 30,
    });

    // Try High 4.2 -> Main 4.2 -> Baseline 4.2 -> High 5.1
    // Try Constant first, then Variable
    const codecs = ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.640033'];
    const configsToTry = [];
    codecs.forEach(c => configsToTry.push(getConf(c)));
    codecs.forEach(c => configsToTry.push(getConfVar(c)));

    let selectedConfig = null;
    self.postMessage({ type: 'status', message: 'Configuring Encoder...' });

    for (const config of configsToTry) {
        try {
            const support = await VideoEncoder.isConfigSupported(config);
            if (support.supported) {
                selectedConfig = config;
                break;
            }
        } catch (e) { }
    }

    if (!selectedConfig) selectedConfig = configsToTry[0]; // fallback

    try {
        encoder.configure(selectedConfig);
    } catch (e) {
        throw new Error(`Encoder config failed (${selectedConfig.codec}): ${e.message}`);
    }

    // 7. Setup Decoder
    self.postMessage({ type: 'status', message: 'Configuring Decoder...' });
    const decoder = new VideoDecoder({
        output: (frame) => {
            if (scale < 1 && ctx) {
                // Draw to resize
                ctx.drawImage(frame, 0, 0, finalWidth, finalHeight);
                const scaledFrame = new VideoFrame(canvas, {
                    timestamp: frame.timestamp,
                    duration: frame.duration
                });
                encoder.encode(scaledFrame);
                scaledFrame.close();
            } else {
                encoder.encode(frame);
            }
            frame.close();
        },
        error: (e) => {
            self.postMessage({ type: 'error', message: 'Decoder error: ' + e.message });
        }
    });

    try {
        const description = getTrackDescription(mp4boxfile, track);
        decoder.configure({
            codec: track.codec,
            codedWidth: track.video.width,
            codedHeight: track.video.height,
            description: description
        });
    } catch (e) {
        throw new Error('Decoder configuration failed: ' + e.message);
    }

    // 8. Process Loop with backpressure management
    self.postMessage({ type: 'status', message: `Encoding ${totalSamples} frames...` });
    self.postMessage({ type: 'progress', value: 0 });

    const QUEUE_LIMIT = 10; // Max items in queue before waiting

    for (let i = 0; i < totalSamples; i++) {
        const sample = samples[i];

        const type = sample.is_sync ? 'key' : 'delta';
        const chunk = new EncodedVideoChunk({
            type: type,
            timestamp: (sample.cts / track.timescale) * 1_000_000,
            duration: (sample.duration / track.timescale) * 1_000_000,
            data: sample.data
        });

        // Backpressure: wait if decoder or encoder queues are too full
        while (decoder.decodeQueueSize > QUEUE_LIMIT || encoder.encodeQueueSize > QUEUE_LIMIT) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        decoder.decode(chunk);
    }

    // Flush pipeline
    await decoder.flush();
    await encoder.flush();
    muxer.finalize();

    const buffer = muxer.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });

    self.postMessage({ type: 'progress', value: 100 });
    self.postMessage({ type: 'done', blob: blob });
}

function getTrackDescription(mp4boxfile, track) {
    const traks = mp4boxfile.moov.traks;
    const t = traks.find(t => t.tkhd.track_id === track.id);
    if (!t) return undefined;

    const entry = t.mdia.minf.stbl.stsd.entries[0];
    if (!entry) return undefined;

    // Try to find avcC or hvcC (for HEVC)
    const box = entry.avcC || entry.hvcC;
    if (box) {
        const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(stream);
        // avcC box layout: [size (4)][type (4)][data...]
        // We want the data, so skip 8 bytes.
        return new Uint8Array(stream.buffer, 8);
    }

    // For some tracks (like HVC1), description might be in different boxes or optional
    // WebCodecs sometimes handles it without description for some containers.
    return undefined;
}
