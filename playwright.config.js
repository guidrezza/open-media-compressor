import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 180000, // 3 minutes per test for video compression
    use: {
        baseURL: 'http://localhost:5173',
        headless: true,
    },
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
    },
});
