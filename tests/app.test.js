import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexPath = path.join(root, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

test('page includes expected app title and heading', () => {
    assert.match(html, /<title>Open Media Compressor \| Private Browser-Based Compression<\/title>/);
    assert.match(html, /<h1>Open Media Compressor<\/h1>/);
});

test('page contains upload and compress controls', () => {
    assert.match(html, /id="drop-zone"/);
    assert.match(html, /id="compress-btn"/);
    assert.match(html, /DROP IN FILES OR UPLOAD/);
});

test('required worker and utility modules exist', () => {
    const requiredFiles = [
        'src/compression.worker.js',
        'src/gif.worker.js',
        'src/webp_utils.js',
    ];

    for (const file of requiredFiles) {
        assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
    }
});
