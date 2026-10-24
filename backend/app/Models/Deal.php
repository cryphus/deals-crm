<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Deal extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['amount' => 'decimal:2', 'external_version' => 'integer', 'external_updated_at' => 'datetime'];
    }

    public function latestSyncOperation(): HasOne
    {
        // sequence is globally unique. A correlated maximum avoids Laravel's
        // implicit MAX(uuid) tie-breaker, which PostgreSQL does not support.
        return $this->hasOne(Operation::class)->where('kind', 'sync')->whereRaw(
            'sequence = (SELECT MAX(latest.sequence) FROM operations AS latest WHERE latest.deal_id = operations.deal_id AND latest.kind = ?)',
            ['sync']
        );
    }
}
