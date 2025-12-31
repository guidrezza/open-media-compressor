import * as WebMMuxer from 'webm-muxer';

self.onmessage = async (e) => {
    const { file, targetSizeBytes } = e.data;

    try {
        await compress(file, targetSizeBytes);
    } catch (err) {
        console.error('GIF Worker error:', err);
        self.postMessage({ type: 'error', message: err.message });
    }
};

async function compress(file, targetSizeBytes) {
    const arrayBuffer = await file.arrayBuffer();

    // 1. Decode GIF using ImageDecoder
    let decoder;
    try {
        decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/gif' });
    } catch (e) {
        throw new Error(`ImageDecoder failed: ${e.message}. (Browser might not support GIF decoding via ImageDecoder)`);
    }

    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;

    // Log details
    self.postMessage({
        type: 'status',
        message: `GIF: ${track.frameCount} frames. Target: ${(targetSizeBytes / 1024 / 1024).toFixed(2)}MB`
    });



    // 3. Setup Encoder
    // We need to calculate bitrate. Duration?
    // GIF duration is sum of frame durations.
    let totalDuration = 0;
    // We can't easily iterate tracks without decoding. 
    // Let's decode everything first? Or stream?
    // Memory wise, streaming is better. But we need bitrate.
    // Let's assume a reasonable bitrate or try to calculate on the fly? 
    // VP9 is good at VBR.
    // Let's do a quick pass to get duration? No, expensive.
    // Let's use a default bitrate or try to estimate.
    // Actually, ImageDecoder random access is fast. 

    // Let's just start decoding to get dimensions and loop.

    let w = 0;
    let h = 0;
    let frames = [];

    // Read all frames to get total duration and data
    // (GIFs are usually small enough to fit in memory, unlike long videos)
    self.postMessage({ type: 'status', message: 'Decoding GIF frames...' });

    for (let i = 0; i < track.frameCount; i++) {
        const result = await decoder.decode({ frameIndex: i });
        frames.push(result);
        totalDuration += result.image.duration;

        if (i === 0) {
            w = result.image.displayWidth;
            h = result.image.displayHeight;
        }
    }

    const durationSec = totalDuration / 1_000_000; // duration is in microseconds for ImageDecoder

    // Update Muxer metadata now that we have dimensions
    // Since we already created Muxer, and WebMMuxer might need dims in constructor for Header?
    // Checking docs... usually yes. 
    // Let's re-create Muxer now that we know dimensions.
    const finalMuxer = new WebMMuxer.Muxer({
        target: new WebMMuxer.ArrayBufferTarget(),
        video: {
            codec: 'V_VP9',
            width: w,
            height: h
        }
    });

    // Calculate Bitrate
    const safetyFactor = 0.98;
    let targetBitrate = Math.floor((targetSizeBytes * 8 * safetyFactor) / durationSec);
    targetBitrate = Math.max(targetBitrate, 50000); // 50kbps min

    self.postMessage({
        type: 'status',
        message: `Encoding GIF to WebM: ${w}x${h}, ${durationSec.toFixed(1)}s, ${Math.round(targetBitrate / 1000)}kbps`
    });

    let encodedFramesCount = 0;
    const encoder = new VideoEncoder({
        output: (chunk, meta) => {
            finalMuxer.addVideoChunk(chunk, meta);
            encodedFramesCount++;
            if (encodedFramesCount % 10 === 0 || encodedFramesCount === frames.length) {
                const p = Math.round((encodedFramesCount / frames.length) * 100);
                self.postMessage({ type: 'progress', value: p });
            }
        },
        error: (e) => {
            self.postMessage({ type: 'error', message: 'Encoder Error: ' + e.message });
        }
    });

    const config = {
        codec: 'vp09.00.10.08',
        width: w,
        height: h,
        bitrate: targetBitrate,
        framerate: frames.length / durationSec,
        bitrateMode: 'constant'
    };

    encoder.configure(config);

    // Encode
    // We need timestamps in microseconds for VideoFrame
    let currentTimestamp = 0;

    for (const frameResult of frames) {
        const srcFrame = frameResult.image;
        // ImageDecoder returns VideoFrames (or ImageBitmaps that can be made into VideoFrames)
        // srcFrame IS a VideoFrame in recent implementations.

        // We need to ensure timestamp is correct relative to the sequence
        // srcFrame.timestamp might be 0 for all if indexed directly? 
        // No, ImageDecoder usually sets correct timestamp.

        // Create a new frame with explicit timestamp to be sure, or use existing?
        // Let's re-wrap to ensure timestamp continuity from 0 if needed.
        // Actually, let's just use the duration accumulation to be safe.

        const frame = new VideoFrame(srcFrame, {
            timestamp: currentTimestamp,
            duration: srcFrame.duration
        });

        encoder.encode(frame);
        frame.close();
        srcFrame.close(); // Close original

        currentTimestamp += srcFrame.duration;
    }

    await encoder.flush();
    finalMuxer.finalize();

    const buffer = finalMuxer.target.buffer;
    const blob = new Blob([buffer], { type: 'video/webm' });

    self.postMessage({ type: 'progress', value: 100 });
    self.postMessage({ type: 'done', blob: blob });
}
