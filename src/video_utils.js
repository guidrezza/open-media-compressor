export const MIN_VIDEO_BITRATE = 50_000;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function ensureEven(value) {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function estimateMp4OverheadBytes({ sampleCount, keyFrameCount, durationSec, width, height }) {
    const baseHeaders = 20_480;
    const sampleTables = sampleCount * 16;
    const syncSampleTable = keyFrameCount * 4;
    const durationOverhead = Math.ceil(durationSec) * 256;
    const resolutionOverhead = Math.ceil((width * height) / 1_000_000) * 4096;

    return Math.min(262_144, baseHeaders + sampleTables + syncSampleTable + durationOverhead + resolutionOverhead);
}

export function buildVideoEncodePlan({ track, samples, durationSec, targetSizeBytes }) {
    const sampleCount = samples.length;
    const keyFrameCount = Math.max(1, samples.reduce((count, sample) => count + (sample.is_sync ? 1 : 0), 0));
    const measuredFrameRate = sampleCount > 0 && durationSec > 0 ? sampleCount / durationSec : 30;
    const frameRate = clamp(measuredFrameRate || 30, 1, 120);
    const overheadBytes = estimateMp4OverheadBytes({
        sampleCount,
        keyFrameCount,
        durationSec,
        width: track.video.width,
        height: track.video.height
    });
    const mediaBudgetBytes = Math.max(1, targetSizeBytes - overheadBytes);
    let targetBitrate = Math.floor((mediaBudgetBytes * 8 * 0.99) / durationSec);
    let wasClamped = false;

    if (targetBitrate < MIN_VIDEO_BITRATE) {
        targetBitrate = MIN_VIDEO_BITRATE;
        wasClamped = true;
    }

    return {
        durationSec,
        frameRate,
        keyFrameCount,
        overheadBytes,
        sampleCount,
        targetBitrate,
        wasClamped
    };
}

export function chooseScaledDimensions({ width, height, bitrate, frameRate }) {
    const safeFrameRate = Math.max(frameRate || 30, 1);
    const bitsPerPixelPerFrame = bitrate / (width * height * safeFrameRate);
    let maxHeight = height;

    if (maxHeight > 1080 && (bitrate < 2_000_000 || bitsPerPixelPerFrame < 0.08)) {
        maxHeight = 1080;
    }

    if (maxHeight > 720 && (bitrate < 2_500_000 || bitsPerPixelPerFrame < 0.055)) {
        maxHeight = 720;
    }

    if (maxHeight > 480 && (bitrate < 1_000_000 || bitsPerPixelPerFrame < 0.03)) {
        maxHeight = 480;
    }

    const scale = maxHeight < height ? maxHeight / height : 1;

    return {
        scale,
        finalWidth: ensureEven(width * scale),
        finalHeight: ensureEven(height * scale),
        bitsPerPixelPerFrame
    };
}

export function getRetryBitrate({ currentBitrate, actualSizeBytes, targetSizeBytes }) {
    if (!(actualSizeBytes > targetSizeBytes)) {
        return currentBitrate;
    }

    const proportionalRatio = targetSizeBytes / actualSizeBytes;
    const adjustedRatio = clamp(proportionalRatio * 0.97, 0.65, 0.97);

    return Math.max(MIN_VIDEO_BITRATE, Math.floor(currentBitrate * adjustedRatio));
}
