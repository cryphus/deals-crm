<?php

return [
    'webhook_token' => env('WEBHOOK_TOKEN'),
    'mock_api_url' => env('MOCK_API_URL', 'http://mock:8000'),
    'max_attempts' => 4,
    'backoff' => [2, 5, 10],
    'lease_seconds' => 60,
    'redispatch_seconds' => 15,
];
