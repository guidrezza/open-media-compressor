import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeMp4Buffer,
    sanitizeWebMBuffer,
    stripWebPMetadata
} from '../src/media_sanitizers.js';

function concatUint8Arrays(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }

    return combined;
}

function writeUint32BE(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
}

function writeUint32LE(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function mp4Box(type, payload = new Uint8Array()) {
    const box = new Uint8Array(8 + payload.length);
    writeUint32BE(box, 0, box.length);
    box[4] = type.charCodeAt(0);
    box[5] = type.charCodeAt(1);
    box[6] = type.charCodeAt(2);
    box[7] = type.charCodeAt(3);
    box.set(payload, 8);
    return box;
}

function fullBoxPayload(version, bodyBytes) {
    const payload = new Uint8Array(4 + bodyBytes.length);
    payload[0] = version;
    payload.set(bodyBytes, 4);
    return payload;
}

function indexOfAscii(bytes, ascii) {
    const needle = Uint8Array.from(ascii.split('').map((char) => char.charCodeAt(0)));

    for (let offset = 0; offset <= bytes.length - needle.length; offset++) {
        let match = true;
        for (let i = 0; i < needle.length; i++) {
            if (bytes[offset + i] !== needle[i]) {
                match = false;
                break;
            }
        }

        if (match) {
            return offset;
        }
    }

    return -1;
}

function readUint32BE(bytes, offset) {
    return (
        (bytes[offset] * 0x1000000) +
        ((bytes[offset + 1] << 16) >>> 0) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]
    ) >>> 0;
}

function encodeEbmlSize(value) {
    let width = 1;
    while (width < 8 && value >= (2 ** (7 * width)) - 1) {
        width++;
    }

    const encoded = new Uint8Array(width);
    let remaining = value;

    for (let i = width - 1; i >= 0; i--) {
        encoded[i] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
    }

    encoded[0] |= 1 << (8 - width);
    return encoded;
}

function ebmlElement(idBytes, payload = new Uint8Array()) {
    return concatUint8Arrays([idBytes, encodeEbmlSize(payload.length), payload]);
}

function webpChunk(type, payload) {
    const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
    chunk.set(Uint8Array.from(type.split('').map((char) => char.charCodeAt(0))), 0);
    writeUint32LE(chunk, 4, payload.length);
    chunk.set(payload, 8);
    return chunk;
}

test('sanitizeMp4Buffer removes metadata boxes and clears time fields', () => {
    const mvhdBody = new Uint8Array(16);
    writeUint32BE(mvhdBody, 0, 0x01020304);
    writeUint32BE(mvhdBody, 4, 0x05060708);

    const tkhdBody = new Uint8Array(16);
    writeUint32BE(tkhdBody, 0, 0x11121314);
    writeUint32BE(tkhdBody, 4, 0x15161718);

    const mdhdBody = new Uint8Array(16);
    writeUint32BE(mdhdBody, 0, 0x21222324);
    writeUint32BE(mdhdBody, 4, 0x25262728);

    const mp4Bytes = concatUint8Arrays([
        mp4Box('ftyp', Uint8Array.from([0, 0, 0, 0])),
        mp4Box('moov', concatUint8Arrays([
            mp4Box('mvhd', fullBoxPayload(0, mvhdBody)),
            mp4Box('udta', Uint8Array.from([1, 2, 3, 4])),
            mp4Box('trak', concatUint8Arrays([
                mp4Box('tkhd', fullBoxPayload(0, tkhdBody)),
                mp4Box('mdia', concatUint8Arrays([
                    mp4Box('mdhd', fullBoxPayload(0, mdhdBody))
                ]))
            ]))
        ])),
        mp4Box('mdat', Uint8Array.from([9, 8, 7, 6]))
    ]);

    const sanitized = new Uint8Array(sanitizeMp4Buffer(mp4Bytes.buffer));

    assert.equal(indexOfAscii(sanitized, 'udta'), -1);

    const mvhdIndex = indexOfAscii(sanitized, 'mvhd');
    const tkhdIndex = indexOfAscii(sanitized, 'tkhd');
    const mdhdIndex = indexOfAscii(sanitized, 'mdhd');

    assert.notEqual(mvhdIndex, -1);
    assert.notEqual(tkhdIndex, -1);
    assert.notEqual(mdhdIndex, -1);

    assert.equal(readUint32BE(sanitized, mvhdIndex + 8), 0);
    assert.equal(readUint32BE(sanitized, mvhdIndex + 12), 0);
    assert.equal(readUint32BE(sanitized, tkhdIndex + 8), 0);
    assert.equal(readUint32BE(sanitized, tkhdIndex + 12), 0);
    assert.equal(readUint32BE(sanitized, mdhdIndex + 8), 0);
    assert.equal(readUint32BE(sanitized, mdhdIndex + 12), 0);
});

test('sanitizeWebMBuffer drops muxer metadata and optional seek metadata', () => {
    const ebmlHeader = ebmlElement(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), concatUint8Arrays([
        ebmlElement(Uint8Array.from([0x42, 0x86]), Uint8Array.from([0x01]))
    ]));
    const seekHead = ebmlElement(Uint8Array.from([0x11, 0x4d, 0x9b, 0x74]), Uint8Array.from([0x01]));
    const info = ebmlElement(Uint8Array.from([0x15, 0x49, 0xa9, 0x66]), concatUint8Arrays([
        ebmlElement(Uint8Array.from([0x2a, 0xd7, 0xb1]), Uint8Array.from([0x0f, 0x42, 0x40])),
        ebmlElement(Uint8Array.from([0x4d, 0x80]), Uint8Array.from([0x74, 0x72, 0x61, 0x63, 0x6b])),
        ebmlElement(Uint8Array.from([0x57, 0x41]), Uint8Array.from([0x77, 0x72, 0x69, 0x74, 0x65]))
    ]));
    const tracks = ebmlElement(Uint8Array.from([0x16, 0x54, 0xae, 0x6b]), Uint8Array.from([0xaa, 0xbb]));
    const cluster = ebmlElement(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]), Uint8Array.from([0x11, 0x22, 0x33]));
    const cues = ebmlElement(Uint8Array.from([0x1c, 0x53, 0xbb, 0x6b]), Uint8Array.from([0x44, 0x55]));
    const webmBytes = concatUint8Arrays([
        ebmlHeader,
        ebmlElement(Uint8Array.from([0x18, 0x53, 0x80, 0x67]), concatUint8Arrays([
            seekHead,
            info,
            tracks,
            cluster,
            cues
        ]))
    ]);

    const sanitized = new Uint8Array(sanitizeWebMBuffer(webmBytes.buffer));

    assert.equal(indexOfAscii(sanitized, 'track'), -1);
    assert.equal(indexOfAscii(sanitized, 'write'), -1);
    assert.equal(indexOfAscii(sanitized, '\x11\x4d\x9b\x74'), -1);
    assert.equal(indexOfAscii(sanitized, '\x1c\x53\xbb\x6b'), -1);
    assert.notEqual(indexOfAscii(sanitized, '\x1f\x43\xb6\x75'), -1);
});

test('stripWebPMetadata removes EXIF, XMP and ICC chunks and clears VP8X flags', async () => {
    const vp8xPayload = new Uint8Array(10);
    vp8xPayload[0] = 0x2c;

    const chunks = [
        webpChunk('VP8X', vp8xPayload),
        webpChunk('EXIF', Uint8Array.from([1, 2, 3, 4])),
        webpChunk('XMP ', Uint8Array.from([5, 6, 7])),
        webpChunk('ICCP', Uint8Array.from([8, 9])),
        webpChunk('VP8 ', Uint8Array.from([10, 11, 12]))
    ];

    const riffPayload = concatUint8Arrays(chunks);
    const webpBytes = new Uint8Array(12 + riffPayload.length);
    webpBytes.set(Uint8Array.from([0x52, 0x49, 0x46, 0x46]), 0);
    writeUint32LE(webpBytes, 4, 4 + riffPayload.length);
    webpBytes.set(Uint8Array.from([0x57, 0x45, 0x42, 0x50]), 8);
    webpBytes.set(riffPayload, 12);

    const sanitizedBlob = await stripWebPMetadata(new Blob([webpBytes], { type: 'image/webp' }));
    const sanitized = new Uint8Array(await sanitizedBlob.arrayBuffer());
    const vp8xIndex = indexOfAscii(sanitized, 'VP8X');

    assert.equal(indexOfAscii(sanitized, 'EXIF'), -1);
    assert.equal(indexOfAscii(sanitized, 'XMP '), -1);
    assert.equal(indexOfAscii(sanitized, 'ICCP'), -1);
    assert.notEqual(indexOfAscii(sanitized, 'VP8 '), -1);
    assert.notEqual(vp8xIndex, -1);
    assert.equal(sanitized[vp8xIndex + 8] & 0x2c, 0);
});
