const MP4_CONTAINER_BOXES = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'edts',
    'dinf',
    'moof',
    'traf',
    'mvex'
]);

const MP4_DROP_BOXES = new Set([
    'udta',
    'meta',
    'ilst',
    'uuid',
    'free',
    'skip',
    'wide',
    'prft',
    'cprt',
    'meco',
    'keys'
]);

const EBML_ID_EBML = 0x1a45dfa3;
const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_SEEK_HEAD = 0x114d9b74;
const EBML_ID_CUES = 0x1c53bb6b;
const EBML_ID_VOID = 0xec;
const EBML_ID_CRC32 = 0xbf;

const WEBM_MASTER_ELEMENTS = new Set([
    EBML_ID_EBML,
    EBML_ID_SEGMENT,
    EBML_ID_INFO
]);

const WEBM_DROP_SEGMENT_ELEMENTS = new Set([
    EBML_ID_SEEK_HEAD,
    EBML_ID_CUES,
    EBML_ID_VOID,
    EBML_ID_CRC32
]);

const WEBM_DROP_INFO_ELEMENTS = new Set([
    0x4d80,
    0x5741,
    0x4461,
    0x73a4,
    0x7ba9,
    EBML_ID_VOID,
    EBML_ID_CRC32
]);

function toUint8Array(bufferLike) {
    if (bufferLike instanceof Uint8Array) {
        return bufferLike;
    }

    return new Uint8Array(bufferLike);
}

function cloneArrayBuffer(bufferLike) {
    const bytes = toUint8Array(bufferLike);
    const clone = new Uint8Array(bytes.length);
    clone.set(bytes);
    return clone.buffer;
}

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

function readUint32(bytes, offset) {
    return (
        (bytes[offset] * 0x1000000) +
        ((bytes[offset + 1] << 16) >>> 0) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]
    ) >>> 0;
}

function readUint32LE(bytes, offset) {
    return (
        bytes[offset] +
        (bytes[offset + 1] << 8) +
        (bytes[offset + 2] << 16) +
        ((bytes[offset + 3] << 24) >>> 0)
    ) >>> 0;
}

function writeUint32(bytes, offset, value) {
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

function readUint64(bytes, offset) {
    const high = readUint32(bytes, offset);
    const low = readUint32(bytes, offset + 4);
    return (high * 0x100000000) + low;
}

function writeUint64(bytes, offset, value) {
    const high = Math.floor(value / 0x100000000);
    const low = value >>> 0;
    writeUint32(bytes, offset, high);
    writeUint32(bytes, offset + 4, low);
}

function readMp4Box(bytes, offset, end) {
    if (offset + 8 > end) {
        throw new Error('Invalid MP4 box header');
    }

    const size32 = readUint32(bytes, offset);
    const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
    );

    let headerSize = 8;
    let size = size32;

    if (size32 === 1) {
        if (offset + 16 > end) {
            throw new Error('Invalid MP4 large-size box header');
        }

        size = readUint64(bytes, offset + 8);
        headerSize = 16;
    } else if (size32 === 0) {
        size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
        throw new Error(`Invalid MP4 box size for ${type}`);
    }

    return {
        type,
        size,
        headerSize,
        contentStart: offset + headerSize,
        end: offset + size
    };
}

function buildMp4Box(type, payload, useLargeSize = false) {
    const totalSize = payload.length + (useLargeSize ? 16 : 8);

    if (!useLargeSize && totalSize > 0xffffffff) {
        return buildMp4Box(type, payload, true);
    }

    const box = new Uint8Array(totalSize);
    if (useLargeSize) {
        writeUint32(box, 0, 1);
        writeUint64(box, 8, totalSize);
    } else {
        writeUint32(box, 0, totalSize);
    }

    box[4] = type.charCodeAt(0);
    box[5] = type.charCodeAt(1);
    box[6] = type.charCodeAt(2);
    box[7] = type.charCodeAt(3);
    box.set(payload, useLargeSize ? 16 : 8);

    return box;
}

function scrubMp4TimeFields(type, payload) {
    const cleaned = new Uint8Array(payload.length);
    cleaned.set(payload);

    if (payload.length < 12) {
        return cleaned;
    }

    const version = payload[0];

    if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
        if (version === 1) {
            if (payload.length >= 20) {
                writeUint64(cleaned, 4, 0);
                writeUint64(cleaned, 12, 0);
            }
        } else if (payload.length >= 12) {
            writeUint32(cleaned, 4, 0);
            writeUint32(cleaned, 8, 0);
        }
    }

    return cleaned;
}

function sanitizeMp4Range(bytes, start, end) {
    const sanitizedBoxes = [];
    let offset = start;

    while (offset < end) {
        const box = readMp4Box(bytes, offset, end);

        if (MP4_DROP_BOXES.has(box.type)) {
            offset = box.end;
            continue;
        }

        let payload = bytes.subarray(box.contentStart, box.end);

        if (MP4_CONTAINER_BOXES.has(box.type)) {
            payload = sanitizeMp4Range(bytes, box.contentStart, box.end);
        } else if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
            payload = scrubMp4TimeFields(box.type, payload);
        }

        sanitizedBoxes.push(buildMp4Box(box.type, payload, box.headerSize === 16));
        offset = box.end;
    }

    return concatUint8Arrays(sanitizedBoxes);
}

function readEbmlId(bytes, offset) {
    const firstByte = bytes[offset];
    let mask = 0x80;
    let width = 1;

    while (width <= 4 && !(firstByte & mask)) {
        mask >>= 1;
        width++;
    }

    if (width > 4 || offset + width > bytes.length) {
        throw new Error('Invalid EBML element id');
    }

    let id = 0;
    for (let i = 0; i < width; i++) {
        id = (id * 256) + bytes[offset + i];
    }

    return {
        id,
        raw: bytes.subarray(offset, offset + width),
        nextOffset: offset + width
    };
}

function readEbmlSize(bytes, offset) {
    const firstByte = bytes[offset];
    let mask = 0x80;
    let width = 1;

    while (width <= 8 && !(firstByte & mask)) {
        mask >>= 1;
        width++;
    }

    if (width > 8 || offset + width > bytes.length) {
        throw new Error('Invalid EBML element size');
    }

    let value = firstByte & (mask - 1);
    for (let i = 1; i < width; i++) {
        value = (value * 256) + bytes[offset + i];
    }

    const maxValue = width < 8 ? (2 ** (7 * width)) - 1 : Number.MAX_SAFE_INTEGER;
    const unknown = value === maxValue;

    return {
        value,
        width,
        unknown,
        nextOffset: offset + width
    };
}

function encodeEbmlSize(value) {
    let width = 1;

    while (width < 8 && value >= (2 ** (7 * width)) - 1) {
        width++;
    }

    if (width >= 8 && value >= (2 ** 56) - 1) {
        throw new Error('EBML element too large to encode');
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

function readEbmlElement(bytes, offset, end) {
    const idInfo = readEbmlId(bytes, offset);
    const sizeInfo = readEbmlSize(bytes, idInfo.nextOffset);
    const payloadStart = sizeInfo.nextOffset;
    const payloadEnd = sizeInfo.unknown ? end : payloadStart + sizeInfo.value;

    if (payloadEnd > end) {
        throw new Error('Invalid EBML element payload size');
    }

    return {
        id: idInfo.id,
        idBytes: idInfo.raw,
        payloadStart,
        payloadEnd,
        end: payloadEnd
    };
}

function buildEbmlElement(idBytes, payload) {
    const sizeBytes = encodeEbmlSize(payload.length);
    const element = new Uint8Array(idBytes.length + sizeBytes.length + payload.length);
    element.set(idBytes, 0);
    element.set(sizeBytes, idBytes.length);
    element.set(payload, idBytes.length + sizeBytes.length);
    return element;
}

function sanitizeEbmlRange(bytes, start, end, parentId = null) {
    const sanitizedElements = [];
    let offset = start;

    while (offset < end) {
        const element = readEbmlElement(bytes, offset, end);

        if (
            (parentId === EBML_ID_SEGMENT && WEBM_DROP_SEGMENT_ELEMENTS.has(element.id)) ||
            (parentId === EBML_ID_INFO && WEBM_DROP_INFO_ELEMENTS.has(element.id)) ||
            (parentId === null && element.id === EBML_ID_VOID) ||
            element.id === EBML_ID_CRC32
        ) {
            offset = element.end;
            continue;
        }

        let payload = bytes.subarray(element.payloadStart, element.payloadEnd);

        if (WEBM_MASTER_ELEMENTS.has(element.id)) {
            payload = sanitizeEbmlRange(bytes, element.payloadStart, element.payloadEnd, element.id);
        }

        sanitizedElements.push(buildEbmlElement(element.idBytes, payload));
        offset = element.end;
    }

    return concatUint8Arrays(sanitizedElements);
}

export async function stripWebPMetadata(blob) {
    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);

    if (data.length < 12) {
        return blob;
    }

    if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) {
        return blob;
    }

    if (data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) {
        return blob;
    }

    let offset = 12;
    const chunks = [];
    const chunksToRemove = new Set(['EXIF', 'XMP ', 'ICCP']);
    let newSize = 4;

    while (offset + 8 <= data.length) {
        const chunkType = String.fromCharCode(
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3]
        );
        const chunkSize = readUint32LE(data, offset + 4);
        const totalChunkSize = 8 + chunkSize + (chunkSize % 2);

        if (offset + totalChunkSize > data.length) {
            return blob;
        }

        if (!chunksToRemove.has(chunkType)) {
            chunks.push({
                start: offset,
                length: totalChunkSize,
                type: chunkType
            });
            newSize += totalChunkSize;
        }

        offset += totalChunkSize;
    }

    if (offset !== data.length) {
        return blob;
    }

    const newBuffer = new Uint8Array(newSize + 8);
    newBuffer.set([0x52, 0x49, 0x46, 0x46], 0);
    writeUint32LE(newBuffer, 4, newSize);
    newBuffer.set([0x57, 0x45, 0x42, 0x50], 8);

    let writeOffset = 12;
    for (const chunk of chunks) {
        const chunkData = data.subarray(chunk.start, chunk.start + chunk.length);
        newBuffer.set(chunkData, writeOffset);

        if (chunk.type === 'VP8X' && chunk.length >= 9) {
            newBuffer[writeOffset + 8] &= ~0x2c;
        }

        writeOffset += chunk.length;
    }

    return new Blob([newBuffer], { type: 'image/webp' });
}

export function sanitizeMp4Buffer(bufferLike) {
    const bytes = toUint8Array(bufferLike);

    try {
        return sanitizeMp4Range(bytes, 0, bytes.length).buffer;
    } catch {
        return cloneArrayBuffer(bufferLike);
    }
}

export async function sanitizeMp4Blob(blob) {
    return new Blob([sanitizeMp4Buffer(await blob.arrayBuffer())], { type: 'video/mp4' });
}

export function sanitizeWebMBuffer(bufferLike) {
    const bytes = toUint8Array(bufferLike);

    try {
        return sanitizeEbmlRange(bytes, 0, bytes.length).buffer;
    } catch {
        return cloneArrayBuffer(bufferLike);
    }
}

export async function sanitizeWebMBlob(blob) {
    return new Blob([sanitizeWebMBuffer(await blob.arrayBuffer())], { type: 'video/webm' });
}
