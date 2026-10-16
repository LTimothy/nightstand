import express from 'express';
import cors from 'cors';
import logger from '../logger.js';
import { attachRequestCompletionLogging } from './requestLogging.js';
import os from 'os';
import { isIP } from 'net';
// Include every non-internal IPv4 /24 so interface order cannot exclude the LAN.
export function getLocalSubnetPrefixes() {
    const interfaces = os.networkInterfaces();
    const prefixes = [];
    for (const interfaceName in interfaces) {
        const networkInterface = interfaces[interfaceName];
        if (!networkInterface)
            continue;
        for (const network of networkInterface) {
            if (network.family !== 'IPv4' || network.internal)
                continue;
            const parts = network.address.split('.');
            if (parts.length !== 4)
                continue;
            prefixes.push(`${parts[0]}.${parts[1]}.${parts[2]}.`);
        }
    }
    return prefixes;
}
function parseConfiguredOrigin() {
    const value = process.env.ALLOWED_ORIGIN;
    if (!value || value === '*')
        return value;
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value)
            throw new Error('Invalid origin');
        return parsed.origin;
    }
    catch {
        logger.warn('Ignoring invalid ALLOWED_ORIGIN; use an http(s) origin including its scheme and optional port');
        return undefined;
    }
}
const configuredOrigin = parseConfiguredOrigin();
let subnetPrefixes = [];
let subnetRefreshAt = 0;
function localSubnetPrefixes() {
    if (Date.now() >= subnetRefreshAt) {
        subnetPrefixes = getLocalSubnetPrefixes();
        subnetRefreshAt = Date.now() + 30_000;
    }
    return subnetPrefixes;
}
function hostnameOf(host) {
    if (!host)
        return undefined;
    try {
        return new URL(`http://${host}`).hostname;
    }
    catch {
        return undefined;
    }
}
export function isAllowedOrigin(origin, host) {
    if (!origin) {
        return true;
    }
    if (configuredOrigin === '*') {
        return true;
    }
    try {
        const parsed = new URL(origin);
        // An Origin is just scheme, host and port, never credentials or a path.
        // Scheme and host are case-insensitive; URL lowercases them.
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin.toLowerCase())
            return false;
        if (configuredOrigin && parsed.origin === configuredOrigin)
            return true;
        const hostname = parsed.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
            return true;
        const localSuffixes = ['.local', '.lan', '.home.arpa', '.internal'];
        if (isIP(hostname) === 0 && (/^[a-z0-9-]+$/.test(hostname)
            || localSuffixes.some(suffix => hostname.endsWith(suffix))))
            return true;
        // Anyone can serve a page on a ts.net name through Tailscale Funnel, so
        // only the name this Pod was reached by counts.
        if (hostname.endsWith('.ts.net'))
            return hostname === hostnameOf(host);
        return isIP(hostname) === 4 && localSubnetPrefixes().some(prefix => hostname.startsWith(prefix));
    }
    catch {
        return false;
    }
}
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
// Every API route that takes a body reads JSON. A body of any other type was
// left unparsed, so the route saw an empty update and answered 200 having
// changed nothing. A request without a body, such as a bare POST to stop the
// base, is still let through.
export function requireJsonBody(req, res, next) {
    if (!BODY_METHODS.has(req.method))
        return next();
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
    if (!hasBody || req.is('application/json'))
        return next();
    res.status(415).json({ error: 'Send the request body as application/json' });
}
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Walks the parsed body without recursion, since it can be nested thousands
// of levels deep.
export function hasPrototypeKey(body) {
    const pending = [body];
    while (pending.length > 0) {
        const value = pending.pop();
        if (value === null || typeof value !== 'object')
            continue;
        for (const [key, child] of Object.entries(value)) {
            if (PROTOTYPE_KEYS.has(key))
                return true;
            pending.push(child);
        }
    }
    return false;
}
// Settings, schedules and services have no field by these names, and their
// schemas silently dropped them, so a body carrying one answered 200. Other
// routes are left out on purpose: a rhythm named Constructor gets the id
// "constructor", which is a key in /rhythms bodies.
function rejectPrototypeKeys(req, res, next) {
    if (!BODY_METHODS.has(req.method) || !hasPrototypeKey(req.body))
        return next();
    res.status(400).json({ error: 'Invalid request data', details: 'Keys named __proto__, constructor or prototype are not allowed' });
}
export default function (app) {
    app.use((req, res, next) => {
        attachRequestCompletionLogging(req, res, logger);
        next();
    });
    app.use((req, res, next) => {
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
            res.status(403).json({ error: 'Origin is not allowed' });
            return;
        }
        next();
    });
    app.use(cors({ origin: true }));
    app.use('/api', requireJsonBody);
    app.use(express.json());
    app.use(['/api/settings', '/api/schedules', '/api/services'], rejectPrototypeKeys);
    // Logging
    app.use((req, res, next) => {
        const clientIp = req.headers['x-forwarded-for'] || req.ip;
        const method = req.method;
        const endpoint = req.originalUrl;
        logger.debug(`${method} ${endpoint} - IP: ${clientIp}`);
        next();
    });
}
//# sourceMappingURL=middleware.js.map