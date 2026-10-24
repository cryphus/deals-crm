<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('deals', function (Blueprint $table) {
            $table->id();
            $table->string('external_id', 120)->unique();
            $table->string('title');
            $table->string('status', 20);
            $table->decimal('amount', 14, 2);
            $table->timestampTz('external_updated_at')->nullable();
            $table->unsignedBigInteger('external_version')->default(0);
            $table->timestampsTz();
            $table->index(['status', 'id']);
        });
        Schema::create('operations', function (Blueprint $table) {
            $table->bigIncrements('sequence');
            $table->uuid('id')->unique();
            $table->string('kind', 20);
            $table->string('event_id', 120)->nullable()->unique();
            $table->foreignId('deal_id')->nullable()->constrained()->nullOnDelete();
            $table->string('external_id', 120)->index();
            $table->jsonb('payload');
            $table->string('status', 20)->default('received');
            $table->unsignedInteger('attempts')->default(0);
            $table->text('error')->nullable();
            $table->string('outcome')->nullable();
            $table->timestampTz('available_at');
            $table->timestampTz('queued_at')->nullable();
            $table->timestampTz('lease_until')->nullable();
            $table->uuid('lease_token')->nullable();
            $table->timestampsTz();
            $table->index(['status', 'available_at']);
            $table->index(['status', 'lease_until']);
            $table->index(['deal_id', 'kind', 'sequence']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('operations');
        Schema::dropIfExists('deals');
    }
};
