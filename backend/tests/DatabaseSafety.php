<?php

namespace Tests;

use Illuminate\Support\ConfigurationUrlParser;
use RuntimeException;

final class DatabaseSafety
{
    public static function assertIsolated(array $configuration): void
    {
        // DB_URL can override the nominal database name without opening a PDO.
        $effective = (new ConfigurationUrlParser)->parseConfiguration($configuration);
        $base = array_diff_key($effective, array_flip(['read', 'write']));
        $connections = [$base];
        foreach (['read', 'write'] as $type) {
            if (isset($effective[$type])) {
                // Laravel supports either one override or a list of replicas.
                $overrides = $effective[$type];
                // Match ConnectionFactory: replica arrays may have sparse keys.
                $variants = isset($overrides[0]) ? $overrides : [$overrides];
                foreach ($variants as $variant) {
                    $connections[] = array_replace($base, $variant);
                }
            }
        }

        foreach ($connections as $connection) {
            if (($connection['driver'] ?? null) !== 'pgsql' || ($connection['database'] ?? null) !== 'crm_test') {
                throw new RuntimeException('Refusing database tests: every effective connection must use PostgreSQL crm_test.');
            }
        }
    }
}
