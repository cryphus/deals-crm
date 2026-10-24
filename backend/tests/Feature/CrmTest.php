<?php

namespace Tests\Feature;

use App\Jobs\ProcessOperation;
use App\Models\Deal;
use App\Models\Operation;
use App\Services\Inbox;
use App\Services\OperationProcessor;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class CrmTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(now()->startOfSecond());
        Queue::fake();
        config(['crm.webhook_token' => 'test-token']);
        Http::preventStrayRequests();
    }

    protected function tearDown(): void
    {
        $this->travelBack();
        parent::tearDown();
    }

    private function payload(int $version = 18, string $eventId = 'evt-1', string $title = 'External title'): array
    {
        return ['event_id' => $eventId, 'event_time' => '2026-10-15T15:30:00Z', 'deal' => [
            'id' => '5678', 'version' => $version, 'updated_at' => '2026-10-15T15:29:50Z',
            'title' => $title, 'status' => 'NEW', 'amount' => 49000,
        ]];
    }

    private function webhook(array $payload): string
    {
        return $this->postJson('/api/webhooks/deals', $payload, ['X-Webhook-Token' => 'test-token'])
            ->assertAccepted()->json('data.id');
    }

    private function process(string $id): void
    {
        app(OperationProcessor::class)->process($id);
    }

    private function sync(Deal $deal): string
    {
        return $this->postJson('/api/deals/'.$deal->id.'/sync', ['mode' => 'success'])
            ->assertAccepted()->json('data.id');
    }

    public function test_duplicate_event_is_applied_only_once(): void
    {
        $id = $this->webhook($this->payload());
        $duplicate = $this->webhook($this->payload(19, 'evt-1', 'Duplicate changed payload'));
        $this->assertSame($id, $duplicate);
        Queue::assertNothingPushed();
        app(Inbox::class)->dispatchPending();
        app(Inbox::class)->dispatchPending();
        $this->process($id);
        $this->process($duplicate);
        $this->assertDatabaseCount('operations', 1);
        $this->assertDatabaseCount('deals', 1);
        $this->assertDatabaseHas('deals', ['external_id' => '5678', 'external_version' => 18, 'title' => 'External title']);
        $this->assertSame(1, Operation::findOrFail($id)->attempts);
        Queue::assertPushed(ProcessOperation::class, 1);
    }

    public function test_stale_webhook_and_get_cannot_overwrite_a_newer_webhook(): void
    {
        $newId = $this->webhook($this->payload(25, 'new', 'Newest version'));
        $this->process($newId);
        $oldId = $this->webhook($this->payload(17, 'old'));
        $this->process($oldId);
        $this->assertSame('ignored_stale', Operation::findOrFail($oldId)->outcome);
        $deal = Deal::firstOrFail();
        $syncId = $this->sync($deal);
        Http::fake(['*' => Http::response($this->payload(20)['deal'])]);
        $this->process($syncId);
        $this->assertSame('ignored_stale', Operation::findOrFail($syncId)->outcome);
        $this->assertSame('Newest version', $deal->fresh()->title);
        $this->assertSame(25, $deal->fresh()->external_version);
    }

    public function test_429_429_200_recovers_with_bounded_backoff(): void
    {
        $deal = Deal::create(['external_id' => '5678', 'title' => 'Local', 'status' => 'NEW', 'amount' => 1]);
        $id = $this->sync($deal);
        Http::fake(['*' => Http::sequence()->push([], 429)->push([], 429)->push($this->payload(20)['deal'], 200)]);
        $this->process($id);
        $this->assertDatabaseHas('operations', ['id' => $id, 'status' => 'received', 'attempts' => 1]);
        $this->assertEqualsWithDelta(2, now()->diffInSeconds(Operation::findOrFail($id)->available_at), 0.2);
        $this->process($id); // Not yet due: must not consume another HTTP attempt.
        Http::assertSentCount(1);
        $this->travel(2)->seconds();
        $this->process($id);
        $this->assertEqualsWithDelta(5, now()->diffInSeconds(Operation::findOrFail($id)->available_at), 0.2);
        $this->travel(5)->seconds();
        $this->process($id);
        $this->assertDatabaseHas('operations', ['id' => $id, 'status' => 'succeeded', 'attempts' => 3, 'outcome' => 'applied']);
        Http::assertSentCount(3);
    }

    public function test_get_started_before_webhook_and_local_edit_cannot_undo_them(): void
    {
        $this->process($this->webhook($this->payload(18, 'initial')));
        $deal = Deal::firstOrFail();
        $syncId = $this->sync($deal);
        Http::fake(function () use ($deal) {
            // This callback runs after the GET has started but before its response.
            $this->process($this->webhook($this->payload(25, 'arrives-during-get', 'New webhook')));
            $this->patchJson('/api/deals/'.$deal->id, ['title' => 'Manager after webhook'])->assertOk();

            return Http::response($this->payload(20)['deal']);
        });
        $this->process($syncId);
        $this->assertDatabaseHas('operations', ['id' => $syncId, 'status' => 'succeeded', 'outcome' => 'ignored_stale']);
        $this->assertSame(25, $deal->fresh()->external_version);
        $this->assertSame('Manager after webhook', $deal->fresh()->title);
    }

    public function test_persistent_500_finishes_failed_after_four_attempts(): void
    {
        $deal = Deal::create(['external_id' => '5678', 'title' => 'Local', 'status' => 'NEW', 'amount' => 1]);
        $id = $this->sync($deal);
        Http::fake(['*' => Http::response([], 500)]);
        foreach ([0, 2, 5, 10] as $seconds) {
            $this->travel($seconds)->seconds();
            $this->process($id);
        }
        $this->process($id);
        $this->assertDatabaseHas('operations', ['id' => $id, 'status' => 'failed', 'attempts' => 4, 'error' => 'External API HTTP 500']);
        Http::assertSentCount(4);
        $this->assertSame('Local', $deal->fresh()->title);
    }

    public function test_local_edits_survive_equal_version_then_new_external_version_wins(): void
    {
        $this->process($this->webhook($this->payload()));
        $deal = Deal::firstOrFail();
        $this->patchJson('/api/deals/'.$deal->id, ['title' => 'Manager edit', 'status' => 'WON', 'amount' => 70000])->assertOk();
        $equal = $this->webhook($this->payload(18, 'equal', 'Conflicting source'));
        $this->process($equal);
        $this->assertSame('ignored_equal_version_conflict', Operation::findOrFail($equal)->outcome);
        $this->assertSame('Manager edit', $deal->fresh()->title);
        $this->process($this->webhook($this->payload(19, 'newer', 'New authoritative version')));
        $this->assertSame('New authoritative version', $deal->fresh()->title);
        $this->assertSame('NEW', $deal->fresh()->status);
        Http::assertNothingSent();
    }

    public function test_token_and_strict_payload_validation(): void
    {
        $this->postJson('/api/webhooks/deals', $this->payload())->assertUnauthorized();
        $payload = $this->payload();
        $payload['deal']['version'] = '18';
        $this->postJson('/api/webhooks/deals', $payload, ['X-Webhook-Token' => 'test-token'])->assertUnprocessable();
        $this->assertDatabaseCount('operations', 0);
    }

    public function test_dispatcher_recovers_lost_queue_and_expired_worker_lease(): void
    {
        $id = $this->webhook($this->payload());
        Queue::assertNothingPushed();
        app(Inbox::class)->dispatchPending();
        Queue::assertPushed(ProcessOperation::class, 1);
        $this->travel(16)->seconds();
        app(Inbox::class)->dispatchPending();
        Queue::assertPushed(ProcessOperation::class, 2);
        Operation::findOrFail($id)->update(['status' => 'processing', 'attempts' => 1, 'lease_token' => fake()->uuid(), 'lease_until' => now()->subSecond()]);
        $this->travel(16)->seconds();
        app(Inbox::class)->dispatchPending();
        Queue::assertPushed(ProcessOperation::class, 3);
        $this->process($id);
        $this->assertDatabaseHas('operations', ['id' => $id, 'status' => 'succeeded', 'attempts' => 2]);
    }

    public function test_deals_crud_search_filter_and_latest_operation(): void
    {
        $id = $this->postJson('/api/deals', ['title' => 'Learning course', 'status' => 'NEW', 'amount' => 15])->assertCreated()->json('data.id');
        $deal = Deal::findOrFail($id);
        $this->assertStringStartsWith('manual-', $deal->external_id);
        $operation = $this->sync($deal);
        $this->getJson('/api/deals?q=learning&status=NEW')->assertOk()->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.latest_sync_operation.id', $operation);
        $this->getJson('/api/deals/'.$id)->assertOk()->assertJsonPath('data.id', $id);
        $this->getJson('/api/events')->assertOk()->assertJsonPath('total', 1);
    }

    public function test_search_zero_filters_records_instead_of_returning_everything(): void
    {
        Deal::create(['external_id' => 'zero', 'title' => '0', 'status' => 'NEW', 'amount' => 0]);
        Deal::create(['external_id' => 'other', 'title' => 'Unrelated', 'status' => 'NEW', 'amount' => 1]);

        $this->getJson('/api/deals?q=0')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.title', '0');
    }

    public function test_external_timestamp_preserves_the_instant_across_timezones(): void
    {
        $payload = $this->payload();
        $payload['deal']['updated_at'] = '2026-10-15T18:29:50+03:00';
        $this->process($this->webhook($payload));

        $this->assertSame('2026-10-15T15:29:50+00:00', Deal::firstOrFail()->external_updated_at->toIso8601String());
    }

    public function test_invalid_resource_identifiers_return_not_found_without_sql_errors(): void
    {
        $oversized = '99999999999999999999999999999999999';
        $this->getJson('/api/deals/'.$oversized)->assertNotFound();
        $this->patchJson('/api/deals/'.$oversized, ['title' => 'Unused'])->assertNotFound();
        $this->postJson('/api/deals/'.$oversized.'/sync')->assertNotFound();
        $this->getJson('/api/deals/9223372036854775807')->assertNotFound();
        $this->getJson('/api/operations/not-a-uuid')->assertNotFound();
    }

    public function test_null_bytes_are_rejected_without_truncation_or_sql_errors(): void
    {
        $this->postJson('/api/deals', ['title' => "Bad\0title", 'status' => 'NEW', 'amount' => 0])->assertUnprocessable();
        $deal = Deal::create(['external_id' => 'null-guard', 'title' => 'Unchanged', 'status' => 'NEW', 'amount' => 0]);
        $this->patchJson('/api/deals/'.$deal->id, ['title' => "Bad\0title"])->assertUnprocessable();
        $this->getJson('/api/deals?q=bad%00query')->assertUnprocessable();
        foreach (['event_id', 'deal.title'] as $field) {
            $payload = $this->payload();
            data_set($payload, $field, "Bad\0value");
            $this->postJson('/api/webhooks/deals', $payload, ['X-Webhook-Token' => 'test-token'])->assertUnprocessable();
        }
        $this->assertSame('Unchanged', $deal->fresh()->title);
        $this->assertDatabaseCount('operations', 0);
        $payload = $this->payload();
        $payload['deal']['extra'] = ["bad\0key" => "bad\0value"];
        $id = $this->webhook($payload);
        $this->assertArrayNotHasKey('extra', Operation::findOrFail($id)->payload['deal']);
        $this->process($id);
        $this->assertSame('succeeded', Operation::findOrFail($id)->status);
    }

    public function test_dispatcher_does_not_hide_due_work_behind_reserved_batch(): void
    {
        for ($i = 0; $i < 100; $i++) {
            Operation::create(['kind' => 'sync', 'external_id' => 'reserved-'.$i, 'payload' => [],
                'status' => 'received', 'available_at' => now()->subMinute(), 'queued_at' => now(), 'created_at' => now()->subMinute()]);
        }
        $due = Operation::create(['kind' => 'sync', 'external_id' => 'due', 'payload' => [], 'status' => 'received', 'available_at' => now()]);
        $this->assertSame(1, app(Inbox::class)->dispatchPending());
        Queue::assertPushed(ProcessOperation::class, fn ($job) => $job->operationId === $due->id);
        Queue::assertPushed(ProcessOperation::class, 1);
    }

    public function test_latest_sync_relation_ignores_newer_webhooks_and_returns_one_row_per_deal(): void
    {
        $deal = Deal::create(['external_id' => 'history', 'title' => 'History', 'status' => 'NEW', 'amount' => 0]);
        $this->sync($deal);
        $latest = $this->sync($deal);
        Operation::create(['kind' => 'webhook', 'deal_id' => $deal->id, 'external_id' => $deal->external_id,
            'payload' => [], 'status' => 'succeeded', 'available_at' => now()]);
        $this->getJson('/api/deals')->assertOk()->assertJsonPath('data.0.latest_sync_operation.id', $latest);
        $this->assertCount(1, $deal->latestSyncOperation()->get());
    }
}
