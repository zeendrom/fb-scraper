/**
 * Auto Git Sync — watch-sync.js
 * 
 * Memantau perubahan file kode dan otomatis commit + push ke GitHub.
 * File data (CSV, auth, JSON dump) TIDAK ikut di-push.
 * 
 * Cara pakai:
 *   node watch-sync.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── KONFIGURASI ─────────────────────────────────────────────
// File yang dipantau untuk auto-sync
const WATCH_FILES = [
    'scraper.js',
    'package.json',
    '.gitignore',
    'watch-sync.js',
    'README.md',
];

// Jeda minimum antar commit (ms) — cegah commit spam saat save berkali-kali
const DEBOUNCE_MS = 5000;

// ─── STATE ───────────────────────────────────────────────────
let syncTimer = null;
let isSyncing = false;

// ─── FUNGSI UTAMA ────────────────────────────────────────────
function gitSync(changedFile) {
    if (isSyncing) return;
    isSyncing = true;

    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const commitMsg  = `Auto-sync: perubahan pada ${changedFile} (${timestamp})`;

    console.log(`\n[Sync] Perubahan terdeteksi pada: ${changedFile}`);
    console.log(`[Sync] Commit: "${commitMsg}"`);

    try {
        execSync('git add scraper.js package.json .gitignore watch-sync.js README.md 2>nul', {
            cwd: __dirname,
            stdio: 'pipe',
            shell: 'cmd.exe',
        });

        // Cek apakah ada yang berubah sebelum commit
        const status = execSync('git status --porcelain', {
            cwd: __dirname,
            encoding: 'utf8',
            shell: 'cmd.exe',
        }).trim();

        if (!status) {
            console.log('[Sync] Tidak ada perubahan baru untuk di-commit.');
            isSyncing = false;
            return;
        }

        execSync(`git commit -m "${commitMsg}"`, {
            cwd: __dirname,
            stdio: 'pipe',
            shell: 'cmd.exe',
        });

        execSync('git push origin master', {
            cwd: __dirname,
            stdio: 'pipe',
            shell: 'cmd.exe',
        });

        console.log(`[Sync] ✅ Berhasil di-push ke GitHub!`);
    } catch (err) {
        console.error(`[Sync] ❌ Gagal sync:`, err.message.split('\n')[0]);
    }

    isSyncing = false;
}

function onFileChange(eventType, filename) {
    if (!filename) return;

    // Hanya proses file yang ada di watchlist
    const basename = path.basename(filename);
    if (!WATCH_FILES.includes(basename)) return;

    // Debounce — tunggu DEBOUNCE_MS sebelum commit
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => gitSync(basename), DEBOUNCE_MS);
}

// ─── MULAI MEMANTAU ──────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║          Auto Git Sync — watch-sync.js                  ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  Memantau perubahan dan auto-push ke GitHub...           ║');
console.log('║  File dipantau:                                          ║');
WATCH_FILES.forEach(f => console.log(`║    • ${f.padEnd(52)}║`));
console.log('║                                                          ║');
console.log('║  Tekan Ctrl+C untuk berhenti.                           ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// Watch direktori scraper
const watcher = fs.watch(__dirname, { recursive: false }, onFileChange);

watcher.on('error', (err) => {
    console.error('[Sync] Error watcher:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Sync] Dihentikan. Bye!');
    watcher.close();
    process.exit(0);
});
