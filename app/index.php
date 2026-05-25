<?php require_once(__DIR__ . '/bootstrap.php'); ?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= APP_NAME ?> <?= APP_VERSION ?></title>
    <link rel="stylesheet" href="assets/css/app.css">
    <link rel="icon" type="image/png" href="assets/img/logo.png">
</head>
<body>

    <!-- ==================== TOP BAR ==================== -->
    <header id="topbar">
        <div id="profile-switcher">
            <select id="profile-select">
                <option value="">— Select Connection —</option>
            </select>
            <div class="topbar-menu" id="topbar-menu">
                <button id="btn-menu-trigger" title="More options">⋯</button>
                <ul class="topbar-menu-dropdown" id="topbar-menu-dropdown">
                    <li id="btn-new-context-shortcut" title="Save as a new context">+ New</li>
                    <li id="btn-load-csv" title="Load a CSV file into the results table">📂 CSV</li>
                    <li id="btn-load-xlsx" title="Load an XLSX file into the results table">📂 XLSX</li>
                    <li class="menu-sep"></li>
                    <li id="btn-manage-profiles">⚙ Profiles</li>
                    <li id="menu-test-connection">↯ Test Connection</li>
                    <li class="menu-sep"></li>
                    <li id="menu-show-shortcuts">⌨ Shortcuts</li>
                    <li class="menu-sep"></li>
                    <li id="menu-about">(: About</li>
                </ul>
            </div>
            <input type="file" id="csv-file-input" accept=".csv" style="display:none">
            <input type="file" id="xlsx-file-input" accept=".xlsx" style="display:none">
            <button id="btn-load-context" title="Save/Load previously copied context">🗂 Contexts</button>
            <button id="btn-show-notes" title="Open notes">✎ Notes</button>
            <button id="btn-save-context" class="btn-save-context" title="Save as a new context">💾</button>
            <button type="button" id="btn-timestamp-conv" title="Timestamp converter">⧖</button>
            <button id="btn-focus-tables" title="Center view on tables">⊙</button>
            <button type="button" id="btn-canvas-overview-zoom" title="Overview zoom — shrink canvas only (toggle; recenters on tables)">⊟</button>
            <div id="undo-redo-bar">
                <button id="btn-undo" title="Undo (Ctrl+Z)" disabled>↩</button>
                <button id="btn-redo" title="Redo (Ctrl+Shift+Z)" disabled>↪</button>
            </div>
            <div id="canvas-search-bar">
                <input type="search" id="canvas-search-input" placeholder="Find…" autocomplete="off" spellcheck="false">
                <select id="canvas-search-filter" title="Search scope">
                    <option value="all">All</option>
                    <option value="tables">Tables</option>
                    <option value="aliases">Aliases</option>
                    <option value="joins">Join labels</option>
                    <option value="islands">Island labels</option>
                </select>
                <span id="canvas-search-count"></span>
                <button id="canvas-search-prev" title="Previous match (Shift+Enter)">↑</button>
                <button id="canvas-search-next" title="Next match (Enter)">↓</button>
                <button id="canvas-search-clear" title="Clear search">✕</button>
            </div>
            <span id="topbar-notes-title"></span>
        </div>
        <div id="app-logo-wrapper">
            <div style="display: none;">
                <div><span id="app-name"><?= APP_NAME ?></span> <span id="app-version"><?= APP_VERSION ?></span></div>
            </div>
            <img src="assets/img/logo.png" title="SQL Joiner <?= APP_VERSION ?>" id="app-logo">
            <div id="app-logo-label"><?= APP_NAME ?></div>
        </div>
    </header>

    <!-- ==================== MAIN LAYOUT ==================== -->
    <main id="layout">

        <!-- LEFT: Table Browser -->
        <aside id="sidebar">
            <div class="pane-resizer" id="resizer-sidebar"></div>
            <div id="sidebar-header">
                <div class="sidebar-header-row">
                    <span>Tables</span>
                    <div class="sidebar-header-actions">
                        <button id="btn-screenshot-canvas" title="Copy canvas as image to clipboard">📸</button>
                        <button id="btn-filter-canvas" title="Show only tables on canvas">⊞</button>
                        <div class="topbar-menu" id="sidebar-menu">
                            <button id="btn-sidebar-menu" title="Table actions">⋯</button>
                            <ul class="topbar-menu-dropdown" id="sidebar-menu-dropdown">
                                <li id="sidebar-menu-select">SELECT</li>
                                <li id="sidebar-menu-raw">raw</li>
                            </ul>
                        </div>
                        <button id="btn-refresh-tables" title="Refresh table list">↻</button>
                    </div>
                </div>
                <div class="sidebar-header-row sidebar-header-sub">
                    <button id="btn-import-query" title="Import an external SQL query to canvas tables and conditions">⇄ Import</button>
                    <button id="btn-add-subquery" title="Add a subquery table to the canvas">+ SubQuery</button>
                    <button id="btn-load-file-to-subquery" alt="Load a .sql or .csv file into a new red sub-query" title="Load a .sql or .csv file into a new red sub-query">Load file</button>
                </div>
            </div>
            <div id="sidebar-db-bar">
                <input type="search" id="db-schema-search" placeholder="Search schemas…" autocomplete="off">
                <ul id="db-select">
                    <li class="sidebar-hint">Select a connection above</li>
                </ul>
            </div>
            <div id="sidebar-search">
                <input type="search" id="table-search" placeholder="Search tables…" autocomplete="off">
            </div>
            <ul id="table-list">
                <li class="sidebar-hint">Select a connection above</li>
            </ul>
        </aside>

        <!-- CENTER: Visual Canvas -->
        <section id="canvas-wrapper">
            <div id="canvas-scale-wrap">
            <div id="canvas">
                <!-- SVG layer for join lines — sits behind table cards -->
                <svg id="join-lines" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <marker id="arrow" markerWidth="6" markerHeight="6"
                                refX="3" refY="3" orient="auto">
                            <path d="M0,0 L0,6 L6,3 z" fill="#4a9eff" />
                        </marker>
                    </defs>
                </svg>
                <!-- Table cards are injected here by canvas.js -->
            </div>
            </div>
            <div id="canvas-hint">Double-click a table in the sidebar to add it to the canvas</div>
        </section>

        <!-- RIGHT: Query Config Panel -->
        <aside id="config-panel">
            <div class="pane-resizer" id="resizer-config"></div>

            <div class="config-section" id="section-where">
                <h3>
                    WHERE
                    <button id="btn-where-to-raw" class="btn-copy-to-raw" title="Copy visual filters to raw SQL">↳ Raw</button>
                    <button id="btn-where-from-json" class="btn-where-from-json hidden" title="Build WHERE clause from a JSON object">↑ JSON</button>
                    <button class="btn-toggle-mode" data-mode="visual" data-section="where">Visual</button>
                </h3>
                <div id="where-drop-zone" class="drop-zone" data-accepts="column" data-section="where">
                    <span class="drop-hint">Drag a column here</span>
                </div>
                <div id="where-conditions"></div>
                <div id="where-raw" class="hidden">
                    <textarea id="where-raw-input" rows="24" placeholder="e.g. o.total > 100 AND u.active = 1" data-sql-backdrop></textarea>
                </div>
            </div>

            <div class="config-section" id="section-groupby">
                <h3>
                    GROUP BY
                    <button id="btn-groupby-to-raw" class="btn-copy-to-raw" title="Copy visual GROUP BY columns to raw SQL">↳ Raw</button>
                    <button class="btn-toggle-mode" data-mode="visual" data-section="groupby">Visual</button>
                </h3>
                <div id="groupby-drop-zone" class="drop-zone" data-accepts="column" data-section="groupby">
                    <span class="drop-hint">Drag a column here</span>
                </div>
                <div id="groupby-columns"></div>
                <div id="groupby-raw" class="hidden">
                    <textarea id="groupby-raw-input" rows="2" placeholder="e.g. u.id, o.status" data-sql-backdrop></textarea>
                </div>
            </div>

            <div class="config-section" id="section-having">
                <h3>
                    HAVING
                    <button id="btn-having-to-raw" class="btn-copy-to-raw" title="Copy visual HAVING conditions to raw SQL">↳ Raw</button>
                    <button class="btn-toggle-mode" data-mode="visual" data-section="having">Visual</button>
                </h3>
                <div id="having-drop-zone" class="drop-zone" data-accepts="column" data-section="having">
                    <span class="drop-hint">Drag a column here</span>
                </div>
                <div id="having-conditions"></div>
                <div id="having-raw" class="hidden">
                    <textarea id="having-raw-input" rows="2" placeholder="e.g. COUNT(o.id) > 5" data-sql-backdrop></textarea>
                </div>
            </div>

            <div class="config-section" id="section-orderby">
                <h3>
                    ORDER BY
                    <button id="btn-orderby-to-raw" class="btn-copy-to-raw" title="Copy visual ORDER BY columns to raw SQL">↳ Raw</button>
                    <button class="btn-toggle-mode" data-mode="visual" data-section="orderby">Visual</button>
                </h3>
                <div id="orderby-drop-zone" class="drop-zone" data-accepts="column" data-section="orderby">
                    <span class="drop-hint">Drag a column here</span>
                </div>
                <div id="orderby-columns"></div>
                <div id="orderby-raw" class="hidden">
                    <textarea id="orderby-raw-input" rows="2" placeholder="e.g. o.created_at DESC, u.name ASC" data-sql-backdrop></textarea>
                </div>
            </div>

            <div class="config-section" id="section-limit">
                <h3>LIMIT</h3>
                <select id="limit-select">
                    <option value="1">1</option>
                    <option value="10" selected>10</option>
                    <option value="100">100</option>
                    <option value="500">500</option>
                    <option value="1000">1000</option>
                </select>
            </div>

            <div class="config-section" id="section-select">
                <h3>
                    SELECT
                    <button id="btn-select-to-raw" class="btn-copy-to-raw" title="Copy visual select columns to raw SQL">↳ Raw</button>
                    <button class="btn-toggle-mode" data-mode="visual" data-section="select">Visual</button>
                </h3>
                <p class="config-empty">Columns appear here once tables are on the canvas.</p>
                <div class="select-delimiter-row">
                    <label title="Sort SELECT columns alphabetically by column name in the query (UI order unchanged)">
                        <input type="checkbox" id="select-sort-alpha-toggle">
                        Sort A→Z
                    </label>
                    <label title="Insert '|||' between each table's columns in the SELECT list">
                        <input type="checkbox" id="select-delimiter-toggle">
                        Table delimiter <code>'|||'</code>
                    </label>
                    <label id="label-table-name-toggle" title="Show the real table origin (db.table) below each result column header">
                        <input type="checkbox" id="select-table-name-toggle">
                        DB Table Name
                    </label>
                    <label id="label-schema-alias-toggle" title="Show table alias prefix in result column headers (e.g. u.id → checked, id → unchecked)">
                        <input type="checkbox" id="select-schema-alias-toggle" checked>
                        DB Schema Alias
                    </label>
                    <label id="label-distinct-toggle" title="Use SELECT DISTINCT to return only unique rows">
                        <input type="checkbox" id="select-distinct-toggle">
                        DISTINCT
                    </label>
                </div>
                <div id="select-columns"></div>
                <div id="select-raw" class="hidden">
                    <textarea id="select-raw-input" rows="24" placeholder="e.g. u.id, u.name, COUNT(o.id) AS order_count" data-sql-backdrop></textarea>
                </div>
            </div>

        </aside>

        <!-- Pane toggle buttons — live in #layout so they float over the canvas, not pane content -->
        <button class="pane-toggle" id="btn-toggle-sidebar" title="Toggle sidebar">‹</button>
        <button class="pane-toggle" id="btn-toggle-config" title="Toggle config panel">›</button>

    </main>

    <!-- ==================== BOTTOM BAR ==================== -->
    <footer id="bottombar">
        <div id="sql-preview-bar" title="Generated SQL query">
            <code id="sql-preview-text">-- Add tables to the canvas to begin</code>
        </div>
        <div id="bottom-actions">

            <input type="checkbox" id="chk-ai-knowledge-save" title="Save to disk instead of copying to clipboard">
            <button id="btn-ai-knowledge" class="btn-outline-blue" title="Generate SELECT + CREATE TABLE definitions for all tables (Ctrl/Cmd+K)">AI Knowledge</button>
            <input type="checkbox" id="chk-plot-show-results" title="Also show results table when plotting">
            <button id="btn-plot-query" class="btn-outline-blue" title="Plot query results as a bar chart">📊 Plot</button>
            <input type="checkbox" id="chk-explain-colors" checked title="Color-code EXPLAIN results">
            <button id="btn-explain-query" class="btn-outline-blue" title="Run EXPLAIN on the current query (Alt+E)">⚙ Explain</button>
            <button id="btn-recordings-toggle" class="rec-toggle-btn" title="Query Recordings — left-click to open, right-click to toggle recording"><span class="rec-dot"></span>Rec <span class="rec-toggle-count">0</span></button>
            <button id="btn-minimap-badge" class="minimap-badge-toggle" title="Toggle minimap (canvas overview)">⊹</button>
            <button id="btn-run-custom-query" class="btn-outline-blue" title="Run a custom SQL query">▶ Run Custom Query</button>
            <button id="btn-cancel-query" class="btn-danger hidden" title="Kill the running query on the server">✕ Cancel Query</button>
            <button id="btn-run-query" class="primary">▶ Run Query</button>
        </div>
    </footer>

    <!-- ==================== RESULTS PANEL ==================== -->
    <div id="results-panel" class="hidden">
        <div id="resizer-results"></div>
        <div id="results-header">
            <div id="results-actions-left">
                <button id="btn-results-help" title="Shortcuts &amp; tips">?</button>
                <div id="results-help-popup" class="hidden">
                    <div class="results-help-section">
                        <span class="results-help-group">Cell</span>
                        <div class="results-help-row"><kbd>Click</kbd> Select cell</div>
                        <div class="results-help-row"><kbd>Right-click</kbd> Cycle cell color</div>
                        <div class="results-help-row"><kbd>Alt + Click</kbd> Highlight / unhighlight row</div>
                        <div class="results-help-row"><kbd>Alt + Right-click</kbd> Trace column origin</div>
                        <div class="results-help-row"><kbd>Alt + Right-click</kbd> <em>in Compare / Duplicates mode</em> — override cell color (persists when mode exits)</div>
                        <div class="results-help-row"><kbd>Double-click</kbd> Add number to Calculus</div>
                        <div class="results-help-row"><kbd>Alt + J</kbd> Copy row as JSON</div>
                        <div class="results-help-row"><kbd>Alt + C</kbd> Load CSV / XLSX file</div>
                        <div class="results-help-row"><kbd>⊙ Snapshot</kbd> Snapshot result for diff</div>
                    </div>
                    <div class="results-help-section">
                        <span class="results-help-group">Header</span>
                        <div class="results-help-row"><kbd>Double-click</kbd> Add column to WHERE</div>
                        <div class="results-help-row"><kbd>Click</kbd> Toggle SELECT checkbox</div>
                        <div class="results-help-row"><kbd>Right-click</kbd> Highlight SELECT checkbox</div>
                        <div class="results-help-row"><kbd>Alt + Click</kbd> Copy <code>`alias`.`column`</code></div>
                        <div class="results-help-row"><kbd>Alt + Right-click</kbd> Preview column distribution</div>
                        <div class="results-help-row"><kbd>⌘/Ctrl + Right-click</kbd> Toggle column highlight (low-yellow + italic; pinned in Dim)</div>
                    </div>
                </div>
                <button id="btn-compare" title="Compare cell values">⊜ Compare</button>
                <button id="btn-duplicates" title="Highlight duplicate cell values">⧉ Duplicates</button>
                <button id="btn-trace" title="Hide repeated values row-to-row (Trace)">⋮ Trace</button>
                <button id="btn-toggle-dim" title="Dim unhighlighted cells">☾ Dim</button>
                <button id="btn-calculus" title="Run a query first to enable Calculus mode" disabled>∑ Calculus</button>
                <button id="btn-compare-datasets" title="Compare current result against a CSV">⇌ Compare Datasets</button>
                <button id="btn-exit-compare-datasets" class="hidden is-active" title="Exit dataset comparison">✕ Exit Compare</button>
                <button id="btn-diff-snapshot" title="Snapshot current result for compare comparison" disabled>⊙ Diff Snapshot</button>
                <button id="btn-diff-exit" class="hidden is-active" title="Exit compare mode">✕ Exit Diff</button>
                <button id="btn-explain-graph" class="hidden" title="Toggle EXPLAIN graph view">⎇ Explain Graph</button>
                <button id="btn-search-cols" title="Toggle column search inputs">⌕ Search</button>
                <button id="btn-save-view-state" class="hidden" title="Save current visual state (Compare, Duplicates, colors, Dim, filters) to this recording">📌 Save</button>
            </div>
            <span id="results-meta"></span>
            <div id="results-actions">
<input type="checkbox" id="chk-csv-to-file" title="Save CSV to file (unchecked = copy to clipboard)">
                <button id="btn-export-csv">↓ CSV</button>
                <input type="checkbox" id="chk-json-to-clipboard" title="Save JSON to file (unchecked = copy to clipboard)">
                <button id="btn-export-json">↓ Heidi JSON</button>
                <button id="btn-copy-sql-select" title="Copy results as SQL SELECT … UNION ALL (wrapped in parentheses)">↓ SQL SELECT</button>
                <button id="btn-results-tall" title="Stretch results height">↕</button>
                <button id="btn-results-fullscreen" title="Maximize results">⤢</button>
                <button id="btn-toggle-results" title="Minimize results">▼</button>
            </div>
        </div>
        <div class="results-legend">
            <span id="legend-compare" class="hidden"><strong>Compare mode:</strong> click header to compare column · click cell to compare column · right-click cell to compare row</span>
            <span id="legend-duplicates" class="hidden"><strong>Duplicates mode:</strong> click header to scan column for duplicates · click cell to scan column · right-click cell to scan row</span>
            <span id="legend-trace" class="hidden"><strong>Trace mode:</strong> repeated values are dimmed — only changes from the previous row are shown at full intensity</span>
        </div>
        <div id="results-error" class="hidden"></div>
        <div id="results-table-wrapper">
            <table id="results-table">
                <thead></thead>
                <tbody></tbody>
            </table>
        </div>
        <div id="explain-graph-wrapper" class="hidden"></div>
    </div>

    <!-- ==================== CALCULUS TOOLBOX (floating, no backdrop) ==================== -->
    <div id="minimap-container" class="hidden">
        <div id="minimap-header">
            <span>Map</span>
            <button id="btn-minimap-close" title="Close minimap">×</button>
        </div>
        <canvas id="minimap-canvas"></canvas>
    </div>

    <!-- ==================== RECORDINGS PANEL ==================== -->
    <div id="recordings-panel" class="hidden">
        <div id="recordings-panel-header">
            <span class="rec-panel-title">Recordings <span id="rec-count-badge" class="rec-count-badge">0</span></span>
            <input type="checkbox" id="chk-rec-select-all" class="rec-select-all-chk" title="Select / deselect all recordings">
            <button id="btn-rec-dim" class="rec-filter-btn" title="DIM — show only selected (checked) recordings">☾ DIM</button>
            <button id="btn-rec-same-color" class="rec-filter-btn" title="Same color — show only recordings whose color matches a checked recording">◈ Same color</button>
            <button id="btn-rec-compare" class="rec-compare-btn" disabled title="Select exactly 2 recordings to compare their results using Diff Snapshot">⊙ Compare</button>
            <button id="btn-rec-delete-selected" class="rec-delete-sel-btn" disabled>⊗</button>
            <span class="rec-header-sep"></span>
            <button id="btn-rec-record" class="rec-record-btn" title="Recording active — click to stop">■ Stop</button>
            <button id="btn-rec-help" title="Shortcuts &amp; tips">?</button>
            <button id="btn-recordings-close" title="Close panel">✕</button>
        </div>
        <!-- Help popup — appended to body in JS to escape overflow:hidden -->
        <div id="rec-help-popup" class="hidden">
            <div class="results-help-section">
                <span class="results-help-group">Row</span>
                <div class="results-help-row"><kbd>Click</kbd> Toggle selection</div>
                <div class="results-help-row"><kbd>Right-click</kbd> Cycle row color</div>
                <div class="results-help-row"><kbd>✎ icon</kbd> Rename entry</div>
                <div class="results-help-row"><kbd>Alt+hover</kbd> Peek SQL preview</div>
                <div class="results-help-row"><kbd>Alt+click</kbd> Pin / unpin SQL preview</div>
            </div>
            <div class="results-help-section">
                <span class="results-help-group">Filters</span>
                <div class="results-help-row"><kbd>☾ DIM</kbd> Show only selected rows</div>
                <div class="results-help-row"><kbd>◈ Same color</kbd> Show rows matching checked color</div>
                <div class="results-help-row"><kbd>⊙ Compare</kbd> Diff two selected recordings</div>
            </div>
            <div class="results-help-section">
                <span class="results-help-group">Actions</span>
                <div class="results-help-row"><kbd>Results</kbd> Load results into table</div>
                <div class="results-help-row"><kbd>SQL</kbd> View generated SQL</div>
                <div class="results-help-row"><kbd>Island</kbd> Restore island config</div>
                <div class="results-help-row"><kbd>☐ (left of Island)</kbd> Restore in new island</div>
                <div class="results-help-row"><kbd>■ Stop / ▶ Record</kbd> Pause / resume recording</div>
            </div>
        </div>
        <div id="rec-search-bar">
            <input type="search" id="rec-search-input" placeholder="Search recordings…" autocomplete="off" spellcheck="false">
        </div>
        <div id="recordings-list"></div>
    </div>

    <div id="calculus-toolbox" class="hidden">
        <div id="calculus-toolbox-header">
            <span>∑ Calculus</span>
            <div class="calculus-header-btns">
                <button id="btn-calculus-eval" title="Eval — type a SELECT expression, then click a results row to build it as a Calculus">Eval</button>
                <button id="btn-calculus-add-row" title="Add a new expression row">+ New</button>
                <button id="btn-calculus-legend" title="Show / hide tips">?</button>
                <button id="btn-calculus-clear" title="Clear all expressions">↺ Clear All</button>
                <button id="btn-calculus-math" title="Open Math Calculator (Alt+M)">∑ Math</button>
                <button id="btn-calculus-note" title="Calculus Note (Alt+K)">Note</button>
                <button id="btn-calculus-semi-compact" title="Collapse table — show row headers and results bar">▤</button>
                <button id="btn-calculus-compact" title="Collapse rows — show only results bar">⊟</button>
                <button id="btn-calculus-maximize" title="Maximize">⤢</button>
                <button id="btn-calculus-close" title="Close toolbox">✕</button>
            </div>
        </div>
        <div id="calculus-toolbox-body">
            <div class="select-expr-legend">Click to copy · Right-click to add to Math · Alt+click to temporarily change value · Alt+right click to highlight in results</div>
            <div id="calculus-legend-comparison" class="select-expr-legend select-expr-legend--comparison hidden">Title comparison: prefix the expression name with <code>=</code> <code>!=</code> <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code> <code>IN (n1, n2, …)</code> followed by a value or formula (e.g. <code>&lt;= 1000</code> · <code>= (col1 + col2)</code> · <code>IN (100, 200, 500)</code>) to highlight the result green (pass) or red (fail)</div>
            <p id="calculus-hint">Double-click a numeric cell in the results table to add it here.</p>
            <div id="calculus-rows-container"></div>
        </div>
        <div class="calculus-resize-handle calculus-resize-e"  data-dir="e"></div>
        <div class="calculus-resize-handle calculus-resize-s"  data-dir="s"></div>
        <div class="calculus-resize-handle calculus-resize-se" data-dir="se"></div>
    </div>

    <!-- ==================== CALCULUS MATH CALCULATOR POPUP ==================== -->
    <div id="calculus-math-popup" class="hidden">
        <div id="calculus-math-header">
            <span>∑ Math Calculator</span>
            <div class="calculus-header-btns">
                <button id="btn-calculus-math-maximize" title="Maximize (Alt+T)">⛶</button>
                <button id="btn-calculus-math-close" title="Close (Esc)">✕</button>
            </div>
        </div>
        <div id="calculus-math-body">
            <div class="calculus-math-input-row">
                <button id="btn-calculus-math-clear" title="Clear (Alt+C)">C</button>
                <textarea id="calculus-math-input" placeholder="Shift+Enter calculate · Alt+C clear" spellcheck="false" autocomplete="off" data-sql-backdrop></textarea>
                <button id="btn-calculus-math-calc" title="Calculate (Shift+Enter)">=</button>
            </div>
            <div id="calculus-math-result"></div>
        </div>
        <div class="calculus-resize-handle calculus-resize-e"  data-dir="e"></div>
        <div class="calculus-resize-handle calculus-resize-s"  data-dir="s"></div>
        <div class="calculus-resize-handle calculus-resize-se" data-dir="se"></div>
    </div>

    <!-- ==================== CALCULUS HISTORY POPUP ==================== -->
    <div id="calculus-history-popup" class="hidden">
        <div id="calculus-history-header">
            <span>⊞ History</span>
            <div class="calculus-header-btns">
                <button id="btn-calculus-history-maximize" title="Maximize">⛶</button>
                <button id="btn-calculus-history-close" title="Close">✕</button>
            </div>
        </div>
        <div id="calculus-history-body">
            <textarea id="calculus-history-textarea" readonly spellcheck="false" placeholder="No history yet — add cells to start tracking." data-sql-backdrop></textarea>
        </div>
        <div id="calculus-history-footer">
            <button id="btn-calculus-history-copy">⧉ Copy</button>
            <button id="btn-calculus-history-csv">↓ Export CSV</button>
        </div>
        <div class="calculus-resize-handle calculus-resize-e"  data-dir="e"></div>
        <div class="calculus-resize-handle calculus-resize-s"  data-dir="s"></div>
        <div class="calculus-resize-handle calculus-resize-se" data-dir="se"></div>
    </div>

    <!-- ==================== MODAL: Calculus Note ==================== -->
    <div id="modal-calculus-note" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-calculus-note-title">
        <div class="modal-box modal-box--calculus-note">
            <div class="modal-header">
                <h2 id="modal-calculus-note-title">Calculus Note</h2>
                <button id="btn-calculus-note-x" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="calculus-note-textarea" placeholder="Write your Calculus notes here…" spellcheck="false"></textarea>
                <div class="form-actions">
                    <button type="button" id="btn-calculus-note-save" class="primary">Save</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: WHERE from JSON ==================== -->
    <div id="modal-where-from-json" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-where-from-json-title">
        <div class="modal-box modal-box--where-from-json">
            <div class="modal-header">
                <h2 id="modal-where-from-json-title">WHERE from JSON</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <p class="modal-hint">Paste a JSON object. Each key→value pair becomes a <code>key = value</code> condition.</p>
                <textarea id="where-from-json-textarea" placeholder='{"col1": "val1", "col2": 42}' rows="10" spellcheck="false"></textarea>
                <div class="form-actions">
                    <span class="modal-hint-inline">Shift+Enter to apply</span>
                    <select id="where-from-json-operator" title="Logical operator between conditions">
                        <option value="AND" selected>AND</option>
                        <option value="OR">OR</option>
                    </select>
                    <button type="button" id="btn-where-from-json-apply" class="primary">Apply</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Manage Profiles ==================== -->
    <div id="modal-profiles" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-profiles-title">
        <div class="modal-box">
            <div class="modal-header">
                <h2 id="modal-profiles-title">Connection Profiles</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <div id="profiles-list"></div>
                <hr>
                <h3 id="profile-form-title">Add Profile</h3>
                <form id="profile-form" autocomplete="off">
                    <input type="hidden" id="profile-id">
                    <label>
                        Name
                        <input type="text" id="profile-name" placeholder="My Production DB" required>
                    </label>
                    <label>
                        Host
                        <input type="text" id="profile-host" placeholder="localhost" required>
                    </label>
                    <div class="form-row">
                        <label style="flex:1">
                            Port
                            <input type="number" id="profile-port" value="3306" min="1" max="65535">
                        </label>
                        <label style="flex:2">
                            Database
                            <input type="text" id="profile-database" placeholder="my_database" required>
                        </label>
                    </div>
                    <label>
                        Username
                        <input type="text" id="profile-user" placeholder="root" required>
                    </label>
                    <label>
                        Password
                        <input type="password" id="profile-password" placeholder="(leave blank if none)">
                    </label>
                    <div class="form-actions">
                        <button type="button" id="btn-save-profile">Save Profile</button>
                        <button type="button" id="btn-test-profile">Test Connection</button>
                        <button type="button" id="btn-clear-profile-form">Clear</button>
                    </div>
                    <div id="profile-test-result"></div>
                </form>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Context Manager ==================== -->
    <div id="modal-context" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-context-title">
        <div class="modal-box modal-box--context">
            <div class="modal-header">
                <h2 id="modal-context-title">Contexts</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">

                <!-- Saved list -->
                <div class="ctx-section-header">
                    <div class="ctx-section-title-group">
                        <button type="button" id="btn-ctx-new" style="font-size:11px;padding:3px 8px;" title="Clear everything and start fresh">+ New</button>
                    </div>
                    <div class="ctx-section-actions">
                        <input type="text" id="ctx-search-input" placeholder="Search…" autocomplete="off">
                        <button type="button" id="btn-ctx-load-file" style="font-size:11px;padding:3px 8px;">📂 Load JSON</button>
                    </div>
                </div>
                <div id="ctx-saved-list">
                    <p class="config-empty">Loading…</p>
                </div>

                <hr class="ctx-hr">

                <!-- Save As -->
                <h3 class="ctx-section-title">Save As</h3>
                <div class="ctx-save-row">
                    <input type="text" id="ctx-name-input" placeholder="e.g. Users by region">
                    <button type="button" id="btn-ctx-save">Save</button>
                </div>
                <div id="ctx-save-result" style="display:none"></div>


            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Join Editor ==================== -->
    <div id="modal-join" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-join-title">
        <div class="modal-box modal-box--small">
            <div class="modal-header">
                <h2 id="modal-join-title">Edit Join</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <div id="join-info" class="join-info"></div>
                <div class="join-conditions-section">
                    <div class="join-conditions-label">ON Conditions</div>
                    <div id="join-conditions"></div>
                    <button type="button" id="btn-add-join-condition" class="btn-add-condition">+ Add condition</button>
                </div>
                <label>
                    Join Type
                    <select id="join-type-select">
                        <option value="INNER">INNER JOIN</option>
                        <option value="LEFT">LEFT JOIN</option>
                        <option value="RIGHT">RIGHT JOIN</option>
                        <option value="FULL">FULL OUTER JOIN</option>
                        <option value="CROSS">CROSS JOIN</option>
                    </select>
                </label>
                <div class="form-actions">
                    <button type="button" id="btn-save-join">Save</button>
                    <button type="button" id="btn-delete-join" class="btn-danger">Remove Join</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Value Editor ==================== -->
    <div id="modal-value-editor" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-value-title">
        <div class="modal-box modal-box--small">
            <div class="modal-header">
                <h2 id="modal-value-title">Edit Value</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <label>
                    Column: <span id="value-editor-col" class="sel-alias"></span>
                </label>
                <textarea id="value-editor-input" rows="6" placeholder="Enter value..." data-sql-backdrop></textarea>
                <div class="form-actions">
                    <button type="button" id="btn-save-value" class="primary">Save</button>
                    <button type="button" class="modal-close">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: SQL Preview ==================== -->
    <div id="modal-sql" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-sql-title">
        <div class="modal-box modal-box--large">
            <div class="modal-header">
                <h2 id="modal-sql-title">SQL Query Preview</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="sql-pretty-input" readonly data-sql-backdrop></textarea>
                <div class="form-actions">
                    <label class="scope-exclusive-label"><input type="checkbox" id="chk-sql-preview-scope-exclusive" checked disabled> multiple</label>
                    <button type="button" id="btn-sql-preview-scope" class="btn-outline-blue btn-scope-mode">Scope</button>
                    <span class="scope-legend">Alt+click: copy scopes <br /> Alt+right-click: extract subquery</span>
                    <button type="button" id="btn-copy-pretty-sql">Copy SQL</button>
                    <div class="tables-menu">
                        <button type="button" class="btn-tables-trigger">Tables ▾</button>
                        <div class="tables-dropdown hidden">
                            <div class="tables-menu-row">
                                <input type="checkbox" class="tables-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-names">NAMES</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-selects-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-selects">SELECTS</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-creates-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-creates">CREATES</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Notes ==================== -->
    <div id="modal-csv-memory" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-csv-memory-title">
        <div class="modal-box modal-box--notes">
            <div class="modal-header">
                <h2 id="modal-csv-memory-title">CSV (memory)</h2>
                <button id="btn-csv-memory-x" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="csv-memory-textarea" placeholder="Paste CSV data here…" spellcheck="false"></textarea>
                <div class="form-actions">
                    <button type="button" id="btn-csv-memory-cancel">Cancel</button>
                    <button type="button" id="btn-csv-memory-apply" class="primary">Apply</button>
                </div>
            </div>
        </div>
    </div>

    <div id="modal-compare-datasets" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-compare-datasets-title">
        <div class="modal-box modal-box--small">
            <div class="modal-header">
                <h2 id="modal-compare-datasets-title">Compare Datasets</h2>
                <button id="btn-compare-ds-x" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <div id="compare-ds-info-a" class="compare-ds-info"></div>
                <div class="compare-ds-b">
                    <div class="compare-ds-b-header">
                        <strong>Dataset B — CSV</strong>
                    </div>
                    <div class="compare-ds-b-actions">
                        <button type="button" id="btn-compare-ds-load-file">↑ Load CSV file</button>
                        <input type="file" id="compare-ds-file-input" accept=".csv" class="hidden">
                    </div>
                    <textarea id="compare-ds-paste-area" placeholder="Paste CSV data here…" spellcheck="false" rows="6"></textarea>
                    <div id="compare-ds-info-b" class="compare-ds-info"></div>
                </div>
                <div id="compare-ds-error" class="compare-ds-error hidden"></div>
                <div class="form-actions">
                    <button type="button" id="btn-compare-ds-cancel">Cancel</button>
                    <button type="button" id="btn-compare-ds-run" class="primary" disabled>Compare</button>
                    <label class="compare-ds-header-chk">
                        <input type="checkbox" id="chk-compare-csv-header" checked>
                        First row is header
                    </label>
                </div>
            </div>
        </div>
    </div>

    <div id="modal-notes" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-notes-title">
        <div class="modal-box modal-box--notes">
            <div class="modal-header">
                <h2 id="modal-notes-title">Notes</h2>
                <button id="btn-notes-x" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="notes-textarea" placeholder="Write your notes here… (saved with context)"></textarea>
                <div class="form-actions">
                    <button type="button" id="btn-notes-save" class="primary">Save</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Custom Query ==================== -->
    <div id="modal-custom-query" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-custom-query-title">
        <div class="modal-box modal-box--custom-query">
            <div class="modal-header">
                <h2 id="modal-custom-query-title">Run Custom Query</h2>
                <button type="button" id="btn-custom-query-help" class="btn-sq-expand-help" title="Shortcuts &amp; drag-and-drop tips">?</button>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div id="custom-query-legend" class="sq-expand-legend hidden" role="dialog" aria-label="Shortcuts &amp; tips legend">
                <div class="sq-expand-legend-header">
                    <strong>Shortcuts &amp; Tips</strong>
                    <button type="button" id="btn-custom-query-legend-close" class="sq-expand-legend-close" aria-label="Close legend">✕</button>
                </div>
                <ul class="shortcuts-list">
                    <li><kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> <span>Run query</span></li>
                    <li><kbd>Cmd/Ctrl</kbd>+<kbd>F9</kbd> <span>Open popup &amp; run query</span></li>
                    <li><kbd>Cmd/Ctrl</kbd>+<kbd>F8</kbd> <span>Explain query (popup must be open)</span></li>
                    <li class="legend-drag-row">
                        <span class="shortcut-mouse">Drag &amp; drop <code>.sql</code></span>
                        <span>Loads the file contents directly into the textarea</span>
                    </li>
                    <li class="legend-drag-row">
                        <span class="shortcut-mouse">Drag &amp; drop <code>.csv</code></span>
                        <span>Converts each row to a <code>SELECT</code> and joins them with <code>UNION ALL</code> — column names become aliases, numbers stay unquoted, empty cells become <code>NULL</code>, strings are single-quoted</span>
                    </li>
                </ul>
            </div>
            <div class="modal-body">
                <textarea id="custom-query-textarea" placeholder="SELECT …" spellcheck="false"></textarea>
                <div class="form-actions">
                    <label class="scope-exclusive-label"><input type="checkbox" id="chk-custom-query-scope-exclusive" checked disabled> multiple</label>
                    <button type="button" id="btn-custom-query-scope" class="btn-outline-blue btn-scope-mode">Scope</button>
                    <span class="scope-legend">Alt+click: copy scopes <br/ > Alt+right-click: extract subquery</span>
                    <button type="button" id="btn-custom-query-format" class="btn-outline-blue">Format</button>
                    <button type="button" id="btn-custom-query-load-file" class="btn-outline-blue" title="Load a .sql or .csv file into the textarea">Load file</button>
                    <input type="file" id="custom-query-file-input" accept=".sql,.csv,text/plain,text/csv" style="display:none">
                    <button type="button" id="btn-custom-query-explain" class="btn-outline-blue">⚙ Explain</button>
                    <button type="button" id="btn-custom-query-run" class="primary">▶ Run</button>
                    <div class="tables-menu">
                        <input type="checkbox" id="chk-custom-query-html" class="sq-html-chk" title="Toggle syntax-highlighted backdrop">
                        <button type="button" class="btn-tables-trigger">Tables ▾</button>
                        <div class="tables-dropdown hidden">
                            <div class="tables-menu-row">
                                <input type="checkbox" class="tables-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-names">NAMES</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-selects-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-selects">SELECTS</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-creates-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-creates">CREATES</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Subquery Expand ==================== -->
    <div id="modal-sq-expand" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-sq-expand-title">
        <div class="modal-box modal-box--sq-expand">
            <div class="modal-header">
                <h2 id="modal-sq-expand-title">Edit Subquery</h2>
                <button type="button" id="btn-sq-expand-help" class="btn-sq-expand-help" title="Keyboard shortcuts &amp; mouse triggers">?</button>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div id="sq-expand-legend" class="sq-expand-legend hidden" role="dialog" aria-label="Shortcuts legend">
                <div class="sq-expand-legend-header">
                    <strong>Shortcuts &amp; Mouse Triggers</strong>
                    <button type="button" id="btn-sq-expand-legend-close" class="sq-expand-legend-close" aria-label="Close legend">✕</button>
                </div>
                <ul class="shortcuts-list">
                    <li><kbd>Alt</kbd>+<kbd>E</kbd> <span>Close popup</span></li>
                    <li><kbd>Alt</kbd>+<kbd>D</kbd> <span>Extract var (cursor token)</span></li>
                    <li><kbd>Alt</kbd>+<kbd>F</kbd> <span>Bind var under cursor</span></li>
                    <li><kbd>Alt</kbd>+<kbd>S</kbd> <span>Toggle scope mode</span></li>
                    <li><kbd>Delete</kbd> <span>Disassemble selected scope (scope mode, single highlight)</span></li>
                    <li><kbd>Alt</kbd>+<kbd>G</kbd> <span>Go to line</span></li>
                    <li><kbd>Shift</kbd>+<kbd>Enter</kbd> <span>Close popup</span></li>
                    <li><kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> <span>Run query</span></li>
                    <li><kbd>↑</kbd> / <kbd>↓</kbd> <span>Jump between same-color lines</span></li>
                    <li><kbd>Escape</kbd> <span>Clear scope highlights (scope mode)</span></li>
                    <li><span class="shortcut-mouse">Right-click line</span> <span>Cycle line color forward</span></li>
                    <li><span class="shortcut-mouse">Shift+right-click line</span> <span>Cycle line color backward</span></li>
                    <li><span class="shortcut-mouse">× badge on line</span> <span>Remove line color</span></li>
                    <li><span class="shortcut-mouse">Click on word</span> <span>Highlight all occurrences</span></li>
                    <li><kbd>F2</kbd> <span>Rename variable under cursor (all instances)</span></li>
                    <li><span class="shortcut-mouse">Alt+click on variable</span> <span>Rename variable (all instances)</span></li>
                    <li><span class="shortcut-mouse">Alt+click</span> <span>Copy scopes to clipboard (scope mode)</span></li>
                    <li><span class="shortcut-mouse">Alt+right-click</span> <span>Extract clicked scope as subquery (scope mode)</span></li>
                </ul>
            </div>
            <div class="modal-body">
                <textarea id="sq-expand-textarea" placeholder="SELECT …" spellcheck="false" data-sql-backdrop></textarea>
                <div class="form-actions">
                    <label class="scope-exclusive-label"><input type="checkbox" id="chk-sq-expand-scope-exclusive" disabled> multiple</label>
                    <button type="button" id="btn-sq-expand-scope" class="btn-outline-blue btn-scope-mode">Scope</button>
                    <span class="scope-legend">Alt+click: copy scopes <br /> Alt+right-click: extract subquery</span>
                    <input type="checkbox" id="chk-sq-expand-extract" title="Checked: create a new subquery on the canvas&#10;Unchecked: apply extraction in-place (undoable)">
                    <button type="button" id="btn-sq-expand-extract" class="btn-outline-blue">Extract vars</button>
                    <button type="button" id="btn-sq-expand-bind-var" class="btn-outline-blue">Bind var</button>
                    <input type="checkbox" id="chk-sq-expand-disassemble" title="Checked: extract removed scope as a new subquery card&#10;Unchecked: remove in-place (undoable)" disabled>
                    <button type="button" id="btn-sq-expand-disassemble" class="btn-outline-blue" disabled>Disassemble</button>
                    <button type="button" id="btn-sq-expand-format" class="btn-outline-blue">Format</button>
                    <button type="button" id="btn-sq-expand-explain" class="btn-outline-blue">⚙ Explain</button>
                    <button type="button" id="btn-sq-expand-run" class="primary">▶ Run</button>
                    <div class="tables-menu">
                        <button type="button" class="btn-tables-trigger">Tables ▾</button>
                        <div class="tables-dropdown hidden">
                            <div class="tables-menu-row">
                                <input type="checkbox" class="tables-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-names">NAMES</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-selects-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-selects">SELECTS</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-creates-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-creates">CREATES</button>
                            </div>
                            <div class="tables-menu-row tables-menu-row--sep">
                                <input type="checkbox" class="tables-ai-knowledge-save-chk" title="Save to disk instead of copying to clipboard">
                                <button type="button" class="btn-tables-ai-knowledge">AI KNOWLEDGE</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Import SQL to Canvas ==================== -->
    <div id="modal-import-query" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-import-query-title">
        <div class="modal-box modal-box--custom-query">
            <div class="modal-header">
                <h2 id="modal-import-query-title">Import SQL to Canvas</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="import-query-textarea" placeholder="Paste your SELECT query here…" spellcheck="false" data-sql-backdrop></textarea>
                <div id="import-query-status" class="import-query-status hidden"></div>
                <div class="form-actions">
                    <label class="scope-exclusive-label"><input type="checkbox" id="chk-import-query-scope-exclusive" checked disabled> multiple</label>
                    <button type="button" id="btn-import-query-scope" class="btn-outline-blue btn-scope-mode">Scope</button>
                    <span class="scope-legend">Alt+click: copy scopes <br /> Alt+right-click: extract subquery</span>
                    <button type="button" id="btn-import-query-format" class="btn-outline-blue">Format</button>
                    <button type="button" id="btn-import-query-explain" class="btn-outline-blue">⚙ Explain</button>
                    <label class="import-append-label"><input type="checkbox" id="chk-import-append" alt="Append to canvas" title="Append to canvas"></label>
                    <button type="button" id="btn-import-query-run" class="primary">⇄ Import</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Shortcuts ==================== -->
    <div id="modal-shortcuts" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-shortcuts-title">
        <div class="modal-box modal-box--small">
            <div class="modal-header">
                <h2 id="modal-shortcuts-title">Keyboard Shortcuts</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <ul class="shortcuts-list">
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>Enter</kbd> <span>Run Query</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>E</kbd> <span>Run EXPLAIN on current query</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>P</kbd> <span>Plot current query results as a bar chart</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>K</kbd> <span>AI Knowledge — build final SELECT query + CREATE TABLE definitions for all tables used (copy to clipboard or save to file)</span></li>
                    <li><kbd>F1</kbd> <span>Focus canvas table search (same as Alt+F)</span></li>
                    <li><kbd>F3</kbd> <span>Toggle Timestamp Converter</span></li>
                    <li><kbd>F4</kbd> <span>Toggle Overview Zoom</span></li>
                    <li><kbd>F5</kbd> <span>Focus mode — hide all panels / press again to restore</span></li>
                    <li><kbd>F6</kbd> <span>Toggle Results panel minimize / restore</span></li>
                    <li><kbd>F7</kbd> <span>Toggle Results panel stretch height</span></li>
                    <li><kbd>F8</kbd> <span>Toggle Results panel fullscreen (maximize)</span></li>
                    <li><kbd>F9</kbd> <span>Toggle Config (right) panel show / hide</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>F9</kbd> <span>Open Run Custom Query</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>F8</kbd> <span>Explain custom query (popup must be open)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>1</kbd> <span>Toggle Table Browser</span></li>
                    <li><kbd>Alt</kbd> + <kbd>2</kbd> <span>Toggle Config Panel</span></li>
                    <li><kbd>Alt</kbd> + <kbd>3</kbd> <span>Toggle Results Panel</span></li>
                    <li><kbd>Alt</kbd> + <kbd>F</kbd> <span>Focus canvas table search</span></li>
                    <li><kbd>Alt</kbd> + <kbd>N</kbd> <span>Open Notes</span></li>
                    <li><kbd>Alt</kbd> + <kbd>C</kbd> <span>Open Load CSV dialog</span></li>
                    <li><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd> <span>Open CSV (memory) dialog</span></li>
                    <li><kbd>Alt</kbd> + <kbd>V</kbd> <span>Toggle Duplicates mode</span></li>
                    <li><kbd>Alt</kbd> + <kbd>X</kbd> / <kbd>U</kbd> <span>Toggle Calculus mode</span></li>
                    <li><kbd>Alt</kbd> + <kbd>K</kbd> <span>Toggle Calculus Note</span></li>
                    <li><kbd>Alt</kbd> + <kbd>M</kbd> <span>Toggle Math Calculator</span></li>
                    <li><kbd>Shift</kbd> + <kbd>Enter</kbd> <span>Evaluate expression (Math Calculator input focused)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>C</kbd> <span>Clear Math Calculator input (when input focused)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>D</kbd> <span>Toggle Dim unjoined tables — or Extract vars (when Edit Subquery textarea is focused)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>F</kbd> <span>Focus canvas table search — or Bind var under cursor (when Edit Subquery textarea is focused)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>T</kbd> <span>Maximize / restore active popup (or results panel when no popup is open)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>G</kbd> <span>Focus SELECT column search</span></li>
                    <li><kbd>Alt</kbd> + <kbd>E</kbd> <span>Focus Table Browser search — or open Edit Subquery popup when a subquery textarea is focused — or close Edit Subquery popup when its textarea is focused (cursor &amp; scroll position preserved)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>L</kbd> <span>Load a <code>.sql</code> or <code>.csv</code> file into the focused subquery textarea (replaces existing content)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>A</kbd> <span>Add table to canvas by schema.table name (island colored yellow)</span></li>
                    <li><kbd>Alt</kbd> + <kbd>S</kbd> <span>Add SubQuery table to canvas and focus its textarea</span></li>
                    <li><kbd>Alt</kbd> + <kbd>I</kbd> <span>Open Import Query popup</span></li>
                    <li><kbd>Alt</kbd> + <kbd>O</kbd> <span>Open / close Saved Contexts</span></li>
                    <li><kbd>Alt</kbd> + <kbd>Y</kbd> <span>Open SQL Query Preview popup</span></li>
                    <li><kbd>Cmd/Ctrl</kbd> + <kbd>C</kbd> <span>Copy selected cell text</span></li>
                    <li><kbd>Shift</kbd> + <kbd>Enter</kbd> <span>Close SQL expression / label popup</span></li>
                    <li><kbd>Esc</kbd> <span>Close SQL expression / label popup</span></li>
                    <li><kbd>←</kbd> / <kbd>→</kbd> <span>Navigate to previous / next pinned plot (when pinned plot popup is open)</span></li>
                    <li>Drag &amp; drop WHERE filters to reorder them</li>
                    <li>Drag &amp; drop SELECT tables or columns to reorder them</li>
                    <li>Right-click a Custom Expression input to edit its label</li>
                    <li><kbd>Alt</kbd> + <kbd>Right-click</kbd> <span>Copy all highlighted scopes to clipboard (Scope mode only)</span></li>
                    <li><span class="shortcut-mouse">Alt+right-click column (canvas card or SELECT box)</span> <span>Scroll &amp; highlight the matching column in the results table</span></li>
                </ul>
                <div class="form-actions">
                    <button type="button" class="modal-close">Close</button>
                </div>
            </div>
        </div>
    </div>

    <div id="modal-create-statement" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-create-statement-title">
        <div class="modal-box modal-box--large">
            <div class="modal-header">
                <h2 id="modal-create-statement-title">CREATE TABLE</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="create-statement-output" class="sql-textarea" readonly spellcheck="false" data-sql-backdrop></textarea>
                <div class="form-actions">
                    <button type="button" id="btn-copy-create-statement">Copy</button>
                </div>
            </div>
        </div>
    </div>


    <!-- ==================== MODAL: Plot ==================== -->
    <div id="modal-plot" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-plot-title">
        <div class="modal-box modal-plot-box">
            <div class="modal-header">
                <h2 id="modal-plot-title">Plot</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body modal-plot-body">
                <div class="plot-nav-row">
                    <button id="btn-plot-prev" class="plot-nav-btn hidden" aria-label="Previous plot">&#8249;</button>
                    <canvas id="plot-canvas" width="640" height="480"></canvas>
                    <button id="btn-plot-next" class="plot-nav-btn hidden" aria-label="Next plot">&#8250;</button>
                </div>
                <input type="text" id="plot-pin-title" placeholder="Pin title (optional)" autocomplete="off">
                <div class="plot-modal-actions">
                    <button id="btn-plot-copy">Copy</button>
                    <button id="btn-plot-save">Save to Disk</button>
                    <button id="btn-plot-flip">Flip Axis</button>
                    <button id="btn-plot-pin" class="primary">Pin to Island</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Pin Container popup ==================== -->
    <div id="modal-pin-container" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-pin-container-title">
        <div class="modal-box modal-pin-container-box">
            <div class="modal-header">
                <h2 id="modal-pin-container-title">Pinned Plots</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body modal-pin-container-body">
                <div id="modal-pin-container-toolbar"></div>
                <div id="modal-pin-container-grid"></div>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: Timestamp Converter ==================== -->
    <div id="modal-timestamp-conv" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-timestamp-conv-title">
        <div class="modal-box modal-box--timestamp-conv">
            <div class="modal-header">
                <h2 id="modal-timestamp-conv-title">⧖ Timestamp Converter</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <p class="modal-hint">Enter a Unix timestamp or a datetime string in either box. Conversion is done via MySQL using the active connection.</p>
                <div class="ts-conv-row">
                    <div class="ts-conv-field">
                        <label for="ts-conv-left">Unix timestamp</label>
                        <input type="text" id="ts-conv-left" placeholder="ex. 1715000000" autocomplete="off" spellcheck="false">
                    </div>
                    <div class="ts-conv-arrow">⇄</div>
                    <div class="ts-conv-field">
                        <label for="ts-conv-right">Datetime</label>
                        <input type="text" id="ts-conv-right" placeholder="ex. 2024-05-06 12:00:00" autocomplete="off" spellcheck="false">
                    </div>
                </div>
                <p id="ts-conv-status" class="ts-conv-status"></p>
            </div>
        </div>
    </div>

    <!-- ==================== MODAL: About ==================== -->
    <div id="modal-about" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-about-title">
        <div class="modal-box">
            <div class="modal-header">
                <h2 id="modal-about-title">About</h2>
                <button class="modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <textarea id="about-content" rows="24" class="sql-textarea" readonly spellcheck="false"></textarea>
                <div class="form-actions">
                    <button type="button" class="modal-close">Close</button>
                </div>
            </div>
        </div>
    </div>

    <!--
        Script load order is significant (no bundler, plain globals):
        1. api.js          — defines API (fetch wrapper), needed by all others
        2. profiles.js     — defines Profiles, needed by app.js
        3. app.js          — defines State, App, Modals; boots on DOMContentLoaded
        4. canvas.js       — defines Canvas (uses State/App at runtime); inits card drag
        5. joins.js        — defines Joins (uses State/App at runtime); inits join drag + SVG lines
        6. config.js       — defines QueryPanel; SELECT/WHERE/ORDER BY panel + SQL preview builder
        7. results.js      — defines Results; result table rendering + CSV/JSON export
        8. undo.js         — defines UndoRedo; full-State snapshot undo/redo (must come last)
        9. sql-backdrop.js — defines SqlBackdrop; live syntax-highlight behind textareas
                             (after app.js so _highlightSQL is available)
    -->
    <script src="assets/js/dialog.js"></script>
    <script src="assets/js/api.js"></script>
    <script src="assets/js/profiles.js"></script>
    <script src="assets/js/autocomplete.js"></script>
    <script src="assets/js/textarea-undo.js"></script>
    <script src="assets/js/app.js"></script>
    <script src="assets/js/canvas.js"></script>
    <script src="assets/js/joins.js"></script>
    <script src="assets/js/islands.js"></script>
    <script src="assets/js/plot.js"></script>
    <script src="assets/js/config.js"></script>
    <script src="assets/js/results.js"></script>
    <script src="assets/js/undo.js"></script>
    <script src="assets/js/sql-backdrop.js"></script>
    <script src="assets/js/minimap.js"></script>
    <script src="assets/js/recordings.js"></script>

    <!-- ==================== TABLE SEARCH MODAL ==================== -->
    <div id="modal-table-search" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-table-search-title">
        <div class="modal-box modal-box--table-search">
            <div class="modal-header">
                <h2 id="modal-table-search-title">Search in <span id="table-search-name"></span></h2>
                <button id="btn-table-search-x" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
                <div class="table-search-controls">
                    <select id="table-search-op"></select>
                    <div id="table-search-value-wrap">
                        <textarea id="table-search-value" placeholder="e.g. 'John'" spellcheck="false" data-sql-backdrop></textarea>
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" id="btn-table-search-cancel">Cancel</button>
                    <button type="button" id="btn-table-search-apply" class="primary">Apply to WHERE</button>
                    <span class="table-search-idx-wrap">
                        <input type="checkbox" id="table-search-indexed-only" class="table-search-idx-chk" disabled>
                        <label for="table-search-indexed-only" class="table-search-idx-label">Only columns with indexes</label>
                    </span>
                </div>
            </div>
        </div>
    </div>

</body>
</html>
