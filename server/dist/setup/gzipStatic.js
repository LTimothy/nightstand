import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
const TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};
// Appends to Vary instead of replacing it, so cors's Vary: Origin survives.
export function addVary(res, value) {
    const cur = String(res.getHeader('Vary') ?? '');
    if (!cur.split(',').some((v) => v.trim().toLowerCase() === value.toLowerCase())) {
        res.setHeader('Vary', cur ? `${cur}, ${value}` : value);
    }
}
export function gzipStatic(publicDir) {
    let names = [];
    try {
        names = fs.readdirSync(publicDir).filter((n) => path.extname(n) in TYPES);
    }
    catch {
        // missing directory (tests, dev): everything falls through
    }
    const known = new Set(names);
    const cache = new Map();
    return async (req, res, next) => {
        const name = req.path.slice(1);
        if (!known.has(name) || req.headers.range || !req.acceptsEncodings('gzip'))
            return next();
        try {
            const file = path.join(publicDir, name);
            const st = await fs.promises.stat(file);
            let entry = cache.get(name);
            if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
                const gz = fs.promises.readFile(file).then((buf) => new Promise((resolve, reject) => {
                    zlib.gzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
                }));
                entry = { mtimeMs: st.mtimeMs, size: st.size, gz };
                cache.set(name, entry);
                gz.catch(() => { if (cache.get(name) === entry)
                    cache.delete(name); });
            }
            const body = await entry.gz;
            res.setHeader('Content-Type', TYPES[path.extname(name)]);
            res.setHeader('Content-Encoding', 'gzip');
            addVary(res, 'Accept-Encoding');
            res.setHeader('Cache-Control', 'public, max-age=0');
            res.setHeader('Last-Modified', st.mtime.toUTCString());
            res.setHeader('ETag', `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-gz"`);
            if (req.fresh) {
                res.status(304).end();
                return;
            }
            res.setHeader('Content-Length', body.length);
            res.end(req.method === 'HEAD' ? undefined : body);
        }
        catch {
            next();
        }
    };
}
// Gzip first, then the plain files, both marking that the body depends on Accept-Encoding.
export function serveApp(app, publicDir) {
    app.use(gzipStatic(publicDir));
    app.use(express.static(publicDir, {
        setHeaders: (res, file) => {
            if (/\.(js|css)$/.test(file))
                addVary(res, 'Accept-Encoding');
        },
    }));
}
//# sourceMappingURL=gzipStatic.js.map