<?php

namespace App\Services;

use App\Jobs\ProcessOperation;
use App\Models\Operation;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class Inbox
{
    public function receiveWebhook(array $payload): Operation
    {
        // UNIQUE(event_id), insert-on-conflict: parallel deliveries share one durable row.
        $id = (string) Str::uuid();
        DB::table('operations')->insertOrIgnore([
            'id' => $id, 'kind' => 'webhook', 'event_id' => $payload['event_id'],
            'external_id' => $payload['deal']['id'], 'payload' => json_encode($payload, JSON_THROW_ON_ERROR),
            'status' => 'received', 'attempts' => 0, 'available_at' => now(),
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $operation = Operation::where('event_id', $payload['event_id'])->firstOrFail();

        return $operation->fresh();
    }

    public function enqueue(string $id): bool
    {
        // A lost Redis push is repaired after this short dispatch lease expires.
        $reserved = Operation::whereKey($id)->where(function ($query) {
            $query->where(fn ($q) => $q->where('status', 'received')->where('available_at', '<=', now()))
                ->orWhere(fn ($q) => $q->where('status', 'processing')->where('lease_until', '<=', now()));
        })->where(fn ($q) => $q->whereNull('queued_at')->orWhere('queued_at', '<=', now()->subSeconds(config('crm.redispatch_seconds'))))
            ->update(['queued_at' => now()]);
        if (! $reserved) {
            return false;
        }
        try {
            ProcessOperation::dispatch($id)->onConnection('redis');
        } catch (\Throwable) {
            // No payload, headers, token or raw exception is written to logs.
            Log::warning('Inbox queue unavailable; durable dispatcher will recover.', ['operation_id' => $id]);
        }

        return true;
    }

    public function dispatchPending(): int
    {
        $count = 0;
        Operation::where(function ($query) {
            $query->where(fn ($q) => $q->where('status', 'received')->where('available_at', '<=', now()))
                ->orWhere(fn ($q) => $q->where('status', 'processing')->where('lease_until', '<=', now()));
        })->where(fn ($q) => $q->whereNull('queued_at')->orWhere('queued_at', '<=', now()->subSeconds(config('crm.redispatch_seconds'))))
            ->orderBy('created_at')->limit(100)->pluck('id')->each(function ($id) use (&$count) {
                $count += (int) $this->enqueue($id);
            });

        return $count;
    }
}
