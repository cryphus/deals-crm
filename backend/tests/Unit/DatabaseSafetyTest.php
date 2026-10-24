<?php

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;
use RuntimeException;
use Tests\DatabaseSafety;

class DatabaseSafetyTest extends TestCase
{
    public function test_accepts_the_isolated_postgresql_database(): void
    {
        DatabaseSafety::assertIsolated(['driver' => 'pgsql', 'database' => 'crm_test']);
        $this->addToAssertionCount(1);
    }

    public function test_rejects_a_url_overriding_the_database_before_connecting(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'url' => 'postgresql://audit@invalid.example/deals_crm',
        ]);
    }

    public function test_rejects_a_url_overriding_the_driver(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'url' => 'mysql://audit@invalid.example/crm_test',
        ]);
    }

    public function test_rejects_a_separate_write_database(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'write' => ['database' => 'deals_crm'],
        ]);
    }

    public function test_rejects_a_production_write_replica_from_url_query_options(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'url' => 'postgresql://audit@invalid.example/crm_test?read[0][database]=crm_test&write[0][database]=deals_crm',
        ]);
    }

    public function test_checks_every_read_replica_instead_of_only_the_first(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'read' => [['database' => 'crm_test'], ['database' => 'deals_crm']],
        ]);
    }

    public function test_rejects_sparse_replica_lists_using_laravel_resolution_rules(): void
    {
        $this->expectException(RuntimeException::class);
        DatabaseSafety::assertIsolated([
            'driver' => 'pgsql', 'database' => 'crm_test',
            'url' => 'postgresql://audit@invalid.example/crm_test?read[0][database]=crm_test&write[0][database]=deals_crm&write[2][database]=deals_crm',
        ]);
    }
}
