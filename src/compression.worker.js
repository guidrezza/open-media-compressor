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

        mp4boxfile.onReady = (info) => {
            videoTrack = info.videoTracks[0];
            if (!videoTrack) {
                reject(new Error('No video track found'));
                return;
            }

            mp4boxfile.setExtractionOptions(videoTrack.id, null, { nbSamples: Infinity });
            mp4boxfile.start();
        };

        mp4boxfile.onSamples = (id, user, newSamples) => {
            extractedSamples = extractedSamples.concat(newSamples);
        };

        mp4boxfile.onError = (e) => reject(new Error('MP4Box error: ' + e));
        mp4boxfile.onFlush = () => resolve(extractedSamples);
    });

    mp4boxfile.appendBuffer(arrayBuffer);
    mp4boxfile.flush();

    const samples = await samplesPromise;
    const totalSamples = samples.length;

    if (!videoTrack) {
        throw new Error('No video track identified');
    }

    if (totalSamples === 0) {
        throw new Error('No video samples found');
    }

    // Calculate precise duration from samples
    const firstSample = samples[0];
    const lastSample = samples[totalSamples - 1];
    const durationInTimescale = (lastSample.cts + lastSample.duration) - firstSample.cts;
    const durationSec = durationInTimescale / videoTrack.timescale;

    if (!durationSec || durationSec <= 0) {
        throw new Error('Could not calculate valid duration from samples');
    }

    // 4. Calculate Bitrate
    // Target Size (bits) * 0.9 (overhead safety) / Duration (sec)
    let targetBitrate = Math.floor((targetSizeBytes * 8 * 0.90) / durationSec);
    // Remove arbitrary floor if it's too high, but keep reasonable min.
    // 100kbps might be too high for very long videos. Lower to 50kbps.
    targetBitrate = Math.max(targetBitrate, 50000);

    self.postMessage({
        type: 'status',
        message: `Video: ${durationSec.toFixed(1)}s. Target: ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB. Bitrate: ${Math.round(targetBitrate / 1000)}kbps`
    });

    await processVideo(mp4boxfile, videoTrack, targetBitrate, samples);
}

async function processVideo(mp4boxfile, track, bitrate, samples) {
    const totalSamples = samples.length;
    let encodedFrames = 0;

    // 5. Setup Muxer
    const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: {
            codec: 'avc',
            width: track.video.width,
            height: track.video.height
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

    // Ensure dimensions are even
    let width = track.video.width;
    let height = track.video.height;
    if (width % 2 !== 0) width -= 1;
    if (height % 2 !== 0) height -= 1;

    // Helper to get matching level conf
    const getConf = (codecStr) => ({
        codec: codecStr,
        width,
        height,
        bitrate,
        framerate: 30,
    });

    // Try High 4.2 -> Main 4.2 -> Baseline 4.2 -> High 5.1
    const configsToTry = [
        getConf('avc1.64002a'),
        getConf('avc1.4d002a'),
        getConf('avc1.42002a'),
        getConf('avc1.640033'),
    ];

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

    if (!selectedConfig) selectedConfig = configsToTry[2];

    try {
        encoder.configure(selectedConfig);
    } catch (e) {
        throw new Error(`Encoder config failed (${selectedConfig.codec}): ${e.message}`);
    }

    // 7. Setup Decoder
    self.postMessage({ type: 'status', message: 'Configuring Decoder...' });
    const decoder = new VideoDecoder({
        output: (frame) => {
            encoder.encode(frame);
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
