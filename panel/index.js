'use strict';

/**
 * Cocos MCP (3.8.x) — dockable panel.
 *
 * Drives the main process (main.js) over IPC. Two concerns:
 *   - Python server lifecycle: Start / Stop / status (the server hosts the
 *     WebSocket bridge this extension dials into).
 *       Editor.Message.request('cocos-mcp-3x',
 *         'panel-start-server'|'panel-stop-server'|'panel-server-status'|'panel-set-server-dir', ...)
 *   - WebSocket connection: Connect / Disconnect / status.
 *       Editor.Message.request('cocos-mcp-3x',
 *         'panel-connect'|'panel-disconnect'|'panel-status', ...)
 *
 * On open (ready) it polls both states, so it always reflects whether the
 * server is currently running — even one started outside the editor.
 */

const PKG = 'cocos-mcp-3x';
const DEFAULT_URL = 'ws://127.0.0.1:6020/cocosmcp';
const DEFAULT_BRIDGE_PORT = 6020;   // WebSocket bridge (extension <-> server)
const DEFAULT_HTTP_PORT = 8799;     // MCP HTTP endpoint (client <-> server)

module.exports = Editor.Panel.define({
    template: `
<div class="mcp">
    <header>Cocos MCP bridge</header>

    <ui-prop>
        <ui-label slot="label" value="Server URL"></ui-label>
        <ui-input id="url" slot="content"></ui-input>
    </ui-prop>
    <ui-prop>
        <ui-label slot="label" value="Bridge port"></ui-label>
        <ui-input id="bridgeport" slot="content" placeholder="6020"></ui-input>
    </ui-prop>
    <ui-prop>
        <ui-label slot="label" value="HTTP port"></ui-label>
        <ui-input id="httpport" slot="content" placeholder="8799"></ui-input>
    </ui-prop>
    <div class="hint">Default ports — bridge 6020, http 8799. If one is in use, change it here, then Start. The Server URL syncs to the bridge port automatically.</div>
    <ui-prop>
        <ui-label slot="label" value="Server dir"></ui-label>
        <ui-input id="serverdir" slot="content" placeholder="auto — bundled ./server (leave blank)"></ui-input>
    </ui-prop>
    <div class="hint" id="sinfo">resolving server path…</div>
    <div class="minirow"><ui-button id="resetdir">Use plugin default</ui-button></div>

    <div class="row">
        <ui-button id="start" type="success">Start Server</ui-button>
        <ui-button id="stop">Stop Server</ui-button>
    </div>
    <div class="state">
        <span class="dot" id="sdot"></span>
        <span id="sstatus">server: unknown</span>
    </div>

    <div class="sep"></div>

    <div class="row">
        <ui-button id="connect" type="primary">Connect</ui-button>
        <ui-button id="disconnect">Disconnect</ui-button>
    </div>
    <div class="state">
        <span class="dot" id="dot"></span>
        <span id="status">unknown</span>
    </div>

    <div class="err" id="err"></div>
    <footer>The Python server is bundled in this plugin (./server). Start Server, then Connect.</footer>
</div>`,
    style: `
.mcp { padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
.mcp header { font-weight: bold; font-size: 13px; }
.mcp .row { display: flex; gap: 8px; }
.mcp .state { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.mcp .sep { border-top: 1px solid #4444; margin: 4px 0; }
.mcp .dot { width: 10px; height: 10px; border-radius: 50%; background: #888; display: inline-block; }
.mcp .dot.on { background: #3c3; }
.mcp .dot.off { background: #c33; }
.mcp .err { color: #d66; min-height: 14px; white-space: pre-wrap; }
.mcp .hint { color: #888; font-size: 11px; white-space: pre-wrap; word-break: break-all; line-height: 1.4; }
.mcp .hint .bad { color: #d66; }
.mcp .hint .ok { color: #3c3; }
.mcp .minirow { display: flex; justify-content: flex-end; margin-top: -2px; }
.mcp footer { color: #999; margin-top: auto; }
`,
    $: {
        url: '#url',
        bridgeport: '#bridgeport',
        httpport: '#httpport',
        serverdir: '#serverdir',
        sinfo: '#sinfo',
        resetdir: '#resetdir',
        start: '#start',
        stop: '#stop',
        sstatus: '#sstatus',
        sdot: '#sdot',
        connect: '#connect',
        disconnect: '#disconnect',
        status: '#status',
        dot: '#dot',
        err: '#err',
    },
    methods: {
        _setDisabled(el, on) {
            if (!el) return;
            if (on) el.setAttribute('disabled', '');
            else el.removeAttribute('disabled');
        },
        // Read the port fields, falling back to defaults on blank/invalid input.
        _bridgePort() {
            const v = parseInt((this.$.bridgeport && this.$.bridgeport.value) || '', 10);
            return (Number.isFinite(v) && v > 0 && v <= 65535) ? v : DEFAULT_BRIDGE_PORT;
        },
        _httpPort() {
            const v = parseInt((this.$.httpport && this.$.httpport.value) || '', 10);
            return (Number.isFinite(v) && v > 0 && v <= 65535) ? v : DEFAULT_HTTP_PORT;
        },
        // Rebuild the ws:// URL keeping the current host/path, swapping in the
        // given bridge port. The Server URL field is the human-readable mirror
        // of (host, bridge port); the port field is the source of truth.
        _buildUrl(bridgePort) {
            let host = '127.0.0.1', path = '/cocosmcp';
            const cur = ((this.$.url && this.$.url.value) || DEFAULT_URL).trim();
            const m = /^ws:\/\/([^/:]+)(?::\d+)?(\/.*)?$/.exec(cur);
            if (m) { host = m[1]; if (m[2]) path = m[2]; }
            return 'ws://' + host + ':' + bridgePort + path;
        },
        _renderServer(s) {
            s = s || {};
            const running = !!s.running;
            this.$.sstatus.innerText = running
                ? ('server: running' + (s.managed ? ' (managed)' : ' (external)'))
                : 'server: stopped';
            this.$.sdot.className = 'dot ' + (running ? 'on' : 'off');
            this._setDisabled(this.$.start, running);
            this._setDisabled(this.$.stop, !running);
            // Show the *resolved* server dir in the field so the user can see
            // exactly which server will run — by default the plugin's own
            // ./server. _defaultDir is remembered so _start knows when the field
            // still equals the auto value (and therefore must NOT be persisted
            // as a machine-specific override).
            this._defaultDir = s.defaultServerDir || '';
            if (this.$.serverdir && !this._dirTyped) {
                this.$.serverdir.value = s.serverDir || '';
            }
            // Reflect the live ports until the user starts editing them.
            if (this.$.bridgeport && !this._bpTyped && Number.isFinite(s.bridgePort)) {
                this.$.bridgeport.value = String(s.bridgePort);
            }
            if (this.$.httpport && !this._hpTyped && Number.isFinite(s.httpPort)) {
                this.$.httpport.value = String(s.httpPort);
            }
            this._renderServerHint(s);
            this.$.err.innerText = s.lastError ? String(s.lastError) : '';
        },
        // Show the resolved server path + whether the Python venv / src were
        // found, so the user knows exactly what (if anything) to configure.
        _renderServerHint(s) {
            if (!this.$.sinfo) return;
            if (s.serverDir === undefined) { this.$.sinfo.innerText = ''; return; }
            const esc = (t) => String(t == null ? '' : t)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const rows = [];
            rows.push('dir: ' + esc(s.serverDir) +
                (s.isDefaultDir ? '  <span class="ok">(auto, bundled)</span>' : '  (custom override)'));
            rows.push(s.pythonExists
                ? 'python: <span class="ok">found</span>'
                : 'python: <span class="bad">NOT FOUND</span> — ' + esc(s.pythonPath));
            if (s.srcExists === false) {
                rows.push('<span class="bad">src/main.py not found under this dir — set a custom Server dir above.</span>');
            }
            if (s.pythonExists === false && s.serverDir) {
                rows.push('fix: open a terminal in the dir above, then run\n' +
                    '  python -m venv .venv\n' +
                    '  .venv\\Scripts\\python -m pip install -e .');
            }
            this.$.sinfo.innerHTML = rows.join('\n');
        },
        _render(s) {
            s = s || {};
            const connected = !!s.connected;
            this.$.status.innerText = connected ? 'connected' : 'disconnected';
            this.$.dot.className = 'dot ' + (connected ? 'on' : 'off');
            if (!connected && s.lastError) this.$.err.innerText = String(s.lastError);
            if (s.url && this.$.url && !this._userTyped) this.$.url.value = s.url;
        },
        async _start() {
            const bridgePort = this._bridgePort();
            const httpPort = this._httpPort();
            // The bridge port drives both the spawned server and the URL we
            // connect to — sync the Server URL field so they never disagree.
            const url = this._buildUrl(bridgePort);
            if (this.$.url) this.$.url.value = url;
            const dir = ((this.$.serverdir && this.$.serverdir.value) || '').trim();
            // If the field still holds the auto-resolved plugin path (or is
            // blank), persist NO override — that keeps the plugin self-contained
            // and portable. Only a genuine change becomes a saved override.
            const override = (dir && dir === this._defaultDir) ? '' : dir;
            try {
                await Editor.Message.request(PKG, 'panel-set-server-dir', override);
                await Editor.Message.request(PKG, 'panel-set-http-port', httpPort);
                this.$.sstatus.innerText = 'server: starting…';
                this._setDisabled(this.$.start, true);
                const s = await Editor.Message.request(PKG, 'panel-start-server', url);
                this._renderServer(s);
            } catch (e) {
                this.$.err.innerText = String(e && e.message ? e.message : e);
                this._setDisabled(this.$.start, false);
            }
        },
        // Clear any persisted custom override and fall back to the plugin's
        // bundled ./server. Fixes a panel that's stuck on an old/stale path.
        async _resetDir() {
            try {
                this._dirTyped = false;
                if (this.$.serverdir) this.$.serverdir.value = '';
                const s = await Editor.Message.request(PKG, 'panel-set-server-dir', '');
                this._renderServer(s);
            } catch (e) {
                this.$.err.innerText = String(e && e.message ? e.message : e);
            }
        },
        async _stop() {
            try {
                this.$.sstatus.innerText = 'server: stopping…';
                this._setDisabled(this.$.stop, true);
                const s = await Editor.Message.request(PKG, 'panel-stop-server');
                this._renderServer(s);
            } catch (e) {
                this.$.err.innerText = String(e && e.message ? e.message : e);
                this._setDisabled(this.$.stop, false);
            }
        },
        async _connect() {
            // Connect to the same bridge port shown in the field (also covers a
            // server already running, started elsewhere on that port).
            const url = this._buildUrl(this._bridgePort());
            if (this.$.url) this.$.url.value = url;
            try {
                const s = await Editor.Message.request(PKG, 'panel-connect', url);
                this._render(s);
            } catch (e) {
                this.$.err.innerText = String(e && e.message ? e.message : e);
            }
        },
        async _disconnect() {
            try {
                const s = await Editor.Message.request(PKG, 'panel-disconnect');
                this._render(s);
            } catch (e) {
                this.$.err.innerText = String(e && e.message ? e.message : e);
            }
        },
        async _poll() {
            try {
                const ss = await Editor.Message.request(PKG, 'panel-server-status');
                this._renderServer(ss);
            } catch (e) { /* main process may not be ready yet */ }
            try {
                const s = await Editor.Message.request(PKG, 'panel-status');
                this._render(s);
            } catch (e) { /* idem */ }
        },
    },
    ready() {
        this._userTyped = false;
        this._dirTyped = false;
        this._bpTyped = false;
        this._hpTyped = false;
        if (this.$.url) {
            this.$.url.value = DEFAULT_URL;
            this.$.url.addEventListener('input', () => {
                this._userTyped = true;
                // Editing the URL's port keeps the Bridge port field in sync.
                const m = /^ws:\/\/[^/:]+:(\d+)/.exec((this.$.url.value || '').trim());
                if (m && this.$.bridgeport) { this.$.bridgeport.value = m[1]; this._bpTyped = true; }
            });
        }
        if (this.$.bridgeport) {
            this.$.bridgeport.value = String(DEFAULT_BRIDGE_PORT);
            this.$.bridgeport.addEventListener('input', () => {
                this._bpTyped = true;
                this._userTyped = true;
                // Mirror the chosen bridge port into the Server URL immediately.
                if (this.$.url) this.$.url.value = this._buildUrl(this._bridgePort());
            });
        }
        if (this.$.httpport) {
            this.$.httpport.value = String(DEFAULT_HTTP_PORT);
            this.$.httpport.addEventListener('input', () => { this._hpTyped = true; });
        }
        if (this.$.serverdir) {
            this.$.serverdir.addEventListener('input', () => { this._dirTyped = true; });
        }
        if (this.$.resetdir) this.$.resetdir.addEventListener('confirm', () => this._resetDir());
        if (this.$.start) this.$.start.addEventListener('confirm', () => this._start());
        if (this.$.stop) this.$.stop.addEventListener('confirm', () => this._stop());
        if (this.$.connect) this.$.connect.addEventListener('confirm', () => this._connect());
        if (this.$.disconnect) this.$.disconnect.addEventListener('confirm', () => this._disconnect());
        this._poll();
        this._timer = setInterval(() => this._poll(), 1500);
    },
    close() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
});
