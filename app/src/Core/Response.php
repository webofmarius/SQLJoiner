<?php

declare(strict_types=1);

namespace Core;

/**
 * Standardised JSON response envelope.
 *
 * Every API response has the same shape:
 *   { "success": bool, "message": string, "data": mixed }
 *
 * Both methods call exit() so nothing leaks after the response.
 */
class Response
{
    public static function success(mixed $data = null, string $message = ''): void
    {
        self::emit([
            'success' => true,
            'message' => $message,
            'data'    => $data,
        ]);
    }

    public static function error(string $message, int $httpCode = 400): void
    {
        http_response_code($httpCode);
        self::emit([
            'success' => false,
            'message' => $message,
            'data'    => null,
        ]);
    }

    private static function emit(array $payload): void
    {
        header('Content-Type: application/json');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
