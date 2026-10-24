<?php

use App\Http\Controllers\DealController;
use App\Http\Controllers\WebhookController;
use App\Models\Deal;
use App\Models\Operation;
use Illuminate\Support\Facades\Route;

Route::bind('deal', function (string $value): Deal {
    // Reject values outside PHP/PostgreSQL bigint before implicit SQL binding.
    abort_if(filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false, 404);

    return Deal::findOrFail($value);
});

Route::get('/deals', [DealController::class, 'index']);
Route::post('/deals', [DealController::class, 'store']);
Route::get('/deals/{deal}', [DealController::class, 'show'])->whereNumber('deal');
Route::patch('/deals/{deal}', [DealController::class, 'update'])->whereNumber('deal');
Route::post('/deals/{deal}/sync', [DealController::class, 'sync'])->whereNumber('deal');
Route::get('/operations/{operation}', fn (Operation $operation) => ['data' => $operation])->whereUuid('operation');
Route::get('/events', fn () => Operation::orderByDesc('sequence')->paginate(20));
Route::post('/webhooks/deals', WebhookController::class);
