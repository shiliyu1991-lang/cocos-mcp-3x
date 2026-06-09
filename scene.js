'use strict';

/**
 * Cocos MCP (3.8.x) — scene-context script.
 *
 * Registered via the `scene` field in package.json. Its `methods` run inside
 * the scene process, where the engine runtime (`cc`) and the live scene graph
 * (`director.getScene()`) are available. The main process reaches these via:
 *
 *   Editor.Message.request('scene', 'execute-scene-script',
 *       { name: 'cocos-mcp-3x', method: 'evalInScene', args: [code] });
 */

function _coerce(value) {
    if (value === undefined) return null;
    try { JSON.parse(JSON.stringify(value)); return value; }
    catch (e) { return String(value); }
}

exports.methods = {
    // Report the currently-open scene from the engine's point of view.
    async sceneCurrent() {
        const { director } = require('cc');
        const scene = director.getScene();
        if (!scene) return { open: false };
        return {
            open: true,
            name: scene.name,
            uuid: scene.uuid,
            childCount: scene.children ? scene.children.length : 0,
        };
    },

    // Run an arbitrary JS snippet with `cc` and `director` in scope. The
    // snippet is wrapped as `(async () => { <code> })()`; its resolved value
    // is returned (coerced to something JSON-serializable).
    async evalInScene(code) {
        const cc = require('cc');
        const director = cc.director;
        const fn = new Function('cc', 'director',
            '"use strict"; return (async () => { ' + code + ' })();');
        const value = await fn(cc, director);
        return _coerce(value);
    },
};

exports.load = function () {};
exports.unload = function () {};
