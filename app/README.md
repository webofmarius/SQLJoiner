# App Directory

SQL Joiner is a visual MySQL query builder. The backend is vanilla PHP with PSR-4 autoloading and PDO; the frontend is vanilla JavaScript with no frameworks.

---

## Entry Points

| File | Purpose |
|------|---------|
| `index.php` | Serves the full UI (HTML + JS includes) |
| `api.php` | JSON API dispatcher — routes `?action=` to handler classes |
| `cancel_query.php` | Kills a running query via `KILL QUERY <id>` on a separate connection |
| `about.php` | Static content rendered by `AboutManager` |
| `bootstrap.php` | Defines constants (`BASE_PATH`, `STORAGE_PATH`) and registers the PSR-4 autoloader |

---

## Backend — `src/`

### Core

| Class | Purpose |
|-------|---------|
| `Core\Request` | Wraps incoming requests; reads JSON body from `php://input`, falls back to `$_GET`/`$_POST` |
| `Core\Response` | Emits a uniform JSON envelope `{ success, message, data }` and calls `exit()` |
| `Core\ContextManager` | CRUD for named canvas states, stored as JSON files in `storage/contexts/` |
| `Core\AboutManager` | Reads and returns the content of `about.php` |

### Database

| Class | Purpose |
|-------|---------|
| `Database\Connection` | Opens a PDO MySQL connection from a profile array; forces `utf8mb4` charset |
| `Database\ProfileManager` | CRUD for connection profiles stored in `storage/profiles.json`; passwords excluded from list responses |
| `Database\SchemaInspector` | Queries `INFORMATION_SCHEMA` to list databases, tables, columns, row counts, and `CREATE TABLE` DDL |

### Query

| Class | Purpose |
|-------|---------|
| `Query\QueryBuilder` | Assembles and executes `SELECT` from canvas state; supports execute, executeRaw, and preview modes |
| `Query\QueryParser` | Parses an external SQL `SELECT` string back into structured canvas state for import |
| `Query\JoinClause` | Builds the `JOIN` chain using a connected-components algorithm; handles INNER/LEFT/RIGHT/FULL/CROSS |
| `Query\WhereClause` | Builds `WHERE`; whitelisted operators; visual or raw passthrough mode |
| `Query\HavingClause` | Same pattern as `WhereClause`, applied to `HAVING` |
| `Query\GroupByClause` | Builds `GROUP BY`; validates `alias.column` references |
| `Query\OrderByClause` | Builds `ORDER BY`; validates `ASC`/`DESC` direction |

---

## API Actions

All requests go to `api.php` with `?action=<name>` (or `{ "action": "..." }` in the JSON body).

| Action | Handler |
|--------|---------|
| `profile.list / .save / .delete / .test` | `ProfileManager` |
| `schema.databases / .tables / .columns / .createStatement / .rowCounts` | `SchemaInspector` |
| `query.execute / .executeRaw / .preview` | `QueryBuilder` |
| `query.parseFromSQL` | `QueryParser` |
| `context.save / .load / .list / .delete / .rename / .update` | `ContextManager` |
| `about.read` | `AboutManager` |

---

## Frontend — `assets/js/`

| File | Purpose |
|------|---------|
| `api.js` | Thin fetch wrapper for all `api.php` calls |
| `app.js` | Application bootstrap and event wiring |
| `config.js` | Central state object; serialises canvas state to SQL parameters |
| `canvas.js` | Table card rendering, drag-and-drop, column selection |
| `joins.js` | Draws JOIN connector lines between table cards |
| `islands.js` | Detects disconnected table groups ("islands") and warns before execution |
| `profiles.js` | Connection profile modal UI |
| `results.js` | Renders query result table with sorting and export |
| `autocomplete.js` | Column/table name autocomplete for raw input fields |
| `sql-backdrop.js` | Syntax-highlighted backdrop behind the raw SQL textarea |
| `undo.js` | Canvas undo/redo via state snapshots |
| `textarea-undo.js` | Undo/redo for plain textarea fields |

---

## Storage — `storage/`

| Path | Contents |
|------|---------|
| `storage/profiles.json` | Saved database connection profiles (including passwords — protected by `.htaccess`) |
| `storage/contexts/` | One JSON file per saved canvas context |

---

## Utilities — `cmd/`

| File | Purpose |
|------|---------|
| `cmd/fetch_all_raw_queries.php` | CLI tool — scans a directory of context JSON files and prints all `raw_query` values |
