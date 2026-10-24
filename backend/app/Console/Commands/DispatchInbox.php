<?php

namespace App\Console\Commands;

use App\Services\Inbox;
use Illuminate\Console\Command;

class DispatchInbox extends Command
{
    protected $signature = 'inbox:dispatch {--loop : Continuously recover durable pending operations}';

    protected $description = 'Dispatch received operations and recover expired worker leases';

    public function handle(Inbox $inbox): int
    {
        do {
            try {
                $count = $inbox->dispatchPending();
                if ($count) {
                    $this->info('Dispatched '.$count.' durable operations.');
                }
            } catch (\Throwable) {
                $this->warn('Dispatcher temporarily unavailable; retrying.');
                if (! $this->option('loop')) {
                    return self::FAILURE;
                }
            }
            if ($this->option('loop')) {
                sleep(2);
            }
        } while ($this->option('loop'));

        return self::SUCCESS;
    }
}
