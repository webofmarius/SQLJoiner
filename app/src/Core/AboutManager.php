<?php

declare(strict_types=1);

namespace Core;

use Core\Request;
use Core\Response;

class AboutManager
{
    public function read(Request $request): void
    {
        $file = __DIR__ . '/../../about.php';

        if (!file_exists($file)) {
            Response::success(['content' => '']);
            return;
        }

        ob_start();
        require $file;
        $content = ob_get_clean();
        Response::success(['content' => $content !== false ? $content : '']);
    }
}
