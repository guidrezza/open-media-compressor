const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const SUPPORTED_VIDEO_MIME_TYPES = new Set([
    'application/mp4',
    'video/mp4',
    'video/quicktime',
    'video/x-m4v'
]);

const KNOWN_UNSUPPORTED_VIDEO_EXTENSIONS = new Set(['.webm', '.mkv', '.avi', '.wmv', '.flv']);

const IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.bmp',
    '.tif',
    '.tiff',
    '.avif',
    '.heic',
    '.heif'
]);

export const currentlyBrokenFileTypes = Object.freeze({
    videoContainers: ['.webm', '.mkv', '.avi', '.wmv', '.flv']
});

export function getFileExtension(file) {
    const fileName = (file?.name || '').toLowerCase();
    const extensionIndex = fileName.lastIndexOf('.');
    return extensionIndex > 0 ? fileName.slice(extensionIndex) : '';
}

export function getNormalizedMimeType(file) {
    return (file?.type || '').toLowerCase().split(';', 1)[0].trim();
}

export function detectFileKind(file) {
    const mime = getNormalizedMimeType(file);
    const ext = getFileExtension(file);

    if (mime === 'image/gif' || ext === '.gif') return 'gif';

    if (SUPPORTED_VIDEO_MIME_TYPES.has(mime) || SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
        return 'video';
    }

    if (mime.startsWith('video/') || KNOWN_UNSUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
        return 'unsupported';
    }

    if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';

    return 'unsupported';
}

export function getUnsupportedFileMessage(file) {
    const mime = getNormalizedMimeType(file) || 'empty';
    const extension = getFileExtension(file) || 'none';

    if (mime.startsWith('video/') || KNOWN_UNSUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
        return `Format not supported yet. Video compression currently accepts MP4, MOV, and M4V only. Detected MIME: ${mime}, extension: ${extension}`;
    }

    return `Format not supported (Only MP4/MOV/M4V video, images, and GIF). Detected MIME: ${mime}, extension: ${extension}`;
}
