<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;
use Illuminate\Validation\Rule;

class MockDealController extends Controller
{
    public function __invoke(Request $request, string $externalId): JsonResponse
    {
        $input = $request->validate([
            'mode' => ['sometimes', Rule::in(['success', 'rate_limit', 'error'])],
            'operation_id' => ['sometimes', 'string', 'max:120'],
            'version' => ['sometimes', 'integer', 'min:1', 'max:9007199254740991'],
        ]);
        abort_unless(preg_match('/^[a-zA-Z0-9_-]{1,120}$/', $externalId), 422);
        $mode = $input['mode'] ?? 'success';
        if ($mode === 'error') {
            return response()->json(['message' => 'Deterministic mock server failure.'], 500);
        }
        if ($mode === 'rate_limit') {
            $key = 'mock-attempt:'.hash('sha256', $externalId.'|'.($input['operation_id'] ?? 'demo'));
            // One Lua operation makes counter creation and TTL atomic too.
            $attempt = Redis::eval("local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 86400) end; return n", 1, $key);
            if ($attempt <= 2) {
                return response()->json(['message' => 'Deterministic mock rate limit.', 'attempt' => $attempt], 429)->header('Retry-After', '2');
            }
        }

        return response()->json([
            'id' => $externalId, 'version' => (int) ($input['version'] ?? 20),
            'updated_at' => '2026-10-15T15:29:50Z', 'title' => 'Сделка из внешней CRM '.$externalId,
            'status' => 'IN_PROGRESS', 'amount' => 49000,
        ]);
    }
}
