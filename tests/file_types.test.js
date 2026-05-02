import test from 'node:test';
import assert from 'node:assert/strict';

import {
    currentlyBrokenFileTypes,
    detectFileKind,
    getUnsupportedFileMessage
} from '../src/file_types.js';

function file({ name, type = '' }) {
    return { name, type };
}

test('detectFileKind routes MP4-family videos to the MP4 worker path', () => {
    const supportedFiles = [
        file({ name: 'clip.mp4', type: 'video/mp4' }),
        file({ name: 'clip.mov', type: 'video/quicktime' }),
        file({ name: 'clip.m4v', type: 'video/x-m4v' }),
        file({ name: 'camera-upload.MP4' }),
        file({ name: 'extensionless', type: 'application/mp4' })
    ];

    for (const supportedFile of supportedFiles) {
        assert.equal(detectFileKind(supportedFile), 'video', supportedFile.name);
    }
});

test('detectFileKind rejects known broken video containers instead of sending them to MP4Box', () => {
    const brokenFiles = [
        file({ name: 'screen.webm', type: 'video/webm' }),
        file({ name: 'capture.mkv', type: 'video/x-matroska' }),
        file({ name: 'legacy.avi', type: 'video/x-msvideo' }),
        file({ name: 'windows.wmv', type: 'video/x-ms-wmv' }),
        file({ name: 'flash.flv', type: 'video/x-flv' })
    ];

    for (const brokenFile of brokenFiles) {
        assert.equal(detectFileKind(brokenFile), 'unsupported', brokenFile.name);
        assert.match(getUnsupportedFileMessage(brokenFile), /MP4, MOV, and M4V only/);
    }
});

test('currentlyBrokenFileTypes documents the video formats blocked by routing tests', () => {
    assert.deepEqual(currentlyBrokenFileTypes.videoContainers, ['.webm', '.mkv', '.avi', '.wmv', '.flv']);
});

test('detectFileKind still supports GIF and image extension fallbacks when browser MIME is empty', () => {
    assert.equal(detectFileKind(file({ name: 'animation.gif' })), 'gif');
    assert.equal(detectFileKind(file({ name: 'photo.jpeg' })), 'image');
    assert.equal(detectFileKind(file({ name: 'graphic.webp' })), 'image');
});
