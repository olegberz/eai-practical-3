## Architecture Rationale

The orchestration service is built using the **Synchronous Saga Pattern** with state persistence to ensure reliability and consistency across distributed services.

### Core Principles:
1. **Sequential Execution**: Steps are strictly ordered: `payment` -> `inventory` -> `shipping` -> `notification`. If any step fails, the flow stops immediately to prevent inconsistent states.
2. **Deterministic Idempotency**: 
   - Uses a persistent store (`idempotency-store.json`) to map `Idempotency-Key` to request hashes and terminal responses.
   - Handles `idempotency_conflict` (409) for concurrent requests and `idempotency_payload_mismatch` (409) if the body changes for the same key.
3. **Advanced Compensation Logic**:
   - Implements backward recovery. For example, if `shipping` fails, the orchestrator triggers `inventory_release` and then `payment_refund`.
   - Any failure during a compensation step results in a `compensation_failed` error code (422) as per business requirements.
4. **Timeout Control**: Each downstream request is protected by an Axios timeout. If a service is slow, the orchestrator triggers compensation and returns a `504 Gateway Timeout` with the `timeout` machine code.
5. **Restart-Safe Persistence**: Every state change (including the initial "in_progress" lock) is flushed to disk immediately. This ensures that the system can recover or maintain idempotency even after a container crash or restart.
