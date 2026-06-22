'use strict';

/**
 * Cocos MCP (3.7–3.8.x) — single-file extension main process, no npm dependencies.
 *
 * Mirror image of cocos-mcp-2x/main.js. Same JSON envelope and same WebSocket
 * client; the differences from 2.4 are all in the editor APIs the handlers call:
 *   - Editor.Message.request('asset-db'|'scene', ...) (Promises) instead of
 *     Editor.assetdb / Editor.Scene callbacks.
 *   - console.* hook instead of the Editor.log hook.
 *   - execute-scene-script (-> scene.js) instead of Editor.Scene.callSceneScript.
 *   - exports.methods (3.x) instead of 2.4's `messages: {}` map.
 *
 * Protocol (Python server -> extension):
 *   { "id": "<uuid>", "command": "manage_node", "params": { ... } }
 * Reply (extension -> server):
 *   { "id": "<uuid>", "success": true,  "data":  ... }
 *   { "id": "<uuid>", "success": false, "error": "..." }
 *
 * Contents (top -> bottom):
 *   1. Minimal WebSocket client (RFC 6455, text frames, no `ws` package).
 *   2. Console ring buffer for read_console (hooks console.log/info/warn/error).
 *   3. Small editor helpers (Editor.Message.request wrapper, dump builders).
 *   4. Six command handlers.
 *   5. Bridge wiring (connect/disconnect/dispatch).
 *   6. Extension lifecycle (load/unload) + panel IPC methods (3.x style).
 */

const net = require('net');
const crypto = require('crypto');
const Path = require('path');
const Fs = require('fs');
const ChildProcess = require('child_process');
const { EventEmitter } = require('events');

const PACKAGE_NAME = 'cocos-mcp-3x';
// Bridge (WebSocket) port must match the Python server default (core/config.py
// COCOS_MCP_BRIDGE_PORT = 6020). When an MCP client launches the server over
// stdio it passes no --bridge-port, so the server listens on 6020; the panel's
// Connect must dial the same port or the green dot never lights.
const DEFAULT_URL = 'ws://127.0.0.1:6020/cocosmcp';
const MAX_FRAME = 16 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Where the Python MCP server lives, and which HTTP port it serves the MCP
// endpoint on. The server now ships *inside* this extension (./server), so the
// default dir is resolved relative to this file — the plugin is self-contained
// and portable (works wherever the project's extensions folder lives, including
// through a junction/symlink). The bridge (WebSocket) port is derived from the
// connection URL so it always matches what the panel connects to. Both the dir
// and the HTTP port are overridable from the panel and persisted via
// Editor.Profile, for the rare case where the server lives elsewhere.
const DEFAULT_SERVER_DIR = Path.join(__dirname, 'server');
const DEFAULT_HTTP_PORT = 8765;

// ----------------------------------------------------------------------- //
// 1. Minimal WebSocket client (text frames only) — identical to 2.4.
// ----------------------------------------------------------------------- //

class WsClient extends EventEmitter {
    constructor() {
        super();
        this._socket = null;
        this._buf = Buffer.alloc(0);
        this._handshakeDone = false;
        this._expectedAccept = null;
    }

    connect(urlStr) {
        const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(urlStr);
        if (!m) {
            setImmediate(() => this.emit('error', new Error('invalid ws:// url: ' + urlStr)));
            return;
        }
        const host = m[1];
        const port = parseInt(m[2] || '80', 10);
        const path = m[3] || '/';

        const key = crypto.randomBytes(16).toString('base64');
        this._expectedAccept = crypto.createHash('sha1')
            .update(key + WS_GUID).digest('base64');

        const socket = net.createConnection({ host: host, port: port });
        this._socket = socket;
        socket.setNoDelay(true);

        socket.on('connect', () => {
            const req =
                'GET ' + path + ' HTTP/1.1\r\n' +
                'Host: ' + host + ':' + port + '\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n' +
                '\r\n';
            socket.write(req);
        });

        socket.on('data', (chunk) => {
            try { this._onData(chunk); }
            catch (e) { this.emit('error', e); this._teardown(); }
        });
        socket.on('error', (err) => this.emit('error', err));
        socket.on('close', () => {
            this._handshakeDone = false;
            this.emit('close');
        });
    }

    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);

        if (!this._handshakeDone) {
            const end = this._buf.indexOf(Buffer.from('\r\n\r\n'));
            if (end === -1) return;
            const header = this._buf.slice(0, end).toString('utf8');
            this._buf = this._buf.slice(end + 4);
            if (!/^HTTP\/1\.[01] 101/i.test(header)) {
                this.emit('error', new Error('handshake failed: ' + header.split('\r\n')[0]));
                this._teardown(); return;
            }
            const am = header.match(/Sec-WebSocket-Accept:\s*(.+)/i);
            if (!am || am[1].trim() !== this._expectedAccept) {
                this.emit('error', new Error('handshake failed: bad Sec-WebSocket-Accept'));
                this._teardown(); return;
            }
            this._handshakeDone = true;
            this.emit('open');
        }

        while (true) {
            if (this._buf.length < 2) return;
            const b0 = this._buf[0], b1 = this._buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this._buf.length < 4) return;
                len = this._buf.readUInt16BE(2); offset = 4;
            } else if (len === 127) {
                if (this._buf.length < 10) return;
                const hi = this._buf.readUInt32BE(2);
                const lo = this._buf.readUInt32BE(6);
                if (hi !== 0 || lo > MAX_FRAME) {
                    this.emit('error', new Error('frame too large'));
                    this._teardown(); return;
                }
                len = lo; offset = 10;
            }
            let mask = null;
            if (masked) {
                if (this._buf.length < offset + 4) return;
                mask = this._buf.slice(offset, offset + 4);
                offset += 4;
            }
            if (this._buf.length < offset + len) return;
            let payload = this._buf.slice(offset, offset + len);
            this._buf = this._buf.slice(offset + len);
            if (masked) {
                const u = Buffer.alloc(len);
                for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3];
                payload = u;
            }
            if (opcode === 0x1 && fin) {
                this.emit('message', payload.toString('utf8'));
            } else if (opcode === 0x8) {
                try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
                this._teardown(); return;
            } else if (opcode === 0x9) {
                try { this._writeFrame(0xa, payload); } catch (e) {}
            }
        }
    }

    _writeFrame(opcode, data) {
        if (!this._socket || this._socket.destroyed) return;
        const len = data.length;
        let header;
        if (len < 126) {
            header = Buffer.alloc(2 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | len;
        } else if (len < 65536) {
            header = Buffer.alloc(4 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10 + 4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
            header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
        }
        const maskKey = crypto.randomBytes(4);
        maskKey.copy(header, header.length - 4);
        const out = Buffer.alloc(header.length + len);
        header.copy(out, 0);
        for (let i = 0; i < len; i++) out[header.length + i] = data[i] ^ maskKey[i & 3];
        this._socket.write(out);
    }

    send(text) {
        if (!this._handshakeDone) throw new Error('ws not connected');
        this._writeFrame(0x1, Buffer.from(String(text), 'utf8'));
    }

    close() {
        if (this._socket && !this._socket.destroyed && this._handshakeDone) {
            try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
        }
        this._teardown();
    }

    _teardown() {
        if (this._socket) {
            try { this._socket.end(); } catch (e) {}
            try { this._socket.destroy(); } catch (e) {}
            this._socket = null;
        }
        this._handshakeDone = false;
    }
}

// ----------------------------------------------------------------------- //
// 2. Console capture (hooks console.log/info/warn/error in this process).
//    Best-effort: captures logs emitted by the extension main process. The
//    editor aggregates logs from several processes; we can only see ours.
// ----------------------------------------------------------------------- //

const _consoleOriginals = {};
let _consoleBuffer = null;
const CONSOLE_CAPACITY = 500;

function _stringifyArg(a) {
    if (a && a.stack && typeof a.stack === 'string') return a.stack;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function _installConsoleHook() {
    if (_consoleBuffer) return;
    _consoleBuffer = { entries: [], seq: 0, capacity: CONSOLE_CAPACITY };
    [['log', 'log'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']].forEach((p) => {
        const fn = p[0], level = p[1];
        if (typeof console[fn] !== 'function') return;
        _consoleOriginals[fn] = console[fn];
        console[fn] = function () {
            try {
                _consoleBuffer.seq++;
                _consoleBuffer.entries.push({
                    seq: _consoleBuffer.seq,
                    timestamp: Date.now(),
                    level: level,
                    message: Array.prototype.slice.call(arguments).map(_stringifyArg).join(' '),
                });
                while (_consoleBuffer.entries.length > _consoleBuffer.capacity) {
                    _consoleBuffer.entries.shift();
                }
            } catch (e) { /* never let logging crash */ }
            return _consoleOriginals[fn].apply(console, arguments);
        };
    });
}

function _uninstallConsoleHook() {
    Object.keys(_consoleOriginals).forEach((k) => {
        try { console[k] = _consoleOriginals[k]; } catch (e) { /* ignore */ }
    });
    for (const k in _consoleOriginals) delete _consoleOriginals[k];
    _consoleBuffer = null;
}

// ----------------------------------------------------------------------- //
// 3. Editor helpers
// ----------------------------------------------------------------------- //

function _safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function _normUrl(u) {
    if (!u) return u;
    if (u.startsWith('db://')) return u;
    if (u.startsWith('assets/')) return 'db://' + u;
    if (u.startsWith('/assets')) return 'db://' + u.slice(1);
    return u;
}

// Editor.Message.request shorthand.
function req(module, message, ...args) {
    return Editor.Message.request(module, message, ...args);
}

// A property in a dump is `{ value, type, ... }`; a node-tree node carries
// plain strings. Read through either shape.
function _val(p) {
    if (p && typeof p === 'object' && 'value' in p) return p.value;
    return p;
}

function _assetBrief(a, full) {
    if (!a) return a;
    const brief = {
        name: a.name,
        url: a.url,
        uuid: a.uuid,
        type: a.type,
        path: a.path || a.source,
        isDirectory: !!a.isDirectory,
    };
    if (full) {
        brief.file = a.file;
        brief.importer = a.importer;
        brief.source = a.source;
    }
    return brief;
}

// query-node-tree returns a nested {name, uuid, active, type, children[]} tree.
function _trimTree(node, maxDepth, depth) {
    depth = depth || 0;
    if (!node) return null;
    const out = { name: _val(node.name), uuid: _val(node.uuid) };
    const active = _val(node.active);
    if (active !== undefined) out.active = active;
    if (node.type) out.type = node.type;
    const children = node.children || [];
    if (depth >= maxDepth) {
        if (children.length) out.childCount = children.length;
    } else {
        out.children = children.map((c) => _trimTree(c, maxDepth, depth + 1));
    }
    return out;
}

// query-node returns a full INode dump (every field is a `{value,type}` prop).
function _nodeSummary(node) {
    if (!node) return null;
    const comps = (node.__comps__ || []).map((c) => ({
        type: c.type,
        enabled: _val(c.value && c.value.enabled),
    }));
    return {
        uuid: _val(node.uuid),
        name: _val(node.name),
        active: _val(node.active),
        position: _val(node.position),
        rotation: _val(node.rotation),
        scale: _val(node.scale),
        layer: _val(node.layer),
        parent: node.parent ? _val(node.parent.uuid || node.parent) : null,
        childCount: (node.children || []).length,
        components: comps,
    };
}

// Infer a dump `type` when we can't read the existing property's type.
function _inferType(v) {
    if (v === null || v === undefined) return 'cc.Object';
    if (typeof v === 'number') return 'Number';
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'string') return 'String';
    if (typeof v === 'object') {
        if ('x' in v && 'y' in v && 'z' in v && 'w' in v) return 'cc.Quat';
        if ('x' in v && 'y' in v && 'z' in v) return 'cc.Vec3';
        if ('x' in v && 'y' in v) return 'cc.Vec2';
        if ('r' in v && 'g' in v && 'b' in v) return 'cc.Color';
        if ('uuid' in v) return 'cc.Asset';
    }
    return 'cc.Object';
}

// Resolve a dotted `property` into a set-property `path` + the existing
// top-level IProperty (used to recover the correct dump `type`).
//
//   "position"           -> node-level path "position"
//   "cc.Sprite.color"    -> component path  "__comps__.<i>.color"
//
// Sub-field paths like "position.x" work but the dump type is inferred from
// the value rather than the (struct) parent's type.
function _resolvePropertyPath(node, property) {
    const comps = node.__comps__ || [];
    let best = null;
    for (let i = 0; i < comps.length; i++) {
        const t = comps[i] && comps[i].type;
        if (t && property.startsWith(t + '.')) {
            if (!best || t.length > best.t.length) best = { i: i, t: t };
        }
    }
    if (best) {
        const rest = property.slice(best.t.length + 1);
        const firstKey = rest.split('.')[0];
        const compVal = comps[best.i].value || {};
        return { path: '__comps__.' + best.i + '.' + rest, existing: compVal[firstKey], deep: rest.indexOf('.') >= 0 };
    }
    const seg0 = property.split('.')[0];
    return { path: property, existing: node[seg0], deep: property.indexOf('.') >= 0 };
}

// ----------------------------------------------------------------------- //
// 4. Command handlers
// ----------------------------------------------------------------------- //

const handlers = {

    async get_project_info() {
        let scenes = [];
        try {
            const assets = await req('asset-db', 'query-assets', { ccType: 'cc.SceneAsset' });
            scenes = (assets || []).map((a) => ({ url: a.url, uuid: a.uuid, path: a.path || a.source }));
        } catch (e) { /* ignore — still report the rest */ }
        const projectPath = _safe(() => Editor.Project.path, null);
        return {
            engine: _safe(() => String(Editor.App.version || '').split('.').slice(0, 2).join('.'), '3.x') || '3.x',
            projectPath: projectPath,
            projectName: _safe(() => Editor.Project.name, null),
            assetsRoot: projectPath ? Path.join(projectPath, 'assets') : null,
            editorVersion: _safe(() => Editor.App.version, null),
            sceneCount: scenes.length,
            firstScenes: scenes.slice(0, 20),
            availableCommands: Object.keys(handlers).sort(),
            bridgeVersion: 2,
        };
    },

    async read_console(params) {
        params = params || {};
        if (!_consoleBuffer) {
            return { entries: [], nextCursor: 0, note: 'console hook not active' };
        }
        if (params.action === 'clear') {
            _consoleBuffer.entries.length = 0;
            return { cleared: true };
        }
        const levels = Array.isArray(params.levels) && params.levels.length
            ? new Set(params.levels) : null;
        const contains = (typeof params.contains === 'string') ? params.contains : null;
        const since = (typeof params.since === 'number') ? params.since : -1;
        let count = Number.isFinite(params.count) ? Math.floor(params.count) : 50;
        if (count <= 0) count = 50;
        if (count > 500) count = 500;
        let entries = _consoleBuffer.entries.filter((e) => {
            if (levels && !levels.has(e.level)) return false;
            if (contains && e.message.indexOf(contains) === -1) return false;
            if (e.seq <= since) return false;
            return true;
        });
        if (entries.length > count) entries = entries.slice(entries.length - count);
        const nextCursor = entries.length ? entries[entries.length - 1].seq : Math.max(since, 0);
        return { entries: entries, nextCursor: nextCursor, totalBuffered: _consoleBuffer.entries.length };
    },

    async manage_asset(params) {
        params = params || {};
        const action = params.action || 'list';

        if (action === 'list') {
            const opt = { pattern: params.pattern || 'db://assets/**/*' };
            let assets = (await req('asset-db', 'query-assets', opt)) || [];
            const type = params.type;
            if (type) {
                assets = assets.filter((a) =>
                    (a.type && a.type.indexOf(type) >= 0) ||
                    (a.name && a.name.toLowerCase().endsWith('.' + type.toLowerCase())));
            }
            const total = assets.length;
            const limit = Math.min(params.limit || 200, 1000);
            if (assets.length > limit) assets = assets.slice(0, limit);
            return { count: total, returned: assets.length, assets: assets.map((a) => _assetBrief(a)) };
        }

        if (action === 'info') {
            const key = params.uuid || _normUrl(params.url);
            if (!key) throw new Error('manage_asset.info needs url or uuid');
            const info = await req('asset-db', 'query-asset-info', key);
            return info ? _assetBrief(info, true) : null;
        }

        if (action === 'read') {
            const key = params.uuid || _normUrl(params.url);
            if (!key) throw new Error('manage_asset.read needs url or uuid');
            const info = await req('asset-db', 'query-asset-info', key);
            if (!info) throw new Error('asset not found: ' + key);
            if (info.isDirectory) throw new Error('cannot read a directory');
            if (!info.file) throw new Error('asset has no file on disk');
            const stat = Fs.statSync(info.file);
            if (stat.size > 1024 * 1024) {
                throw new Error('file too large (>1MB): ' + stat.size + ' bytes');
            }
            const content = Fs.readFileSync(info.file, 'utf8');
            return { url: info.url, uuid: info.uuid, file: info.file, size: stat.size, content: content };
        }

        if (action === 'create') {
            const url = _normUrl(params.url);
            if (!url) throw new Error('manage_asset.create needs url');
            const body = (params.content != null) ? String(params.content) : null;
            const info = await req('asset-db', 'create-asset', url, body);
            return info ? _assetBrief(info, true) : { created: true, url: url };
        }

        if (action === 'delete') {
            const url = _normUrl(params.url);
            if (!url) throw new Error('manage_asset.delete needs url');
            const info = await req('asset-db', 'delete-asset', url);
            return { deleted: true, asset: info ? _assetBrief(info) : null };
        }

        if (action === 'refresh') {
            const url = _normUrl(params.url) || 'db://assets';
            // Fire-and-forget: refreshing a compiled script/scene can trigger a
            // slow reimport whose promise may exceed the bridge request timeout
            // (default 30s). Kick it off and return immediately; completion is
            // async (watch read_console).
            Promise.resolve(req('asset-db', 'refresh-asset', url)).catch(() => {});
            return { refreshing: true, url: url };
        }

        throw new Error('manage_asset: unknown action "' + action +
            '" (valid: list, info, read, create, delete, refresh)');
    },

    async manage_scene(params) {
        params = params || {};
        const action = params.action || 'current';

        if (action === 'list') {
            const assets = (await req('asset-db', 'query-assets', { ccType: 'cc.SceneAsset' })) || [];
            return {
                count: assets.length,
                scenes: assets.map((a) => ({ url: a.url, uuid: a.uuid, path: a.path || a.source })),
            };
        }

        if (action === 'current') {
            const tree = await req('scene', 'query-node-tree');
            if (!tree) return { open: false };
            return {
                open: true,
                uuid: _val(tree.uuid),
                name: _val(tree.name),
                childCount: (tree.children || []).length,
            };
        }

        if (action === 'open') {
            let uuid = params.uuid;
            if (!uuid && params.url) {
                uuid = await req('asset-db', 'query-uuid', _normUrl(params.url));
            }
            if (!uuid) throw new Error('manage_scene.open needs uuid or url');
            await req('scene', 'open-scene', uuid);
            return { opened: true, uuid: uuid };
        }

        if (action === 'save') {
            const r = await req('scene', 'save-scene');
            return { saved: true, uuid: r || undefined };
        }

        throw new Error('manage_scene: unknown action "' + action +
            '" (valid: list, current, open, save)');
    },

    async manage_node(params) {
        params = params || {};
        const action = params.action;

        if (action === 'tree') {
            const args = params.uuid ? [params.uuid] : [];
            const tree = await req('scene', 'query-node-tree', ...args);
            const maxDepth = (params.maxDepth != null) ? Math.max(0, params.maxDepth) : 6;
            return _trimTree(tree, maxDepth);
        }

        if (action === 'get') {
            if (!params.uuid) throw new Error('manage_node.get needs uuid');
            const node = await req('scene', 'query-node', params.uuid);
            return _nodeSummary(node);
        }

        if (action === 'selection') {
            let sel = [];
            try { sel = Editor.Selection.getSelected('node') || []; } catch (e) {}
            return { selected: sel };
        }

        if (action === 'create') {
            const opt = { name: params.name || 'NewNode' };
            if (params.parentUuid) opt.parent = params.parentUuid;
            if (params.position) opt.position = params.position;
            const uuid = await req('scene', 'create-node', opt);
            return { created: true, uuid: uuid };
        }

        if (action === 'delete') {
            if (!params.uuid) throw new Error('manage_node.delete needs uuid');
            await req('scene', 'remove-node', { uuid: params.uuid });
            return { deleted: true, uuid: params.uuid };
        }

        if (action === 'add_component') {
            if (!params.uuid) throw new Error('manage_node.add_component needs uuid');
            if (!params.className) throw new Error('manage_node.add_component needs className');
            await req('scene', 'create-component', { uuid: params.uuid, component: params.className });
            return { added: true, uuid: params.uuid, component: params.className };
        }

        if (action === 'set_property') {
            const uuid = params.uuid;
            if (!uuid) throw new Error('manage_node.set_property needs uuid');
            if (!params.property) throw new Error('manage_node.set_property needs property');
            const node = await req('scene', 'query-node', uuid);
            if (!node) throw new Error('node not found: ' + uuid);
            const resolved = _resolvePropertyPath(node, params.property);
            let type;
            if (!resolved.deep && resolved.existing && resolved.existing.type) {
                type = resolved.existing.type;
            } else {
                type = _inferType(params.value);
            }
            const ok = await req('scene', 'set-property', {
                uuid: uuid,
                path: resolved.path,
                dump: { type: type, value: params.value },
            });
            return { set: !!ok, uuid: uuid, path: resolved.path, type: type };
        }

        throw new Error('manage_node: unknown action "' + action +
            '" (valid: tree, get, set_property, create, delete, add_component, selection)');
    },

    async execute_script(params) {
        params = params || {};
        const code = params.code;
        const target = params.target || 'main';
        if (typeof code !== 'string' || !code.trim()) {
            throw new Error('execute_script needs non-empty code');
        }
        if (target === 'scene') {
            const value = await req('scene', 'execute-scene-script', {
                name: PACKAGE_NAME,
                method: 'evalInScene',
                args: [code],
            });
            return { value: value === undefined ? null : value };
        }
        // target === 'main'
        const fn = new Function('Editor', 'require',
            '"use strict"; return (async () => { ' + code + ' })();');
        const value = await fn(Editor, require);
        return { value: _coerceValue(value) };
    },
};

function _coerceValue(v) {
    if (v === undefined) return null;
    try { JSON.parse(JSON.stringify(v)); return v; }
    catch (e) { return String(v); }
}

// ----------------------------------------------------------------------- //
// 5. Bridge wiring
// ----------------------------------------------------------------------- //

let _ws = null;
let _connected = false;
let _url = DEFAULT_URL;
let _lastError = null;

function _connectionState() {
    return { connected: _connected, url: _url, lastError: _lastError };
}

function _handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch (e) { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'hello') return;
    if (typeof frame.command !== 'string' || !frame.id) return;

    const fn = handlers[frame.command];
    const reply = (resp) => {
        try { if (_ws) _ws.send(JSON.stringify(resp)); } catch (e) { /* ignore */ }
    };
    if (!fn) {
        reply({
            id: frame.id, success: false,
            error: 'unknown command: ' + frame.command +
                ' (known: ' + Object.keys(handlers).sort().join(', ') + ')',
        });
        return;
    }
    Promise.resolve()
        .then(() => fn(frame.params || {}))
        .then((data) => reply({ id: frame.id, success: true, data: data }))
        .catch((e) => reply({
            id: frame.id, success: false,
            error: (e && e.message) ? e.message : String(e),
            stack: (e && e.stack) ? String(e.stack) : undefined,
        }));
}

function _connect(url) {
    if (typeof url === 'string' && url.trim()) _url = url.trim();
    if (_ws) {
        try { _ws.close(); } catch (e) { /* ignore */ }
        _ws = null;
    }
    return new Promise((resolve) => {
        let settled = false;
        const ws = new WsClient();

        const onOpen = () => {
            if (settled) return; settled = true;
            _ws = ws;
            _connected = true;
            _lastError = null;
            try {
                ws.send(JSON.stringify({ type: 'hello', client: PACKAGE_NAME, engine: '3.x' }));
            } catch (e) { /* ignore */ }
            resolve(_connectionState());
        };
        const onErr = (err) => {
            _lastError = (err && err.message) ? err.message : String(err);
            if (settled) return; settled = true;
            _connected = false; _ws = null;
            resolve(_connectionState());
        };
        const onClose = () => {
            _connected = false;
            if (_ws === ws) _ws = null;
            if (settled) return; settled = true;
            if (!_lastError) _lastError = 'closed before open';
            resolve(_connectionState());
        };

        ws.on('open', onOpen);
        ws.on('error', onErr);
        ws.on('close', onClose);
        ws.on('message', _handleFrame);

        try { ws.connect(_url); } catch (e) { onErr(e); }
    });
}

function _disconnect() {
    if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; }
    _connected = false;
}

// ----------------------------------------------------------------------- //
// 5b. Python server lifecycle (spawn / probe / stop)
//
// The panel can launch the Python MCP server (which hosts the WS bridge the
// extension dials into) as a child process, see whether it's up, and stop it.
// "running" is detected by probing the bridge TCP port — so the panel reflects
// a server started anywhere (this panel, start-server.bat, an MCP client),
// not just one we spawned. "managed" means we own the child process.
// ----------------------------------------------------------------------- //

let _serverProc = null;          // ChildProcess we spawned (null if none/exited)
let _serverLastError = null;
const _serverLog = [];           // ring buffer of recent server stdout/stderr
let _cfgServerDir = null;        // override of DEFAULT_SERVER_DIR (from Profile/panel)
let _cfgHttpPort = null;         // override of DEFAULT_HTTP_PORT

function _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _serverDir() { return _cfgServerDir || DEFAULT_SERVER_DIR; }
function _httpPort() { return _cfgHttpPort || DEFAULT_HTTP_PORT; }

// The bridge port the panel connects to (parsed from the ws:// URL).
function _bridgePort() {
    const m = /^ws:\/\/[^/:]+:(\d+)/.exec(_url || '');
    return m ? parseInt(m[1], 10) : 6020;
}

function _pythonPath() {
    const dir = _serverDir();
    return process.platform === 'win32'
        ? Path.join(dir, '.venv', 'Scripts', 'python.exe')
        : Path.join(dir, '.venv', 'bin', 'python');
}

function _pushServerLog(s) {
    String(s).split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        _serverLog.push(line);
        while (_serverLog.length > 200) _serverLog.shift();
    });
}

// Best-effort TCP connect probe. Resolves true if something accepts on the port.
function _probePort(port, host, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (up) => {
            if (done) return; done = true;
            try { sock.destroy(); } catch (e) {}
            resolve(up);
        };
        sock.setTimeout(timeoutMs || 600);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(port, host || '127.0.0.1'); } catch (e) { finish(false); }
    });
}

// Find the PID listening on a TCP port (Windows: netstat). Used to stop a
// server we didn't spawn ourselves.
function _findPidOnPort(port) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(null);
        ChildProcess.execFile('netstat', ['-ano', '-p', 'TCP'],
            { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const lines = stdout.split(/\r?\n/);
                for (const line of lines) {
                    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
                    if (m && parseInt(m[1], 10) === port) return resolve(parseInt(m[2], 10));
                }
                resolve(null);
            });
    });
}

function _killPid(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        if (process.platform === 'win32') {
            ChildProcess.execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
                { windowsHide: true }, () => resolve());
        } else {
            try { process.kill(pid, 'SIGTERM'); } catch (e) {}
            resolve();
        }
    });
}

async function _serverStatus() {
    const bridgePort = _bridgePort();
    const running = await _probePort(bridgePort);
    const dir = _serverDir();
    const py = _pythonPath();
    return {
        running: running,
        managed: !!(_serverProc && _serverProc.exitCode === null && _serverProc.signalCode === null),
        pid: _serverProc ? _serverProc.pid : null,
        bridgePort: bridgePort,
        httpPort: _httpPort(),
        serverDir: dir,
        defaultServerDir: DEFAULT_SERVER_DIR,
        isDefaultDir: !_cfgServerDir,
        pythonPath: py,
        pythonExists: _safe(() => Fs.existsSync(py), false),
        srcExists: _safe(() => Fs.existsSync(Path.join(dir, 'src', 'main.py')), false),
        lastError: _serverLastError,
        log: _serverLog.slice(-20),
    };
}

async function _startServer() {
    const bridgePort = _bridgePort();
    const httpPort = _httpPort();

    // Already up (started here or elsewhere)? Don't spawn a competing process.
    if (await _probePort(bridgePort)) {
        _serverLastError = null;
        return _serverStatus();
    }

    const py = _pythonPath();
    const cwd = Path.join(_serverDir(), 'src');
    if (!Fs.existsSync(py)) {
        _serverLastError = 'python not found: ' + py +
            ' — check the server dir, or create the venv (python -m venv .venv && .venv\\Scripts\\python -m pip install -e .)';
        return _serverStatus();
    }
    if (!Fs.existsSync(cwd)) {
        _serverLastError = 'server src not found: ' + cwd;
        return _serverStatus();
    }

    try {
        const args = ['-m', 'main', '--transport', 'http',
            '--http-port', String(httpPort), '--bridge-port', String(bridgePort)];
        const proc = ChildProcess.spawn(py, args, { cwd: cwd, windowsHide: true });
        _serverProc = proc;
        _serverLastError = null;
        if (proc.stdout) proc.stdout.on('data', (d) => _pushServerLog(d.toString()));
        if (proc.stderr) proc.stderr.on('data', (d) => _pushServerLog(d.toString()));
        proc.on('error', (e) => {
            _serverLastError = 'spawn error: ' + (e && e.message ? e.message : String(e));
        });
        proc.on('exit', (code, sig) => {
            _pushServerLog('[server exited: code=' + code + ' signal=' + sig + ']');
            if (_serverProc === proc) _serverProc = null;
        });
        console.log('[' + PACKAGE_NAME + '] launching server: ' + py +
            ' (bridge ' + bridgePort + ', http ' + httpPort + ')');
    } catch (e) {
        _serverLastError = 'failed to start server: ' + (e && e.message ? e.message : String(e));
        return _serverStatus();
    }

    // Wait (up to ~12s) for the bridge port to start accepting.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        await _delay(400);
        if (_serverProc == null) break; // exited early — error already logged
        if (await _probePort(bridgePort)) break;
    }
    if (!(await _probePort(bridgePort)) && !_serverLastError) {
        _serverLastError = 'server did not start listening on ' + bridgePort +
            ' within 12s — see the server log';
    }
    return _serverStatus();
}

async function _stopServer() {
    const bridgePort = _bridgePort();

    // Kill the child process tree we spawned, if any.
    if (_serverProc && _serverProc.pid) {
        await _killPid(_serverProc.pid);
        _serverProc = null;
    }
    // Also stop a server we didn't spawn (e.g. started via start-server.bat),
    // so the Stop button always frees the port.
    if (await _probePort(bridgePort)) {
        const pid = await _findPidOnPort(bridgePort);
        if (pid) await _killPid(pid);
    }
    _serverLastError = null;
    return _serverStatus();
}

function _setServerDir(dir) {
    _cfgServerDir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : null;
    try { Editor.Profile.setConfig(PACKAGE_NAME, 'serverDir', _cfgServerDir, 'global'); } catch (e) {}
}

// The bridge (WebSocket) port comes from the connection URL, so the panel
// changes it by changing the URL. The HTTP port (the MCP endpoint clients dial)
// is independent, so it gets its own setter. Empty/invalid -> back to default.
function _setHttpPort(port) {
    const p = parseInt(port, 10);
    _cfgHttpPort = (Number.isFinite(p) && p > 0 && p <= 65535) ? p : null;
    try { Editor.Profile.setConfig(PACKAGE_NAME, 'httpPort', _cfgHttpPort, 'global'); } catch (e) {}
}

// ----------------------------------------------------------------------- //
// 6. Extension lifecycle + panel IPC (3.x style: exports.methods)
// ----------------------------------------------------------------------- //

exports.methods = {
    // Menu entry -> open the dockable panel.
    openPanel() {
        Editor.Panel.open(PACKAGE_NAME);
    },
    // Panel -> main IPC. Each returns a value so the panel's
    // Editor.Message.request(...) resolves with the live connection state.
    panelConnect(url) {
        return _connect(url);
    },
    panelDisconnect() {
        _disconnect();
        return _connectionState();
    },
    panelStatus() {
        return _connectionState();
    },
    // Server lifecycle. panelStartServer optionally takes the panel's current
    // URL so the spawned server's bridge port matches what we'll connect to.
    panelStartServer(url) {
        if (typeof url === 'string' && url.trim()) _url = url.trim();
        return _startServer();
    },
    panelStopServer() {
        return _stopServer();
    },
    panelServerStatus() {
        return _serverStatus();
    },
    panelSetServerDir(dir) {
        _setServerDir(dir);
        return _serverStatus();
    },
    panelSetHttpPort(port) {
        _setHttpPort(port);
        return _serverStatus();
    },
};

exports.load = async function () {
    _installConsoleHook();
    try {
        const dir = await Editor.Profile.getConfig(PACKAGE_NAME, 'serverDir', 'global');
        if (typeof dir === 'string' && dir.trim()) _cfgServerDir = dir.trim();
    } catch (e) { /* no persisted override — use default */ }
    try {
        const hp = await Editor.Profile.getConfig(PACKAGE_NAME, 'httpPort', 'global');
        if (Number.isFinite(hp)) _cfgHttpPort = hp;
    } catch (e) { /* use default */ }
    console.log('[' + PACKAGE_NAME + '] loaded — open the panel to start the server and Connect.');
};

exports.unload = function () {
    _disconnect();
    _uninstallConsoleHook();
};
