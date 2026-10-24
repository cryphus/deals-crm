<?php

namespace App\Jobs;

use App\Services\OperationProcessor;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class ProcessOperation implements ShouldQueue
{
    use Queueable;

    public int $tries = 4;

    public int $timeout = 30;

    public array $backoff = [2, 5, 10];

    public function __construct(public string $operationId) {}

    public function handle(OperationProcessor $processor): void
    {
        $processor->process($this->operationId);
    }
}
