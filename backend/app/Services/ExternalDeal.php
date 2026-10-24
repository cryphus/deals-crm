<?php

namespace App\Services;

use App\Models\Deal;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

class ExternalDeal
{
    public const STATUSES = ['NEW', 'IN_PROGRESS', 'WON', 'LOST'];

    public static function rules(string $prefix = ''): array
    {
        $strictInteger = fn ($attribute, $value, $fail) => is_int($value) ?: $fail('Must be a JSON integer.');
        $strictNumber = fn ($attribute, $value, $fail) => (is_int($value) || is_float($value)) ?: $fail('Must be a JSON number.');

        return [
            $prefix.'id' => ['required', 'string', 'max:120', 'regex:/^[a-zA-Z0-9_-]+$/'],
            $prefix.'version' => ['required', 'integer', 'min:1', 'max:9007199254740991', $strictInteger],
            $prefix.'updated_at' => ['required', 'string', 'date'],
            $prefix.'title' => ['required', 'string', 'max:255', 'not_regex:/\x00/'],
            $prefix.'status' => ['required', Rule::in(self::STATUSES)],
            $prefix.'amount' => ['required', 'numeric', 'min:0', 'max:999999999999.99', 'decimal:0,2', $strictNumber],
        ];
    }

    /** Caller holds a DB transaction. Advisory lock covers the missing-row case. */
    public static function lock(string $externalId): void
    {
        DB::select('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [$externalId]);
    }

    public function apply(array $data): array
    {
        $data = Validator::make($data, self::rules())->validate();
        self::lock($data['id']);
        $deal = Deal::where('external_id', $data['id'])->lockForUpdate()->first();
        if ($deal && $data['version'] <= $deal->external_version) {
            $different = $deal->title !== $data['title'] || $deal->status !== $data['status']
                || number_format((float) $deal->amount, 2, '.', '') !== number_format((float) $data['amount'], 2, '.', '');
            $outcome = $data['version'] < $deal->external_version ? 'ignored_stale' : ($different ? 'ignored_equal_version_conflict' : 'ignored_equal_version');

            return [$deal, $outcome];
        }
        $deal ??= new Deal(['external_id' => $data['id']]);
        $deal->fill([
            'title' => $data['title'], 'status' => $data['status'], 'amount' => $data['amount'],
            'external_version' => $data['version'], 'external_updated_at' => Carbon::parse($data['updated_at'])->utc(),
        ])->save();

        return [$deal, 'applied'];
    }
}
