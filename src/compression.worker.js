import MP4Box from 'mp4box';
import * as Mp4Muxer from 'mp4-muxer';
import { sanitizeMp4Blob } from './media_sanitizers.js';
import {
    buildVideoEncodePlan,
    chooseScaledDimensions,
    getRetryBitrate
} from './video_utils.js';

self.onmessage = async (e) => {
    const { file, targetSizeBytes } = e.data;

    try {
        await compress(file, targetSizeBytes);
    } catch (err) {
        console.error('Worker error:', err);
        self.postMessage({ type: 'error', message: err.message });
    }
};

async function compress(file, targetSizeBytes) {
    // 1. Read file
    const arrayBuffer = await file.arrayBuffer();
    arrayBuffer.fileStart = 0; // MP4Box requirement

    // 2. Parse & Extract
    const mp4boxfile = MP4Box.createFile();
    let videoTrack = null;
    let audioTrack = null;

    self.postMessage({ type: 'status', message: 'Parsing and extracting...' });

    const samplesPromise = new Promise((resolve, reject) => {
        let extractedVideoSamples = [];
        let extractedAudioSamples = [];
        let processingStarted = false;
        let extractionTimeoutId = null;
        let settled = false;

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
            audioTrack = info.audioTracks[0] || null;

            if (!videoTrack) {
                reject(new Error('No video track found in file'));
                return;
            }

            // FRAGMENTED MP4 FIX:
            // nb_samples might be 0 or undefined in fragmented files (moov doesn't have stts/stsz).
            // We shouldn't rely on it for completion check if it's suspicious.
            const totalExpectedVideo = videoTrack.nb_samples > 0 ? videoTrack.nb_samples : Infinity;
            const totalExpectedAudio = audioTrack && audioTrack.nb_samples > 0 ? audioTrack.nb_samples : (audioTrack ? Infinity : 0);
            const isFragmentedVideo = totalExpectedVideo === Infinity;
            const isFragmentedAudio = audioTrack ? totalExpectedAudio === Infinity : false;

            self.postMessage({
                type: 'status',
                message: `Found video track: ${videoTrack.video.width}x${videoTrack.video.height}, ${isFragmentedVideo ? 'Fragmented (unknown count)' : totalExpectedVideo + ' samples'}${audioTrack ? ` + audio track (${isFragmentedAudio ? 'unknown' : totalExpectedAudio} samples)` : ''}`
            });

            // Set a new timeout specifically for extraction
            extractionTimeoutId = setTimeout(() => {
                reject(new Error(`Timeout during sample extraction. Extracted ${extractedVideoSamples.length} video samples and ${extractedAudioSamples.length} audio samples.`));
            }, 30000); // 30s for extraction

            // If nb_samples is 0/Infinity, pass a large number to extraction options or null to extract all?
            // MP4Box documentation says nbSamples is for how many to extract.
            // If we want all, we can pass something large.
            const extractVideoCount = isFragmentedVideo ? 1000000 : totalExpectedVideo;
            mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: extractVideoCount });

            if (audioTrack) {
                const extractAudioCount = isFragmentedAudio ? 1000000 : totalExpectedAudio;
                mp4boxfile.setExtractionOptions(audioTrack.id, null, { nbSamples: extractAudioCount });
            }
            mp4boxfile.start();

            mp4boxfile.onSamples = (id, user, newSamples) => {
                if (id === videoTrack.id) {
                    extractedVideoSamples = extractedVideoSamples.concat(newSamples);
                } else if (audioTrack && id === audioTrack.id) {
                    extractedAudioSamples = extractedAudioSamples.concat(newSamples);
                }

                const hasAllVideo = extractedVideoSamples.length >= totalExpectedVideo;
                const hasAllAudio = !audioTrack || extractedAudioSamples.length >= totalExpectedAudio;

                if (!settled && hasAllVideo && hasAllAudio) {
                    // We have everything, no need to wait for Flush
                    settled = true;
                    clearTimeout(extractionTimeoutId);
                    resolve({ videoSamples: extractedVideoSamples, audioSamples: extractedAudioSamples });
                    return;
                }

                if (extractedVideoSamples.length % 100 === 0) {
                    const progressStr = isFragmentedVideo ? `${extractedVideoSamples.length} extracted` : `${extractedVideoSamples.length} / ${totalExpectedVideo}`;
                    self.postMessage({
                        type: 'status',
                        message: `Extracting: ${progressStr} samples...`
                    });
                }
            };

            mp4boxfile.onFlush = () => {
                clearTimeout(extractionTimeoutId);
                // Only resolve if we haven't already (though promise resolves once)
                // If onSamples caught it, this does nothing.
                if (!settled && extractedVideoSamples.length > 0) {
                    settled = true;
                    resolve({ videoSamples: extractedVideoSamples, audioSamples: extractedAudioSamples });
                } else if (!settled) {
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

    const videoSamples = samples.videoSamples;
    const audioSamples = samples.audioSamples;

    const totalSamples = videoSamples.length;

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
        const firstSample = videoSamples[0];
        const lastSample = videoSamples[totalSamples - 1];
        const durationInTimescale = (lastSample.cts + lastSample.duration) - firstSample.cts;
        durationSec = durationInTimescale / videoTrack.timescale;
    }

    if (!durationSec || durationSec <= 0) {
        throw new Error('Could not calculate valid duration from file metadata');
    }

    const audioConfig = getMuxerAudioConfig(audioTrack);
    if (audioTrack && !audioConfig) {
        self.postMessage({
            type: 'status',
            message: `Audio codec ${audioTrack.codec} is not supported for passthrough; output will be video-only.`
        });
    }

    const audioReservationBytes = audioConfig ? estimateAudioPassthroughBytes(audioSamples) : 0;
    const videoTargetBytes = Math.max(1, targetSizeBytes - audioReservationBytes);

    // 4. Calculate bitrate + overhead budget from actual timing
    const encodePlan = buildVideoEncodePlan({
        track: videoTrack,
        samples: videoSamples,
        durationSec,
        targetSizeBytes: videoTargetBytes
    });
    let targetBitrate = encodePlan.targetBitrate;

    self.postMessage({
        type: 'status',
        message: `Video: ${durationSec.toFixed(1)}s at ${encodePlan.frameRate.toFixed(2)}fps. Target: ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB.${audioReservationBytes > 0 ? ` Audio passthrough: ${(audioReservationBytes / 1024).toFixed(0)}KB.` : ''} Reserved overhead: ${(encodePlan.overheadBytes / 1024).toFixed(0)}KB. Bitrate: ${Math.round(targetBitrate / 1000)}k${encodePlan.wasClamped ? ' (min-clamped)' : ''}`
    });

    const maxAttempts = 2;
    let finalBlob = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
            self.postMessage({
                type: 'status',
                message: `Retrying video encode at ${Math.round(targetBitrate / 1000)}kbps to land under target size...`
            });
        }

        const encodedBlob = await processVideo(mp4boxfile, videoTrack, {
            bitrate: targetBitrate,
            frameRate: encodePlan.frameRate,
            videoSamples,
            audioTrack,
            audioSamples,
            audioConfig
        });
        const sanitizedBlob = await sanitizeMp4Blob(encodedBlob);

        finalBlob = sanitizedBlob;

        if (sanitizedBlob.size <= targetSizeBytes || attempt === maxAttempts) {
            break;
        }

        const nextBitrate = getRetryBitrate({
            currentBitrate: targetBitrate,
            actualSizeBytes: sanitizedBlob.size,
            targetSizeBytes
        });

        if (nextBitrate >= targetBitrate) {
            break;
        }

        targetBitrate = nextBitrate;
    }

    self.postMessage({ type: 'progress', value: 100 });
    self.postMessage({ type: 'done', blob: finalBlob });
}

async function processVideo(mp4boxfile, track, { bitrate, frameRate, videoSamples, audioTrack, audioSamples, audioConfig }) {
    const totalSamples = videoSamples.length;
    let encodedFrames = 0;
    let aborted = false;
    let abortError = null;
    let rejectAbort = null;
    let encoder = null;
    let decoder = null;

    const abortPromise = new Promise((_, reject) => {
        rejectAbort = reject;
    });

    const abortWithError = (message) => {
        if (aborted) {
            return;
        }

        aborted = true;
        abortError = message instanceof Error ? message : new Error(message);

        if (decoder) {
            try {
                decoder.close();
            } catch (e) { }
        }

        if (encoder) {
            try {
                encoder.close();
            } catch (e) { }
        }

        rejectAbort(abortError);
    };

    const {
        scale,
        finalWidth,
        finalHeight,
        bitsPerPixelPerFrame
    } = chooseScaledDimensions({
        width: track.video.width,
        height: track.video.height,
        bitrate,
        frameRate
    });

    // Log the decision
    if (scale < 1) {
        self.postMessage({
            type: 'status',
            message: `Downscaling to ${finalWidth}x${finalHeight} to fit target size (${bitsPerPixelPerFrame.toFixed(3)} bpp/f)...`
        });
    }

    // Prepare OffscreenCanvas for resizing if needed
    let canvas = null;
    let ctx = null;
    if (scale < 1) {
        // OffscreenCanvas is available in Workers
        canvas = new OffscreenCanvas(finalWidth, finalHeight);
        ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not create 2D context for video resize');
        }
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
        ...(audioConfig ? { audio: audioConfig } : {}),
        fastStart: 'in-memory'
    });

    // 6. Setup Encoder - track progress on output
    encoder = new VideoEncoder({
        output: (chunk, meta) => {
            if (aborted) {
                return;
            }

            muxer.addVideoChunk(chunk, meta);
            encodedFrames++;
            // Report progress based on encoded frames
            if (encodedFrames % 10 === 0 || encodedFrames === totalSamples) {
                const progress = Math.round((encodedFrames / totalSamples) * 100);
                self.postMessage({ type: 'progress', value: progress });
            }
        },
        error: (e) => {
            abortWithError('Encoder error: ' + e.message);
        }
    });

    // Helper to get matching level conf
    const getConf = (codecStr) => ({
        codec: codecStr,
        width: finalWidth,
        height: finalHeight,
        bitrate: bitrate,
        framerate: frameRate,
        bitrateMode: 'constant' // Force CBR to strictly respect limit
    });

    // Fallback for variable if constant not supported
    const getConfVar = (codecStr) => ({
        codec: codecStr,
        width: finalWidth,
        height: finalHeight,
        bitrate: bitrate,
        framerate: frameRate,
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
    decoder = new VideoDecoder({
        output: (frame) => {
            if (aborted) {
                frame.close();
                return;
            }

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
            abortWithError('Decoder error: ' + e.message);
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
    self.postMessage({ type: 'status', message: `Encoding ${totalSamples} frames at ${frameRate.toFixed(2)}fps...` });
    self.postMessage({ type: 'progress', value: 0 });

    const QUEUE_LIMIT = 10; // Max items in queue before waiting

    const processPipeline = (async () => {
        for (let i = 0; i < totalSamples; i++) {
            if (aborted) {
                break;
            }

            const sample = videoSamples[i];

            const type = sample.is_sync ? 'key' : 'delta';
            const chunk = new EncodedVideoChunk({
                type: type,
                timestamp: (sample.cts / track.timescale) * 1_000_000,
                duration: (sample.duration / track.timescale) * 1_000_000,
                data: sample.data
            });

            // Backpressure: wait if decoder or encoder queues are too full
            while (!aborted && (decoder.decodeQueueSize > QUEUE_LIMIT || encoder.encodeQueueSize > QUEUE_LIMIT)) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }

            if (aborted) {
                break;
            }

            decoder.decode(chunk);
        }

        if (aborted) {
            throw abortError;
        }

        // Flush pipeline
        await decoder.flush();
        await encoder.flush();
    })();

    try {
        await Promise.race([processPipeline, abortPromise]);
    } finally {
        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
            } catch (e) { }
        }

        if (encoder && encoder.state !== 'closed') {
            try {
                encoder.close();
            } catch (e) { }
        }
    }

    if (audioConfig && audioSamples && audioSamples.length > 0) {
        const audioDescription = getAudioTrackDescription(mp4boxfile, audioTrack);
        const audioMeta = audioDescription
            ? { decoderConfig: { codec: audioTrack.codec, description: audioDescription } }
            : undefined;

        audioSamples.forEach((sample, index) => {
            muxer.addAudioChunkRaw(
                sample.data,
                sample.is_sync === false ? 'delta' : 'key',
                (sample.cts / audioTrack.timescale) * 1_000_000,
                (sample.duration / audioTrack.timescale) * 1_000_000,
                index === 0 ? audioMeta : undefined
            );
        });
    }

    muxer.finalize();

    const buffer = muxer.target.buffer;
    return new Blob([buffer], { type: 'video/mp4' });
}

function estimateAudioPassthroughBytes(samples) {
    if (!samples || samples.length === 0) {
        return 0;
    }

    const payloadBytes = samples.reduce((total, sample) => total + sample.data.byteLength, 0);
    const containerOverheadBytes = 4096 + (samples.length * 8);

    return payloadBytes + containerOverheadBytes;
}

function getMuxerAudioConfig(track) {
    if (!track || !track.audio) {
        return null;
    }

    let codec = null;
    if (track.codec && track.codec.startsWith('mp4a')) {
        codec = 'aac';
    } else if (track.codec && track.codec.toLowerCase().startsWith('opus')) {
        codec = 'opus';
    }

    if (!codec) {
        return null;
    }

    return {
        codec,
        numberOfChannels: track.audio.channel_count || 2,
        sampleRate: track.audio.sample_rate || track.timescale
    };
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

function getAudioTrackDescription(mp4boxfile, track) {
    if (!track) return undefined;

    const traks = mp4boxfile.moov.traks;
    const t = traks.find(t => t.tkhd.track_id === track.id);
    if (!t) return undefined;

    const entry = t.mdia.minf.stbl.stsd.entries[0];
    if (!entry) return undefined;

    const box = entry.esds;
    if (box && box.esd && box.esd.descs && box.esd.descs[0] && box.esd.descs[0].descs && box.esd.descs[0].descs[0]) {
        return box.esd.descs[0].descs[0].data;
    }

    return undefined;
}
