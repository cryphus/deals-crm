<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class Operation extends Model
{
    use HasUuids;

    protected $guarded = [];

    protected $hidden = ['payload', 'sequence', 'lease_token', 'lease_until', 'queued_at', 'available_at'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'attempts' => 'integer', 'available_at' => 'datetime', 'queued_at' => 'datetime', 'lease_until' => 'datetime'];
    }
}
