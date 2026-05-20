/**
 * Minimap — scaled-down overview of the 5000×5000 canvas.
 * Shows table positions as small rectangles and the current viewport as a
 * highlighted region. Click or drag to pan the main canvas.
 *
 * Public API:
 *   Minimap.init()    — wire up DOM, called once from App.init()
 *   Minimap.update()  — redraw table rects (call after add/remove/drag/resize)
 *   Minimap.toggle()  — show/hide the minimap panel
 */
const Minimap = (() => {
    const CANVAS_SIZE = 5000;
    const MAP_SIZE    = 200;
    const SCALE       = MAP_SIZE / CANVAS_SIZE;

    let _canvas, _ctx, _wrapper;
    let _visible    = false;
    let _animFrame  = null;
    // Offscreen buffer so viewport overlay composites without clearing table rects
    let _tablesBuf  = null;

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    function init() {
        _canvas  = document.getElementById('minimap-canvas');
        _ctx     = _canvas.getContext('2d');
        _canvas.width  = MAP_SIZE;
        _canvas.height = MAP_SIZE;
        _wrapper = document.getElementById('canvas-wrapper');

        _tablesBuf        = document.createElement('canvas');
        _tablesBuf.width  = MAP_SIZE;
        _tablesBuf.height = MAP_SIZE;

        document.getElementById('btn-minimap-badge')
            .addEventListener('click', toggle);
        document.getElementById('btn-minimap-close')
            .addEventListener('click', toggle);

        _canvas.addEventListener('mousedown', _onMapMouseDown);

        _wrapper.addEventListener('scroll', () => {
            if (_visible) _scheduleViewportOverlay();
        }, { passive: true });
    }

    function toggle() {
        _visible = !_visible;
        document.getElementById('minimap-container')
            .classList.toggle('hidden', !_visible);
        document.getElementById('btn-minimap-badge')
            .classList.toggle('is-active', _visible);
        if (_visible) _drawAll();
    }

    function update() {
        if (!_visible) return;
        _drawAll();
    }

    let _updateFrame = null;
    function scheduleUpdate() {
        if (!_visible || _updateFrame) return;
        _updateFrame = requestAnimationFrame(() => {
            _updateFrame = null;
            _drawAll();
        });
    }

    // -------------------------------------------------------------------------
    // Drawing
    // -------------------------------------------------------------------------

    function _drawAll() {
        _drawTables();
        _overlayViewport();
    }

    function _drawTables() {
        const buf = _tablesBuf.getContext('2d');
        buf.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

        buf.fillStyle = '#1a1a1e';
        buf.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

        const tables = (typeof State !== 'undefined' && State.tables) ? State.tables : [];
        tables.forEach(t => {
            if (!t.position) return;
            const card = document.querySelector(`.table-card[data-table-id="${t.id}"]`);
            const w = card ? card.offsetWidth  : (t.size?.w ?? 180);
            const h = card ? card.offsetHeight : (t.size?.h ?? 120);
            // During drag the card's CSS left/top leads t.position — read live value
            const liveX = card ? parseFloat(card.style.left) : NaN;
            const liveY = card ? parseFloat(card.style.top)  : NaN;
            const x  = (isNaN(liveX) ? t.position.x : liveX) * SCALE;
            const y  = (isNaN(liveY) ? t.position.y : liveY) * SCALE;
            const mw = Math.max(2, w * SCALE);
            const mh = Math.max(2, h * SCALE);

            buf.fillStyle   = t.color || '#2d3748';
            buf.strokeStyle = t.color || '#4a9eff';
            buf.lineWidth   = 0.5;
            buf.beginPath();
            if (buf.roundRect) {
                buf.roundRect(x, y, mw, mh, 1);
            } else {
                buf.rect(x, y, mw, mh);
            }
            buf.fill();
            buf.stroke();
        });

        // Flush buffer to main minimap canvas
        _ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
        _ctx.drawImage(_tablesBuf, 0, 0);
    }

    function _overlayViewport() {
        if (!_visible || !_ctx) return;
        // Restore table layer then composite viewport on top
        _ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
        _ctx.drawImage(_tablesBuf, 0, 0);

        const s  = (typeof Canvas !== 'undefined') ? Canvas.getContentScale() : 1;
        const vx = (_wrapper.scrollLeft / s) * SCALE;
        const vy = (_wrapper.scrollTop  / s) * SCALE;
        const vw = (_wrapper.clientWidth  / s) * SCALE;
        const vh = (_wrapper.clientHeight / s) * SCALE;

        _ctx.fillStyle   = 'rgba(255,255,255,0.06)';
        _ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        _ctx.lineWidth   = 1;
        _ctx.fillRect(vx, vy, vw, vh);
        _ctx.strokeRect(vx, vy, vw, vh);
    }

    function _scheduleViewportOverlay() {
        if (_animFrame) return;
        _animFrame = requestAnimationFrame(() => {
            _animFrame = null;
            _overlayViewport();
        });
    }

    // -------------------------------------------------------------------------
    // Navigation — click / drag to pan
    // -------------------------------------------------------------------------

    function _onMapMouseDown(e) {
        _panToEvent(e);
        function onMove(ev) { _panToEvent(ev); }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        e.preventDefault();
    }

    function _panToEvent(e) {
        const r  = _canvas.getBoundingClientRect();
        const mx = ((e.clientX - r.left) / r.width)  * CANVAS_SIZE;
        const my = ((e.clientY - r.top)  / r.height) * CANVAS_SIZE;
        const s  = (typeof Canvas !== 'undefined') ? Canvas.getContentScale() : 1;
        _wrapper.scrollLeft = mx * s - _wrapper.clientWidth  / 2;
        _wrapper.scrollTop  = my * s - _wrapper.clientHeight / 2;
    }

    // -------------------------------------------------------------------------

    return { init, update, scheduleUpdate, toggle };
})();
