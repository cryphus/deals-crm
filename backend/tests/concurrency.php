<?php

declare(strict_types=1);

use App\Models\Deal;
use App\Models\Operation;
use App\Services\Inbox;
use App\Services\OperationProcessor;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Foundation\Bootstrap\LoadConfiguration;
use Illuminate\Support\Facades\DB;
use Tests\DatabaseSafety;

require __DIR__.'/../vendor/autoload.php';
require_once __DIR__.'/DatabaseSafety.php';

/** Fail explicitly even when PHP assertions are disabled. */
function check(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

function sendMessage($socket, array $message): void
{
    $line = json_encode($message, JSON_THROW_ON_ERROR)."\n";
    check(fwrite($socket, $line) === strlen($line), 'Unable to write worker message.');
}

function readMessage($socket): array
{
    $line = fgets($socket);
    check($line !== false, 'Worker closed its channel or timed out.');

    return json_decode($line, true, flags: JSON_THROW_ON_ERROR);
}

/** Each worker opens its own PDO, then waits until every PostgreSQL session is ready. */
function race(int $count, Closure $work): array
{
    // Never fork a live PDO: even closing an inherited socket can break the parent.
    DB::purge();
    $workers = [];
    $results = [];
    try {
        for ($index = 0; $index < $count; $index++) {
            $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
            check($pair !== false, 'Unable to create worker barrier.');
            $pid = pcntl_fork();
            if ($pid === -1) {
                fclose($pair[0]);
                fclose($pair[1]);
                throw new RuntimeException('Unable to fork worker.');
            }
            if ($pid === 0) {
                fclose($pair[0]);
                foreach ($workers as $worker) {
                    fclose($worker['socket']);
                }
                stream_set_timeout($pair[1], 30);
                $exitCode = 0;
                try {
                    DB::purge();
                    DB::statement("SET statement_timeout = '20s'");
                    DB::statement("SET lock_timeout = '15s'");
                    $identity = DB::selectOne('SELECT pg_backend_pid() AS pid, current_database() AS database');
                    check($identity->database === 'crm_test', 'Worker connected to an unexpected database.');
                    sendMessage($pair[1], ['ready' => true, 'backend_pid' => (int) $identity->pid]);
                    check(fread($pair[1], 1) === 'G', 'Worker barrier was not released.');
                    sendMessage($pair[1], ['ok' => true, 'result' => $work($index)]);
                } catch (Throwable $error) {
                    $exitCode = 1;
                    fwrite(STDERR, 'Worker '.$index.': '.$error->getMessage()."\n");
                    try {
                        sendMessage($pair[1], ['ok' => false, 'error' => $error->getMessage()]);
                    } catch (Throwable) {
                        // Parent also checks the exit status if the channel is broken.
                    }
                } finally {
                    DB::disconnect();
                    fclose($pair[1]);
                }
                exit($exitCode);
            }
            fclose($pair[1]);
            stream_set_timeout($pair[0], 30);
            $workers[$pid] = ['socket' => $pair[0], 'reaped' => false];
        }

        $backendPids = [];
        foreach ($workers as $worker) {
            $ready = readMessage($worker['socket']);
            check(($ready['ready'] ?? false) === true, 'Worker failed before the barrier: '.($ready['error'] ?? 'unknown error'));
            $backendPids[] = $ready['backend_pid'];
        }
        check(count(array_unique($backendPids)) === $count, 'Workers must use independent PostgreSQL sessions.');
        foreach ($workers as $worker) {
            check(fwrite($worker['socket'], 'G') === 1, 'Unable to release worker barrier.');
        }
        foreach ($workers as $pid => $worker) {
            $result = readMessage($worker['socket']);
            check(($result['ok'] ?? false) === true, 'Worker failed: '.($result['error'] ?? 'unknown error'));
            $results[] = $result['result'];
        }

        // A successful message is insufficient: a crash during shutdown must fail too.
        $deadline = microtime(true) + 30;
        foreach (array_keys($workers) as $pid) {
            do {
                $waited = pcntl_waitpid($pid, $status, WNOHANG);
                check($waited !== -1, 'Unable to wait for worker '.$pid.'.');
                if ($waited === 0) {
                    check(microtime(true) < $deadline, 'Worker did not exit before the deadline.');
                    usleep(10000);
                }
            } while ($waited === 0);
            $workers[$pid]['reaped'] = true;
            check(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, 'Worker '.$pid.' exited unsuccessfully.');
        }
    } finally {
        // Stop and reap all writers before the caller removes its fixture rows.
        foreach ($workers as $pid => $worker) {
            if (! $worker['reaped']) {
                posix_kill($pid, SIGKILL);
                pcntl_waitpid($pid, $status);
            }
            fclose($worker['socket']);
        }
    }

    return $results;
}

function payload(string $eventId, string $externalId, int $version): array
{
    return [
        'event_id' => $eventId,
        'event_time' => '2026-10-15T15:30:00Z',
        'deal' => [
            'id' => $externalId, 'version' => $version,
            'updated_at' => '2026-10-15T15:29:50Z',
            'title' => 'Concurrent version '.$version,
            'status' => 'NEW', 'amount' => $version,
        ],
    ];
}

$exitCode = 0;
$safeToClean = false;
$externalIds = [];
try {
    foreach (['pcntl_fork', 'pcntl_waitpid', 'posix_kill', 'stream_socket_pair'] as $function) {
        check(function_exists($function), 'The concurrency regression requires '.$function.'.');
    }
    $app = require __DIR__.'/../bootstrap/app.php';
    // Guard immediately after configuration loads, before any service provider can connect.
    $app->afterBootstrapping(LoadConfiguration::class, function ($app): void {
        $connection = $app['config']->get('database.default');
        check($connection === 'pgsql', 'Refusing database tests: expected the pgsql connection.');
        DatabaseSafety::assertIsolated($app['config']->get('database.connections.'.$connection));
    });
    $app->make(Kernel::class)->bootstrap();
    check(DB::selectOne('SELECT current_database() AS database')->database === 'crm_test', 'Unexpected PostgreSQL database.');
    $safeToClean = true;
    $fixture = 'concurrency_'.bin2hex(random_bytes(16));
    $externalIds = [$fixture.'_inbox', $fixture.'_versions'];
    $eventId = $fixture.'_duplicate';

    $operationIds = race(8, fn () => app(Inbox::class)->receiveWebhook(payload($eventId, $externalIds[0], 1))->id);
    check(count(array_unique($operationIds)) === 1, 'Eight duplicate deliveries returned different operation IDs.');
    check(Operation::where('event_id', $eventId)->count() === 1, 'Eight duplicate deliveries must create exactly one inbox row.');
    check(Operation::where('external_id', $externalIds[0])->count() === 1, 'Unexpected inbox rows for the duplicate fixture.');
    fwrite(STDOUT, "PASS: 8 concurrent duplicate deliveries create one inbox row and return the same ID.\n");

    $versionOperations = [];
    for ($version = 1; $version <= 12; $version++) {
        $versionOperations[] = app(Inbox::class)->receiveWebhook(payload($fixture.'_v'.$version, $externalIds[1], $version))->id;
    }
    check(! Deal::where('external_id', $externalIds[1])->exists(), 'Version race requires an initially absent deal.');
    race(12, function (int $index) use ($versionOperations): string {
        $id = $versionOperations[$index];
        app(OperationProcessor::class)->process($id);
        $operation = Operation::findOrFail($id);
        check($operation->status === 'succeeded' && $operation->attempts === 1, 'Version worker did not succeed on its first attempt: '.$id);

        return $id;
    });
    check(Deal::where('external_id', $externalIds[1])->count() === 1, 'Twelve versions must create exactly one deal.');
    $deal = Deal::where('external_id', $externalIds[1])->firstOrFail();
    check($deal->external_version === 12 && $deal->title === 'Concurrent version 12' && $deal->amount === '12.00', 'The maximum version and its fields must win.');
    check(Operation::whereIn('id', $versionOperations)->where('status', 'succeeded')->where('deal_id', $deal->id)->count() === 12, 'All twelve operations must succeed and reference the same deal.');
    fwrite(STDOUT, "PASS: 12 concurrent versions of an absent deal create one row with version 12.\n");
} catch (Throwable $error) {
    $exitCode = 1;
    fwrite(STDERR, 'FAIL: '.$error->getMessage()."\n");
} finally {
    if ($safeToClean && $externalIds !== []) {
        try {
            DB::transaction(function () use ($externalIds): void {
                Operation::whereIn('external_id', $externalIds)->delete();
                Deal::whereIn('external_id', $externalIds)->delete();
            });
        } catch (Throwable $error) {
            $exitCode = 1;
            fwrite(STDERR, 'FAIL: fixture cleanup: '.$error->getMessage()."\n");
        }
    }
}

exit($exitCode);
