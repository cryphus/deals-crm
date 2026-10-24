<?php

namespace Database\Seeders;

use App\Models\Deal;
use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    use WithoutModelEvents;

    /**
     * Seed the application's database.
     */
    public function run(): void
    {
        foreach ([
            ['5678', 'Продажа курса', 'NEW', 49000],
            ['1002', 'Английский для начинающих', 'IN_PROGRESS', 32000],
            ['1003', 'Подготовка к экзаменам', 'WON', 65000],
        ] as [$externalId, $title, $status, $amount]) {
            Deal::firstOrCreate(['external_id' => $externalId], compact('title', 'status', 'amount'));
        }
    }
}
