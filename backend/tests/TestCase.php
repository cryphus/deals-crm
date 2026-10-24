<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    public function createApplication()
    {
        $app = parent::createApplication();
        $connection = $app['config']->get('database.default');
        // This runs before RefreshDatabase can execute any destructive SQL.
        if ($connection !== 'pgsql') {
            throw new \RuntimeException('Refusing database tests: expected the pgsql connection.');
        }
        DatabaseSafety::assertIsolated($app['config']->get('database.connections.'.$connection));

        return $app;
    }
}
