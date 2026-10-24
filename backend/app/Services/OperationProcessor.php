<?php

namespace App\Services;

use App\Models\Operation;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class OperationProcessor
{
    public function process(string $id): void
    {
        $operation = DB::transaction(function () use ($id) {
            $op = Operation::whereKey($id)->lockForUpdate()->first();
            if (! $op || in_array($op->status, ['succeeded', 'failed'])
                || ($op->status === 'processing' && $op->lease_until?->isFuture())
                || ($op->status === 'received' && $op->available_at->isFuture())) {
                return null;
            }
            if ($op->attempts >= config('crm.max_attempts')) {
                $op->update(['status' => 'failed', 'error' => 'Worker interrupted; attempt limit reached.', 'lease_token' => null, 'lease_until' => null]);

                return null;
            }
            $op->update([
                'status' => 'processing', 'attempts' => $op->attempts + 1, 'error' => null,
                'lease_token' => (string) Str::uuid(), 'lease_until' => now()->addSeconds(config('crm.lease_seconds')),
            ]);

            return $op;
        }, 3);
        if (! $operation) {
            return;
        }

        try {
            if ($operation->kind === 'webhook') {
                $data = $operation->payload['deal'];
            } else {
                $response = Http::acceptJson()->connectTimeout(3)->timeout(10)->get(
                    rtrim(config('crm.mock_api_url'), '/').'/mock-api/deals/'.rawurlencode($operation->external_id),
                    ['mode' => $operation->payload['mode'], 'version' => $operation->payload['version'], 'operation_id' => $operation->id]
                );
                if (! $response->successful()) {
                    $this->failAttempt($operation, 'External API HTTP '.$response->status(), $response->status() === 429 || $response->serverError());

                    return;
                }
                $data = $response->json();
                if (! is_array($data) || ($data['id'] ?? null) !== $operation->external_id) {
                    $this->failAttempt($operation, 'External API returned an invalid deal identity.', false);

                    return;
                }
            }
            DB::transaction(function () use ($operation, $data) {
                $current = Operation::whereKey($operation->id)->lockForUpdate()->firstOrFail();
                // Fencing token: a slow/abandoned worker cannot commit after another claim.
                if ($current->status !== 'processing' || $current->lease_token !== $operation->lease_token) {
                    return;
                }
                [$deal, $outcome] = app(ExternalDeal::class)->apply($data);
                $current->update([
                    'deal_id' => $deal->id, 'status' => 'succeeded', 'outcome' => $outcome, 'error' => null,
                    'lease_token' => null, 'lease_until' => null,
                ]);
            }, 3);
        } catch (ValidationException) {
            $this->failAttempt($operation, 'External payload failed schema validation.', false);
        } catch (\Throwable) {
            $this->failAttempt($operation, 'Temporary processing or connection failure.', true);
        }
    }

    private function failAttempt(Operation $operation, string $error, bool $retryable): void
    {
        $retry = $retryable && $operation->attempts < config('crm.max_attempts');
        Operation::whereKey($operation->id)->where('status', 'processing')->where('lease_token', $operation->lease_token)->update([
            'status' => $retry ? 'received' : 'failed', 'error' => $error,
            'available_at' => now()->addSeconds(config('crm.backoff')[min($operation->attempts - 1, 2)]),
            'queued_at' => null, 'lease_until' => null, 'lease_token' => null,
        ]);
        // The durable dispatcher schedules the next attempt when available_at arrives.
    }
}
