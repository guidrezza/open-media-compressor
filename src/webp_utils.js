
// Helper to strip metadata chunks from WebP
export async function stripWebPMetadata(blob) {
    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);

    // Check RIFF header
    if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) {
        return blob; // Not a RIFF file
    }

    // Check WEBP type
    if (data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) {
        return blob; // Not WebP
    }

    // Iterate chunks
    let offset = 12;
    const chunks = [];
    const chunksToRemove = ['EXIF', 'XMP ', 'ICCP']; // 4 chars each

    let fileSize = data.length;

    // Calculate new size
    let newSize = 4; // WEBP signature

    while (offset < fileSize) {
        const chunkType = String.fromCharCode(
            data[offset], data[offset+1], data[offset+2], data[offset+3]
        );
        const chunkSize = data[offset+4] | (data[offset+5] << 8) | (data[offset+6] << 16) | (data[offset+7] << 24);
        const chunkHeaderSize = 8;
        const totalChunkSize = chunkHeaderSize + chunkSize + (chunkSize % 2); // Padding byte

        if (!chunksToRemove.includes(chunkType)) {
            chunks.push({
                start: offset,
                length: totalChunkSize
            });
            newSize += totalChunkSize;
        }

        offset += totalChunkSize;
    }

    // Reconstruct
    const newBuffer = new Uint8Array(newSize + 8); // +8 for RIFF header

    // Write RIFF header
    newBuffer.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF

    // File size (little endian) -> Total size - 8
    const riffSize = newSize;
    newBuffer[4] = riffSize & 0xff;
    newBuffer[5] = (riffSize >> 8) & 0xff;
    newBuffer[6] = (riffSize >> 16) & 0xff;
    newBuffer[7] = (riffSize >> 24) & 0xff;

    // WEBP signature
    newBuffer.set([0x57, 0x45, 0x42, 0x50], 8);

    let writeOffset = 12;
    for (const chunk of chunks) {
        const chunkData = data.subarray(chunk.start, chunk.start + chunk.length);
        newBuffer.set(chunkData, writeOffset);
        writeOffset += chunk.length;

        // Handle VP8X flags if we removed ICC/EXIF/XMP
        if (String.fromCharCode(chunkData[0], chunkData[1], chunkData[2], chunkData[3]) === 'VP8X') {
            // VP8X layout:
            // 0-3: 'VP8X'
            // 4-7: Size (usually 10)
            // 8: Flags (Rsv I L E X A R) -> I=ICC, E=EXIF, X=XMP
            // We need to unset bits 5 (ICC), 3 (Exif), 2 (XMP)
            // 76543210
            // R R I L E X A R
            // I: bit 5 (0x20)
            // E: bit 3 (0x08)
            // X: bit 2 (0x04)
            // We should mask out 0x2C (0010 1100)

            // The chunkData contains header (8 bytes) + payload.
            // Payload starts at index 8.
            // Flags byte is at index 8.

            newBuffer[writeOffset - chunk.length + 8] &= ~0x2C;
        }
    }

    return new Blob([newBuffer], { type: 'image/webp' });
}
