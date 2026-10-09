<?php
/**
 * shell.php — tab shell. Served by index.php when no ?tab= is given.
 * A tab bar plus one iframe per tab; each iframe is a full, independent
 * copy of the app (index.php?tab=<id>). See assets/js/shell.js.
 */
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= APP_NAME ?> <?= APP_VERSION ?></title>
    <link rel="stylesheet" href="assets/css/app.css">
    <link rel="stylesheet" href="assets/css/shell.css">
    <link rel="icon" type="image/png" href="assets/img/logo.png">
</head>
<body>
    <div id="tabbar" role="tablist" aria-label="Tabs">
        <div id="tabs"></div>
        <button id="tab-new" type="button" title="New tab (Ctrl+Alt+T)">+</button>
        <button id="tab-reopen" type="button" title="Reopen closed tab (Ctrl+Alt+Shift+T)" disabled>↺</button>
    </div>
    <div id="tab-frames"></div>
    <ul id="tab-menu" class="hidden" role="menu"></ul>
    <script src="assets/js/shell.js"></script>
</body>
</html>
