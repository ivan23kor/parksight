const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const PORT = 8080;
const BACKEND_PORT = process.env.BACKEND_PORT || 8000;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LEGACY_UI_PATHS = ['/ui-map', '/ui-panorama', '/ui-upload', '/dist'];

// ── Browser log relay ──
const LOG_DIR = path.join(__dirname, 'logs');
const BROWSER_LOG = path.join(LOG_DIR, 'browser.log');
const BROWSER_LOG_RATE_LIMIT = 500; // max entries written per second
let browserLogWindowStart = Date.now();
let browserLogWindowCount = 0;
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

const formatLogLine = (entry) => {
    const ts = entry.ts || new Date().toISOString();
    const level = (entry.level || 'info').toUpperCase();
    const url = entry.url ? ` ${entry.url}` : '';
    const msg = typeof entry.msg === 'string' ? entry.msg : JSON.stringify(entry.msg);
    let line = `[${ts}] [${level}]${url} ${msg}\n`;
    if (entry.stack) {
        const indented = String(entry.stack).split('\n').map((l) => '    ' + l).join('\n');
        line += indented + '\n';
    }
    return line;
};

const writeBrowserLog = (entries) => {
    const now = Date.now();
    if (now - browserLogWindowStart > 1000) {
        browserLogWindowStart = now;
        browserLogWindowCount = 0;
    }
    const remaining = BROWSER_LOG_RATE_LIMIT - browserLogWindowCount;
    if (remaining <= 0) return;
    const take = entries.slice(0, remaining);
    browserLogWindowCount += take.length;
    const chunk = take.map(formatLogLine).join('');
    fs.appendFile(BROWSER_LOG, chunk, (err) => {
        if (err) console.error('browser log write failed:', err.message);
    });
};

// ── Live reload via SSE ──
const WATCH_EXTENSIONS = new Set(['.html', '.js', '.css']);
const sseClients = new Set();
let reloadVersion = Date.now();

const notifyReload = (filename) => {
    if (!filename) return;
    const ext = path.extname(filename).toLowerCase();
    if (!WATCH_EXTENSIONS.has(ext)) return;
    reloadVersion = Date.now();
    for (const res of sseClients) {
        res.write(`data: ${reloadVersion}\n\n`);
    }
};

for (const dir of ['.', 'js']) {
    try {
        fs.watch(dir, (eventType, filename) => notifyReload(filename));
    } catch (e) {
        console.warn(`Live reload: failed to watch ${dir}: ${e.message}`);
    }
}

const liveReloadScript = `
    <script>
    (function() {
        var es = new EventSource('/__livereload');
        es.onmessage = function() { location.reload(); };
        es.onerror = function() { es.close(); setTimeout(function() { location.reload(); }, 2000); };
    })();
    </script>
`;

const injectScript = (API_KEY ? `
    <script>
    window.env = window.env || {};
    window.env.GOOGLE_MAPS_API_KEY = "${API_KEY}";
    </script>
` : '') + liveReloadScript;

const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

    // SSE live reload endpoint
    if (requestUrl.pathname === '/__livereload') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // Browser log relay endpoint
    if (requestUrl.pathname === '/__logs' && req.method === 'POST') {
        const chunks = [];
        let total = 0;
        const MAX_BYTES = 1 * 1024 * 1024; // 1 MB cap per request
        let aborted = false;
        req.on('data', (c) => {
            if (aborted) return;
            total += c.length;
            if (total > MAX_BYTES) {
                aborted = true;
                res.writeHead(413); res.end();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (aborted) return;
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                const parsed = JSON.parse(body);
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                writeBrowserLog(entries);
                res.writeHead(204); res.end();
            } catch (err) {
                res.writeHead(400); res.end('bad json');
            }
        });
        req.on('error', () => { try { res.writeHead(500); res.end(); } catch (_) {} });
        return;
    }

    // ── Reverse proxy: /api/* → backend ──
    if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/api') {
        const targetPath = path.posix.normalize(requestUrl.pathname.slice(4) || '/');
        if (targetPath.startsWith('..')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid path' }));
            return;
        }
        const search = requestUrl.search || '';
        const proxyOpts = {
            hostname: '127.0.0.1',
            port: BACKEND_PORT,
            path: targetPath + search,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` },
        };
        const proxyReq = http.request(proxyOpts, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.setTimeout(30000, () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'backend timeout' }));
            }
        });
        proxyReq.on('error', (err) => {
            const status = err.code === 'ECONNREFUSED' ? 502 : 500;
            console.error(`Proxy error: ${err.code} ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'backend unavailable' }));
            }
        });
        req.pipe(proxyReq);
        return;
    }

    if (
        LEGACY_UI_PATHS.some((legacyPath) =>
            requestUrl.pathname === legacyPath || requestUrl.pathname.startsWith(`${legacyPath}/`)
        )
    ) {
        res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
            'Clear-Site-Data': '"cache"',
            Pragma: 'no-cache',
            Expires: '0'
        });
        res.end('Not found');
        return;
    }

    let filePath = '.' + decodeURIComponent(requestUrl.pathname);
    if (filePath === './') filePath = './index.html';

    // Handle directory requests - serve index.html
    if (filePath.endsWith('/')) {
        filePath = filePath + 'index.html';
    } else if (path.extname(filePath) === '') {
        // URL without extension and without trailing slash
        const stat = fs.statSync(filePath, { throwIfNoEntry: false });
        if (stat && stat.isDirectory()) {
            filePath = filePath + '/index.html';
        }
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + error.code);
            }
            return;
        }

        // Inject env script into HTML files
        if (extname === '.html' && API_KEY) {
            content = content.toString().replace('</head>', injectScript + '</head>');
        }

        const headers = { 'Content-Type': contentType };
        if (extname === '.html') {
            headers['Cache-Control'] = 'no-store';
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
        }

        res.writeHead(200, headers);
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (!API_KEY) console.warn('⚠️  GOOGLE_MAPS_API_KEY not set in environment');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Another instance may be running.`);
        console.error('   Kill existing process or use a different port.');
        process.exit(1);
    } else {
        console.error('Server error:', err);
        process.exit(1);
    }
});
