<?php

namespace App\Http\Controllers;

use App\Services\ExternalDeal;
use App\Services\Inbox;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;

class WebhookController extends Controller
{
    public function __invoke(Request $request, Inbox $inbox): JsonResponse
    {
        $expected = (string) config('crm.webhook_token');
        abort_unless($expected !== '' && hash_equals($expected, (string) $request->header('X-Webhook-Token')), 401, 'Invalid webhook token.');
        $input = $request->validate(array_merge([
            'event_id' => ['required', 'string', 'max:120', 'not_regex:/\x00/'],
            'event_time' => ['required', 'string', 'date'],
            'deal' => ['required', 'array'],
        ], ExternalDeal::rules('deal.')));
        // Laravel's array validation can retain unvalidated nested keys. Persist
        // only our contract, including when an extra field is invalid for jsonb.
        $input['deal'] = Arr::only($input['deal'], ['id', 'version', 'updated_at', 'title', 'status', 'amount']);

        // Only PostgreSQL is needed for acceptance; the dispatcher handles Redis later.
        return response()->json(['data' => $inbox->receiveWebhook($input)], 202);
    }
}
