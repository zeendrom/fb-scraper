/**
 * Facebook Timeline Scraper - Versi Produksi
 * Menggunakan Network Interception GraphQL + Sistem Checkpoint
 * 
 * Cara pakai:
 *   node scraper.js --url https://www.facebook.com/zuck --years 2
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs   = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');

// ─── KONFIGURASI ─────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const getArg     = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };
const TARGET_URL = getArg('--url') || 'https://www.facebook.com/zuck';
const YEARS_BACK = parseInt(getArg('--years') || '2', 10);
const CUTOFF_TS  = Math.floor(Date.now() / 1000) - (YEARS_BACK * 365.25 * 24 * 3600); // Unix epoch

const AUTH_FILE        = 'auth.json';
const CHECKPOINT_FILE  = 'last_checkpoint.json';
const OUTPUT_CSV       = 'data_penelitian.csv';
const GRAPHQL_ENDPOINT = '/api/graphql/';
const TIMELINE_DOC_KEYS = ['timeline_list_feed_units', 'ProfileCometTimeline', 'CometTimeline'];

// ─── CSV WRITER ───────────────────────────────────────────────────────────────
const csvWriter = createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
        { id: 'id',            title: 'Post ID'         },
        { id: 'author',        title: 'Penulis'          },
        { id: 'author_id',     title: 'ID Penulis'       },
        { id: 'date',          title: 'Tanggal (UTC)'    },
        { id: 'date_local',    title: 'Tanggal (WIB)'    },
        { id: 'text',          title: 'Isi Postingan'    },
        { id: 'likes',         title: 'Jumlah Like'      },
        { id: 'comments',      title: 'Jumlah Komentar'  },
        { id: 'shares',        title: 'Jumlah Share'     },
        { id: 'post_url',      title: 'URL Postingan'    },
        { id: 'media_type',    title: 'Tipe Media'       },
    ],
    append: true,
    encoding: 'utf8',
    fieldDelimiter: ',',
});

// ─── STATE CHECKPOINT ─────────────────────────────────────────────────────────
let lastCheckpointTs = null;
if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
        lastCheckpointTs = JSON.parse(fs.readFileSync(CHECKPOINT_FILE)).last_timestamp;
        console.log(`[Checkpoint] Melanjutkan dari timestamp: ${new Date(lastCheckpointTs * 1000).toISOString()}`);
    } catch(e) {}
}

function saveCheckpoint(ts) {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ last_timestamp: ts, saved_at: new Date().toISOString() }));
}

// ─── PARSER: EKSTRAKSI POST DARI GRAPHQL NDJSON ────────────────────────────────
function parseTimelineResponse(rawText) {
    const posts = [];
    const lines = rawText.split('\n').filter(l => l.trim().startsWith('{'));

    for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch(e) { continue; }

        // Masuk ke node utama
        const feedUnits = obj?.data?.node?.timeline_list_feed_units;
        if (!feedUnits) continue;

        const edges = feedUnits.edges || [];
        for (const edge of edges) {
            const node    = edge?.node;
            if (!node) continue;

            // Teks postingan
            const story   = node?.comet_sections?.content?.story;
            const text    = story?.message?.text || '';

            // Timestamp
            const ts      = node?.comet_sections?.timestamp?.story?.creation_time;
            if (!ts) continue;
            if (ts < CUTOFF_TS) return { posts, reachedCutoff: true }; // Sudah melewati batas 2 tahun

            // Lewati jika sudah pernah diproses (resume)
            if (lastCheckpointTs && ts >= lastCheckpointTs) continue;

            // Penulis
            const actors   = node?.actors || [];
            const author   = actors[0]?.name   || 'Unknown';
            const authorId = actors[0]?.id      || '';

            // Feedback (like/komentar/share)
            const feedback = node?.feedback || {};
            const likes    = feedback?.reaction_count?.count     ?? '';
            const comments = feedback?.comment_count?.total_count ?? '';
            const shares   = feedback?.share_count?.count         ?? '';

            // Media type
            const attachments = node?.attachments || [];
            const mediaType   = attachments[0]?.media?.__typename || 'text';

            // URL postingan
            const storyUrl = story?.wwwUrl || feedback?.url || '';

            // ID unik
            const postId   = node?.id || feedback?.id || `${ts}_${authorId}`;

            // Format tanggal WIB (UTC+7)
            const dateUtc   = new Date(ts * 1000);
            const dateLocal = new Date(dateUtc.getTime() + 7 * 3600 * 1000)
                .toISOString().replace('T', ' ').substring(0, 19);

            posts.push({
                id:         postId,
                author,
                author_id:  authorId,
                date:       dateUtc.toISOString(),
                date_local: dateLocal,
                text:       text.replace(/[\r\n]+/g, ' ').trim(),
                likes,
                comments,
                shares,
                post_url:   storyUrl,
                media_type: mediaType,
            });
        }
    }
    return { posts, reachedCutoff: false };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(` Facebook Timeline Scraper`);
    console.log(` Target   : ${TARGET_URL}`);
    console.log(` Rentang  : ${YEARS_BACK} tahun ke belakang`);
    console.log(` Batas    : ${new Date(CUTOFF_TS * 1000).toISOString()}`);
    console.log(` Output   : ${OUTPUT_CSV}`);
    console.log(`${'='.repeat(60)}\n`);

    const headless = args.includes('--headless') || fs.existsSync(AUTH_FILE);
    console.log(`[Browser] Mode: ${headless ? 'Headless (latar belakang)' : 'Visible (tampak)'}`);
    const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });

    let context;
    if (fs.existsSync(AUTH_FILE)) {
        console.log('[Auth] Menggunakan sesi tersimpan dari auth.json');
        context = await browser.newContext({ storageState: AUTH_FILE });
    } else {
        console.log('[Auth] Tidak ada sesi tersimpan. Harap login secara manual di browser yang terbuka.');
        context = await browser.newContext();
    }

    const page = await context.newPage();

    // ── Statistik sesi ──
    let totalPosts   = 0;
    let batchCount   = 0;
    let reachedCutoff = false;

    // ── Listener Jaringan ──
    page.on('response', async (response) => {
        if (reachedCutoff) return;
        const url     = response.url();
        const request = response.request();
        if (!url.includes(GRAPHQL_ENDPOINT) || request.method() !== 'POST') return;

        try {
            // Identifikasi apakah ini endpoint timeline
            let friendlyName = '';
            try {
                const body    = request.postData() || '';
                const match   = body.match(/fb_api_req_friendly_name=([^&]+)/);
                if (match) friendlyName = decodeURIComponent(match[1]);
            } catch(e) {}

            const isTimeline = TIMELINE_DOC_KEYS.some(k =>
                friendlyName.toLowerCase().includes(k.toLowerCase())
            );
            if (!isTimeline) return;

            const bodyText = await response.text();
            if (bodyText.length < 500) return;

            batchCount++;
            const { posts, reachedCutoff: cutoff } = parseTimelineResponse(bodyText);

            if (posts.length > 0) {
                await csvWriter.writeRecords(posts);
                totalPosts += posts.length;
                const oldest = posts[posts.length - 1];
                saveCheckpoint(new Date(oldest.date).getTime() / 1000);
                console.log(`[Batch ${batchCount}] +${posts.length} post | Total: ${totalPosts} | Terlama: ${oldest.date_local}`);
            }

            if (cutoff) {
                reachedCutoff = true;
                console.log(`\n[SELESAI] Sudah mencapai batas ${YEARS_BACK} tahun. Total post terkumpul: ${totalPosts}`);
            }
        } catch(e) { /* abaikan */ }
    });

    // ── Login ──
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

        if (!fs.existsSync(AUTH_FILE)) {
            console.log('[Login] Silakan login di browser. Script akan lanjut otomatis setelah login...');
            await page.waitForURL('**/facebook.com/**', { timeout: 0 });
            await page.waitForTimeout(3000);
            await context.storageState({ path: AUTH_FILE });
            console.log('[Login] Berhasil! Sesi disimpan ke auth.json');
        } else {
            await page.waitForTimeout(2000);
            if (page.url().includes('login')) {
                console.log('[Login] Sesi kedaluwarsa. Silakan login kembali...');
                await page.waitForURL('**/facebook.com/**', { timeout: 0 });
                await context.storageState({ path: AUTH_FILE });
            }
        }

        // ── Navigasi ke target ──
        console.log(`\n[Navigasi] Menuju: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        // ── Auto-Scroll dengan batas waktu ──
        console.log('[Scroll] Mulai mengumpulkan data...\n');
        const MAX_SCROLLS = 500; // Batas keamanan
        for (let i = 0; i < MAX_SCROLLS; i++) {
            if (reachedCutoff) break;
            try {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                // Jeda acak 2–5 detik (meniru perilaku manusia)
                await page.waitForTimeout(Math.random() * 3000 + 2000);

                // Setiap 20 scroll, jeda lebih lama (istirahat natural)
                if ((i + 1) % 20 === 0) {
                    console.log(`[Scroll ${i+1}] Jeda sejenak (20 scroll = istirahat 15 detik)...`);
                    await page.waitForTimeout(15000);
                }
            } catch(scrollErr) {
                console.log(`[Scroll ${i+1}] Navigasi terputus, menunggu 5 detik...`);
                await page.waitForTimeout(5000);
            }
        }

    } catch(err) {
        console.error('[Error]', err.message);
    } finally {
        console.log(`\n[Selesai] Total post tersimpan ke ${OUTPUT_CSV}: ${totalPosts}`);
        await browser.close();
    }
}

run();
