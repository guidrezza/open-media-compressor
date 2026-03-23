import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildVideoEncodePlan,
    chooseScaledDimensions,
    estimateMp4OverheadBytes,
    getRetryBitrate
} from '../src/video_utils.js';

test('buildVideoEncodePlan uses measured frame timing instead of a fixed 30fps assumption', () => {
    const samples = Array.from({ length: 120 }, (_, index) => ({
        is_sync: index % 30 === 0
    }));

    const plan = buildVideoEncodePlan({
        track: { video: { width: 1920, height: 1080 } },
        samples,
        durationSec: 2,
        targetSizeBytes: 4 * 1024 * 1024
    });

    assert.equal(Math.round(plan.frameRate), 60);
    assert.ok(plan.overheadBytes > 0);
    assert.ok(plan.targetBitrate < Math.floor((4 * 1024 * 1024 * 8) / 2));
});

test('estimateMp4OverheadBytes grows with sample count and keyframes', () => {
    const small = estimateMp4OverheadBytes({
        sampleCount: 120,
        keyFrameCount: 4,
        durationSec: 4,
        width: 1280,
        height: 720
    });
    const large = estimateMp4OverheadBytes({
        sampleCount: 240,
        keyFrameCount: 8,
        durationSec: 8,
        width: 1280,
        height: 720
    });

    assert.ok(large > small);
});

test('chooseScaledDimensions downscales bitrate-starved video', () => {
    const scaled = chooseScaledDimensions({
        width: 3840,
        height: 2160,
        bitrate: 800_000,
        frameRate: 60
    });

    assert.ok(scaled.scale < 1);
    assert.ok(scaled.finalHeight <= 480);
    assert.equal(scaled.finalWidth % 2, 0);
    assert.equal(scaled.finalHeight % 2, 0);
});

test('getRetryBitrate lowers bitrate after an overshoot', () => {
    const retryBitrate = getRetryBitrate({
        currentBitrate: 1_000_000,
        actualSizeBytes: 1_100_000,
        targetSizeBytes: 1_000_000
    });

    assert.ok(retryBitrate < 1_000_000);
});
