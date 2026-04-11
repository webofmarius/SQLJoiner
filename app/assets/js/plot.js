'use strict';

/**
 * plot.js — Plot namespace: validates query result data and draws bar charts
 * onto an HTML5 Canvas element (640×480).
 *
 * Public API:
 *   Plot.validateAndExtract(rows, cols) → { xLabels, yValues, xColName, yColName }
 *                                         Throws a user-friendly Error on bad data.
 *   Plot.draw(canvas, rows, cols, title) → void   Calls validateAndExtract internally.
 */
const Plot = (() => {

    // Visual constants
    const BAR_FILL    = 'rgba(66, 133, 244, 0.82)';
    const BAR_STROKE  = 'rgba(40,  100, 200, 1)';
    const GRID_COLOR  = '#dde2ea';
    const AXIS_COLOR  = '#444';
    const TEXT_COLOR  = '#222';
    const BG_OUTER    = '#f0f2f5';
    const BG_PLOT     = '#ffffff';

    // Layout margins inside the 640×480 canvas
    const ML = 72;   // left   (room for Y-axis labels)
    const MR = 24;   // right
    const MT = 48;   // top    (room for title)
    const MB = 80;   // bottom (room for X-axis labels + axis name)

    // -------------------------------------------------------------------------
    // validateAndExtract
    // -------------------------------------------------------------------------
    /**
     * Inspects every value in each column and classifies columns as numeric or text.
     * A column is numeric when ALL its values parse as finite numbers (no NULLs allowed).
     *
     * Returns { xLabels, yValues, xColName, yColName }.
     * Throws an Error with a user-friendly message on any validation failure.
     */
    function validateAndExtract(rows, cols) {
        if (!rows || rows.length === 0) {
            throw new Error('The query returned no rows — nothing to plot.');
        }

        // Column count gate: must be exactly 1 or 2 columns
        if (cols.length === 0) {
            throw new Error('The query returned no columns — nothing to plot.');
        }
        if (cols.length > 2) {
            throw new Error(
                `Plotting requires exactly 1 or 2 columns.\n` +
                `This query returned ${cols.length} columns — please narrow your SELECT.`
            );
        }

        // All columns must be fully numeric (no NULLs, no non-numeric values)
        for (let ci = 0; ci < cols.length; ci++) {
            for (let ri = 0; ri < rows.length; ri++) {
                const val = rows[ri][ci];
                if (val === null || val === undefined || val === '') {
                    throw new Error(
                        `NULL value found in column "${cols[ci]}" at row ${ri + 1}.\n` +
                        `NULLs are not supported for plotting.`
                    );
                }
                if (!isFinite(Number(val))) {
                    throw new Error(
                        `Non-numeric value "${val}" found in column "${cols[ci]}" at row ${ri + 1}.\n` +
                        `All column values must be numeric.`
                    );
                }
            }
        }

        // --- 1-column mode: X = row index, Y = col values ---
        if (cols.length === 1) {
            return {
                xLabels:  rows.map((_, i) => String(i)),
                yValues:  rows.map(row => Number(row[0])),
                xColName: 'Index',
                yColName: cols[0],
            };
        }

        // --- 2-column mode: X = col1, Y = col2 (both numeric) ---
        return {
            xLabels:  rows.map(row => String(row[0])),
            yValues:  rows.map(row => Number(row[1])),
            xColName: cols[0],
            yColName: cols[1],
        };
    }

    // -------------------------------------------------------------------------
    // draw
    // -------------------------------------------------------------------------
    /**
     * Draws a bar chart onto canvas.
     * @param {HTMLCanvasElement} canvas
     * @param {Array<Array>}      rows     2-D result rows
     * @param {string[]}          cols     Column names
     * @param {string}            title    Chart title
     */
    function draw(canvas, rows, cols, title) {
        const data = validateAndExtract(rows, cols);
        _drawFromData(canvas, data, title);
    }

    function _drawFromData(canvas, data, title) {
        const { xLabels, yValues, xColName, yColName } = data;
        const ctx = canvas.getContext('2d');
        const W   = canvas.width;
        const H   = canvas.height;

        const plotW = W - ML - MR;
        const plotH = H - MT - MB;

        // ---- Background ----
        ctx.fillStyle = BG_OUTER;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = BG_PLOT;
        ctx.fillRect(ML, MT, plotW, plotH);

        // ---- Title ----
        ctx.fillStyle   = TEXT_COLOR;
        ctx.font        = 'bold 14px sans-serif';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(_truncate(title, 70), W / 2, MT / 2);

        // ---- Y-axis scale ----
        const yMin    = 0;
        const yMax    = Math.max(...yValues, 0);
        const yRange  = yMax - yMin || 1;
        const yPadded = yRange * 1.10;    // 10% headroom

        // ---- Bars + X-axis labels ----
        const n      = xLabels.length;
        const slotW  = plotW / n;
        const barPad = Math.max(0.1, Math.min(0.35, 2 / n));
        const barW   = slotW * (1 - barPad);

        // Max tick/label count for both axes — keeps labels readable at any data size
        const MAX_LABELS = 10;

        // Only draw ~10 X labels regardless of how many bars there are
        const xLabelStep = n <= MAX_LABELS ? 1 : Math.ceil(n / MAX_LABELS);

        // ---- Grid lines + Y-tick labels ----
        const yTicks = MAX_LABELS;
        ctx.font         = '10px sans-serif';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= yTicks; i++) {
            const val = yMin + (yPadded / yTicks) * i;
            const y   = MT + plotH - plotH * (val - yMin) / yPadded;

            ctx.strokeStyle = GRID_COLOR;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(ML, y);
            ctx.lineTo(ML + plotW, y);
            ctx.stroke();

            ctx.fillStyle = TEXT_COLOR;
            ctx.fillText(_fmtNum(val), ML - 5, y);
        }

        xLabels.forEach((label, i) => {
            const val  = yValues[i];
            const barH = plotH * (val - yMin) / yPadded;
            const bx   = ML + i * slotW + slotW * barPad / 2;
            const by   = MT + plotH - barH;

            ctx.fillStyle   = BAR_FILL;
            ctx.strokeStyle = BAR_STROKE;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.rect(bx, by, barW, Math.max(barH, 0));
            ctx.fill();
            ctx.stroke();

            // X tick label — only every xLabelStep bars, rotated 45° to avoid overlap
            if (i % xLabelStep === 0) {
                ctx.save();
                ctx.font         = '10px sans-serif';
                ctx.fillStyle    = TEXT_COLOR;
                ctx.textAlign    = 'right';
                ctx.textBaseline = 'middle';
                ctx.translate(bx + barW / 2, MT + plotH + 8);
                ctx.rotate(-Math.PI / 4);
                ctx.fillText(_truncate(String(label), 18), 0, 0);
                ctx.restore();
            }
        });

        // ---- Axis lines ----
        ctx.strokeStyle = AXIS_COLOR;
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(ML, MT);
        ctx.lineTo(ML, MT + plotH);
        ctx.lineTo(ML + plotW, MT + plotH);
        ctx.stroke();

        // ---- Axis labels ----
        ctx.fillStyle    = TEXT_COLOR;
        ctx.font         = '12px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        // X axis label
        ctx.fillText(_truncate(xColName, 40), ML + plotW / 2, H - 10);
        // Y axis label (rotated)
        ctx.save();
        ctx.translate(14, MT + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(_truncate(yColName, 40), 0, 0);
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function _fmtNum(n) {
        if (Math.abs(n) >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
        if (Math.abs(n) >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
        if (Number.isInteger(n)) return n.toString();
        return parseFloat(n.toFixed(2)).toString();
    }

    function _truncate(str, max) {
        if (!str) return '';
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    // -------------------------------------------------------------------------
    // drawHorizontal
    // -------------------------------------------------------------------------
    /**
     * Draws a horizontal bar chart (bars grow left→right).
     * Same validation as draw(); axes are swapped.
     */
    function drawHorizontal(canvas, rows, cols, title) {
        const data = validateAndExtract(rows, cols);
        _drawHorizontalFromData(canvas, data, title);
    }

    function _drawHorizontalFromData(canvas, data, title) {
        const { xLabels, yValues, xColName, yColName } = data;
        const ctx = canvas.getContext('2d');
        const W   = canvas.width;
        const H   = canvas.height;

        // Wider left margin for category labels
        const HML = 100;
        const HMR = 24;
        const HMT = 48;
        const HMB = 60;

        const plotW = W - HML - HMR;
        const plotH = H - HMT - HMB;

        // ---- Background ----
        ctx.fillStyle = BG_OUTER;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = BG_PLOT;
        ctx.fillRect(HML, HMT, plotW, plotH);

        // ---- Title ----
        ctx.fillStyle    = TEXT_COLOR;
        ctx.font         = 'bold 14px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(_truncate(title, 70), W / 2, HMT / 2);

        // ---- X-axis scale (numeric, horizontal) ----
        const yMin    = 0;
        const yMax    = Math.max(...yValues, 0);
        const yRange  = yMax - yMin || 1;
        const yPadded = yRange * 1.10;

        const n      = xLabels.length;
        const slotH  = plotH / n;
        const barPad = Math.max(0.1, Math.min(0.35, 2 / n));
        const barH   = slotH * (1 - barPad);

        const MAX_LABELS = 10;
        const yLabelStep = n <= MAX_LABELS ? 1 : Math.ceil(n / MAX_LABELS);
        const xTicks     = MAX_LABELS;

        // ---- Grid lines + X-tick labels (numeric) ----
        ctx.font         = '10px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';

        for (let i = 0; i <= xTicks; i++) {
            const val = yMin + (yPadded / xTicks) * i;
            const x   = HML + plotW * (val - yMin) / yPadded;

            ctx.strokeStyle = GRID_COLOR;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(x, HMT);
            ctx.lineTo(x, HMT + plotH);
            ctx.stroke();

            ctx.fillStyle    = TEXT_COLOR;
            ctx.textBaseline = 'top';
            ctx.fillText(_fmtNum(val), x, HMT + plotH + 5);
        }

        // ---- Bars + category labels ----
        xLabels.forEach((label, i) => {
            const val  = yValues[i];
            const barW = plotW * (val - yMin) / yPadded;
            const by   = HMT + i * slotH + slotH * barPad / 2;

            ctx.fillStyle   = BAR_FILL;
            ctx.strokeStyle = BAR_STROKE;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.rect(HML, by, Math.max(barW, 0), barH);
            ctx.fill();
            ctx.stroke();

            if (i % yLabelStep === 0) {
                ctx.font         = '10px sans-serif';
                ctx.fillStyle    = TEXT_COLOR;
                ctx.textAlign    = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(_truncate(String(label), 14), HML - 5, by + barH / 2);
            }
        });

        // ---- Axis lines ----
        ctx.strokeStyle = AXIS_COLOR;
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(HML, HMT);
        ctx.lineTo(HML, HMT + plotH);
        ctx.lineTo(HML + plotW, HMT + plotH);
        ctx.stroke();

        // ---- Axis labels ----
        ctx.fillStyle    = TEXT_COLOR;
        ctx.font         = '12px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        // Bottom axis = value axis
        ctx.fillText(_truncate(yColName, 40), HML + plotW / 2, H - 10);
        // Left axis = category axis (rotated)
        ctx.save();
        ctx.translate(14, HMT + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(_truncate(xColName, 40), 0, 0);
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    return { draw, drawHorizontal, validateAndExtract };

})();
