<?php

namespace App\Http\Controllers;

use App\Models\Deal;
use App\Models\Operation;
use App\Services\ExternalDeal;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class DealController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $input = $request->validate(['q' => ['nullable', 'string', 'max:255', 'not_regex:/\x00/'], 'status' => ['nullable', Rule::in(ExternalDeal::STATUSES)], 'page' => ['sometimes', 'integer', 'min:1']]);
        $query = Deal::with('latestSyncOperation')->orderByDesc('id');
        if (isset($input['q']) && $input['q'] !== '') {
            $term = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $input['q']).'%';
            $query->where(fn ($q) => $q->where('title', 'ilike', $term)->orWhere('external_id', 'ilike', $term));
        }
        if ($input['status'] ?? null) {
            $query->where('status', $input['status']);
        }

        return response()->json($query->paginate(10));
    }

    public function show(Deal $deal): JsonResponse
    {
        return response()->json(['data' => $deal->load('latestSyncOperation')]);
    }

    public function store(Request $request): JsonResponse
    {
        $input = $request->validate($this->rules(true));
        $input['external_id'] ??= 'manual-'.Str::uuid();
        $deal = DB::transaction(function () use ($input) {
            ExternalDeal::lock($input['external_id']);
            abort_if(Deal::where('external_id', $input['external_id'])->exists(), 422, 'External ID already exists.');

            return Deal::create($input);
        });

        return response()->json(['data' => $deal], 201);
    }

    public function update(Request $request, Deal $deal): JsonResponse
    {
        $input = $request->validate($this->rules(false));
        DB::transaction(function () use ($deal, $input) {
            ExternalDeal::lock($deal->external_id);
            Deal::whereKey($deal->id)->lockForUpdate()->firstOrFail()->fill($input)->save();
        });

        return response()->json(['data' => $deal->fresh()->load('latestSyncOperation')]);
    }

    public function sync(Request $request, Deal $deal): JsonResponse
    {
        $input = $request->validate(['mode' => ['sometimes', Rule::in(['success', 'rate_limit', 'error'])], 'version' => ['sometimes', 'integer', 'min:1', 'max:9007199254740991']]);
        $operation = Operation::create([
            'kind' => 'sync', 'deal_id' => $deal->id, 'external_id' => $deal->external_id,
            'payload' => ['mode' => $input['mode'] ?? 'success', 'version' => (int) ($input['version'] ?? 20)],
            'status' => 'received', 'available_at' => now(),
        ]);

        return response()->json(['data' => $operation->fresh()], 202);
    }

    private function rules(bool $creating): array
    {
        $presence = $creating ? 'required' : 'sometimes';
        $rules = [
            'title' => [$presence, 'string', 'max:255', 'not_regex:/\x00/'],
            'status' => [$presence, Rule::in(ExternalDeal::STATUSES)],
            'amount' => [$presence, 'numeric', 'min:0', 'max:999999999999.99', 'decimal:0,2'],
        ];
        if ($creating) {
            $rules['external_id'] = ['sometimes', 'string', 'max:120', 'regex:/^[a-zA-Z0-9_-]+$/'];
        }

        return $rules;
    }
}
