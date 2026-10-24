<?php

use App\Http\Controllers\MockDealController;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => ['application' => 'Deals CRM API']);
Route::get('/mock-api/deals/{externalId}', MockDealController::class);
